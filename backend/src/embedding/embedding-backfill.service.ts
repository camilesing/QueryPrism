// EmbeddingBackfillService — fills embeddings for rows that were written
// while no embedding key was configured (their `embedding` Json column is
// SQL NULL). Covers data-training (knowledge), datasource / table (metadata)
// AND metric definitions (metric recall):
//
//   - startup run (non-blocking) + manual POST /embedding/backfill
//     + re-enable trigger from ParameterService (enabled / table_enabled /
//     metric.enabled flipping false→true re-fills).
//   - per-collection runtime gating: knowledge fills need
//     embedding.enabled, metadata fills need embedding.table_enabled, metric
//     fills need metric.enabled (the same switch that gates metric recall).
//   - batches of 32 with 3 attempts per batch; a failed batch stays NULL
//     (never marked complete) and the next run retries it.
//   - race protection: before write-back each row is re-read (still NULL)
//     and the UPDATE is conditional on the input columns being unchanged —
//     an edit that landed mid-flight (or a synchronous re-embed by the
//     upsert path) wins and the stale backfill write is skipped. The vector
//     upsert is idempotent, so concurrent instances may race harmlessly.
//   - metric rows are loaded only when `enabled`; the governance write hook
//     indexes a row when it is enabled (so a disabled row never pays for an
//     embedding call it cannot use).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { resolveEmbeddingConfig } from '../common/config/embedding-config';
import { EmbeddingService } from './embedding.service';
import { embedRowText, metricDefEmbedText } from './embed-text';
import type { VectorCollection } from '../vector/vector.service';
import { VectorService } from '../vector/vector.service';

/** Rows embedded per batch call. */
const BATCH_SIZE = 32;
/** Attempts per batch before the batch stays NULL for the next run. */
const ATTEMPTS = 3;

export interface BackfillCounts {
  dataTraining: number;
  datasource: number;
  table: number;
  metric: number;
}

/** One NULL-embedding row staged for a batch: the text to embed plus the
 *  input-column equality conditions the conditional write-back checks. */
interface PendingRow {
  id: number;
  text: string;
  match: Record<string, string | number | null>;
}

/** Per-collection adapter: load still-NULL rows (optionally narrowed to a
 *  batch's ids) and conditionally persist one vector. `write` accepts the
 *  caller's Prisma client so it can join the batch transaction. */
interface CollectionAdapter {
  load(ids?: number[]): Promise<PendingRow[]>;
  write(
    row: PendingRow,
    vector: number[],
    client?: Prisma.TransactionClient,
  ): Promise<number>;
}

@Injectable()
export class EmbeddingBackfillService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingBackfillService.name);
  /** Collections with a fill currently in flight (manual trigger + startup
   *  + parameter flip can overlap; the second caller skips). */
  private readonly running = new Set<VectorCollection>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly vector: VectorService,
  ) {}

  onModuleInit(): void {
    if (!this.embedding.available) {
      this.logger.log(
        'embedding unavailable — backfill skipped (recall stays ILIKE-only)',
      );
      return;
    }
    // Non-blocking: never delay app startup on the backfill.
    void this.run().catch((e) =>
      this.logger.error(
        `embedding backfill failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /** Fill every collection (startup + manual trigger). Each branch is gated
   *  by its own runtime switch so a disabled half stays untouched. */
  async run(): Promise<BackfillCounts> {
    if (!this.embedding.available)
      return {
        dataTraining: 0,
        datasource: 0,
        table: 0,
        metric: 0,
      };
    const cfg = await resolveEmbeddingConfig(this.prisma);
    const counts: BackfillCounts = {
      dataTraining: 0,
      datasource: 0,
      table: 0,
      metric: 0,
    };
    if (!cfg.enabled) {
      this.logger.log('embedding.enabled=false — knowledge backfill skipped');
    } else {
      counts.dataTraining = await this.fill('data_training');
    }
    if (!cfg.tableEnabled) {
      this.logger.log(
        'embedding.table_enabled=false — datasource/table backfill skipped',
      );
    } else {
      counts.datasource = await this.fill('datasource');
      counts.table = await this.fill('table');
    }
    if (!cfg.metricEnabled) {
      this.logger.log(
        'metric.enabled=false — metric-definition backfill skipped',
      );
    } else {
      counts.metric = await this.fill('metric_def');
    }
    this.logger.log(
      `backfill complete: ${counts.dataTraining} data-training, ` +
        `${counts.datasource} datasource, ${counts.table} table, ${counts.metric} metric rows processed`,
    );
    return counts;
  }

  /** Knowledge half only (data-training). ParameterService calls this when
   *  embedding.enabled flips false→true. */
  async runKnowledge(): Promise<void> {
    if (!this.embedding.available) return;
    const cfg = await resolveEmbeddingConfig(this.prisma);
    if (!cfg.enabled) return;
    await this.fill('data_training');
  }

  /** Metadata half only (datasource + table). ParameterService calls this
   *  when embedding.table_enabled flips false→true. */
  async runTablesAndDatasources(): Promise<void> {
    if (!this.embedding.available) return;
    const cfg = await resolveEmbeddingConfig(this.prisma);
    if (!cfg.tableEnabled) return;
    await this.fill('datasource');
    await this.fill('table');
  }

  /** Metric-definition half only. ParameterService calls this when
   *  metric.enabled flips false→true (the same switch gates recall), so the
   *  rows written while recall was off become searchable without a restart. */
  async runMetrics(): Promise<void> {
    if (!this.embedding.available) return;
    const cfg = await resolveEmbeddingConfig(this.prisma);
    if (!cfg.metricEnabled) return;
    await this.fill('metric_def');
  }

  /** Fill one collection: scan NULL rows, then per 32-row batch (3
   *  attempts): re-read the still-NULL subset, embed as one batch call, and
   *  write back input-conditionally. Returns the scanned row count. */
  private async fill(collection: VectorCollection): Promise<number> {
    if (this.running.has(collection)) {
      this.logger.log(`backfill ${collection} already running — skipped`);
      return 0;
    }
    this.running.add(collection);
    try {
      const adapter = this.adapterOf(collection);
      const rows = await adapter.load();
      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        await this.fillBatch(collection, adapter, batch);
      }
      return rows.length;
    } finally {
      this.running.delete(collection);
    }
  }

  private async fillBatch(
    collection: VectorCollection,
    adapter: CollectionAdapter,
    batch: PendingRow[],
  ): Promise<void> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        // conditional re-read: rows filled meanwhile (upsert path, an
        // earlier overlapping run) drop out of the batch
        const pending = await adapter.load(batch.map((r) => r.id));
        const embeddable = pending.filter((r) => r.text.trim());
        if (embeddable.length > 0) {
          const vectors = await this.embedding.embedBatch(
            embeddable.map((r) => r.text),
          );
          if (vectors.length !== embeddable.length) {
            throw new Error(
              `embedding provider returned ${vectors.length}/${embeddable.length} vectors`,
            );
          }
          // The Json embedding write and the pgvector upsert commit in ONE
          // transaction. Committed separately, a vector failure would leave
          // the row non-NULL but unindexed — the scan only re-reads NULL
          // rows, so it would never be retried (half-applied state).
          await this.prisma.$transaction(async (tx) => {
            for (const [i, row] of embeddable.entries()) {
              // input-conditional write: an edit or synchronous re-embed
              // that landed mid-flight wins; count 0 means skip (no upsert)
              const written = await adapter.write(row, vectors[i], tx);
              if (written === 1 && this.vector.available) {
                await this.vector.upsert(collection, row.id, vectors[i], tx);
              }
            }
          });
        }
        return;
      } catch (e) {
        if (attempt === ATTEMPTS) {
          this.logger.warn(
            `backfill ${collection} batch [${batch[0]?.id}..${batch[batch.length - 1]?.id}] ` +
              `failed after ${ATTEMPTS} attempts — rows stay NULL for the next run: ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }

  private adapterOf(collection: VectorCollection): CollectionAdapter {
    const dbNull = { equals: Prisma.DbNull };
    switch (collection) {
      case 'data_training':
        return {
          load: async (ids) =>
            (
              await this.prisma.dataTraining.findMany({
                where: ids
                  ? { id: { in: ids }, embedding: dbNull }
                  : { embedding: dbNull },
                select: { id: true, question: true, description: true },
                orderBy: { id: 'asc' },
              })
            ).map((r) => ({
              id: r.id,
              text: embedRowText(r.question, r.description),
              match: { question: r.question, description: r.description },
            })),
          write: async (row, vector, client) =>
            (
              await (client ?? this.prisma).dataTraining.updateMany({
                where: { id: row.id, embedding: dbNull, ...row.match },
                data: { embedding: vector },
              })
            ).count,
        };
      case 'datasource':
        return {
          load: async (ids) =>
            (
              await this.prisma.datasource.findMany({
                where: ids
                  ? { id: { in: ids }, embedding: dbNull }
                  : { embedding: dbNull },
                select: { id: true, name: true, description: true },
                orderBy: { id: 'asc' },
              })
            ).map((r) => ({
              id: r.id,
              text: embedRowText(r.name, r.description),
              match: { name: r.name, description: r.description },
            })),
          write: async (row, vector, client) =>
            (
              await (client ?? this.prisma).datasource.updateMany({
                where: { id: row.id, embedding: dbNull, ...row.match },
                data: { embedding: vector },
              })
            ).count,
        };
      case 'table':
        return {
          load: async (ids) =>
            (
              await this.prisma.table.findMany({
                where: ids
                  ? { id: { in: ids }, embedding: dbNull }
                  : { embedding: dbNull },
                select: {
                  id: true,
                  tableName: true,
                  tableComment: true,
                  customComment: true,
                },
                orderBy: { id: 'asc' },
              })
            ).map((r) => ({
              id: r.id,
              // effective comment — same composition the sync/edit embed
              // paths and recall's keyword scoring use (custom wins)
              text: embedRowText(
                r.tableName,
                r.customComment || r.tableComment,
              ),
              match: {
                tableName: r.tableName,
                tableComment: r.tableComment,
                customComment: r.customComment,
              },
            })),
          write: async (row, vector, client) =>
            (
              await (client ?? this.prisma).table.updateMany({
                where: { id: row.id, embedding: dbNull, ...row.match },
                data: { embedding: vector },
              })
            ).count,
        };
      case 'metric_def':
        return {
          load: async (ids) =>
            (
              await this.prisma.metricDef.findMany({
                where: {
                  ...(ids ? { id: { in: ids } } : {}),
                  embedding: dbNull,
                  // disabled rows are not recallable — index them when the
                  // enable toggle re-embeds (MetricService.afterCommit)
                  enabled: true,
                },
                select: {
                  id: true,
                  name: true,
                  aliases: true,
                  description: true,
                },
                orderBy: { id: 'asc' },
              })
            ).map((r) => ({
              id: r.id,
              text: metricDefEmbedText(r),
              // `aliases` is a Json column: JSONB equality has no portable
              // Prisma filter, so the edit guard uses the scalar input
              // columns. That is sufficient — a rename or description change
              // makes the conditional write miss, and the eager write hook
              // has already embedded the new text anyway.
              match: { name: r.name, description: r.description },
            })),
          write: async (row, vector, client) =>
            (
              await (client ?? this.prisma).metricDef.updateMany({
                where: { id: row.id, embedding: dbNull, ...row.match },
                data: { embedding: vector },
              })
            ).count,
        };
    }
  }
}
