// VectorService — pgvector-backed ANN store for RAG recall (terminology /
// data-training / datasource + table selection / metric definitions).
//
// Prisma's `embedding Json` columns remain the source of truth (portable,
// rebuildable). The `vector_store` schema holds derived search indexes:
// one table per collection with a cosine HNSW index. The schema is separate
// from `public` so runtime-created tables never show up as Prisma Migrate
// drift.
//
// If pgvector is unavailable (extension/schema missing), the service degrades
// to a no-op: every method returns empty/no-ops and recall falls back to
// keyword-only search. The app keeps working without vector search.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export type VectorCollection =
  'terminology' | 'data_training' | 'datasource' | 'table' | 'metric_def';

export interface VectorHit {
  id: number;
  /** cosine distance: 0 = identical, 2 = opposite. Lower = more similar. */
  distance: number;
}

const COLLECTIONS = [
  'terminology',
  'data_training',
  'datasource',
  'table',
  'metric_def',
] as const;

/** Dedicated schema for derived vector tables (not managed by Prisma Migrate). */
const VECTOR_SCHEMA = 'vector_store';

function assertCollection(c: string): asserts c is VectorCollection {
  if (!(COLLECTIONS as readonly string[]).includes(c)) {
    throw new Error(`Unknown vector collection: ${c}`);
  }
}

function tableOf(c: VectorCollection): string {
  return `vec_${c}`;
}

function qualifiedTable(c: VectorCollection): string {
  return `"${VECTOR_SCHEMA}"."${tableOf(c)}"`;
}

function indexOf(c: VectorCollection): string {
  return `${tableOf(c)}_embedding_idx`;
}

/** pgvector text input format: [1,2,3]. Only finite numbers are allowed. */
function toVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Cannot write an empty embedding vector');
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding vector contains a non-finite value');
    }
  }
  return `[${vector.join(',')}]`;
}

/** Postgres 42P01 (undefined_table). Prisma wraps a failed raw query as
 *  P2010 with the driver SQLSTATE in `meta.code`; a bare `code` is kept for
 *  direct driver errors. The vec_* tables are created lazily on first
 *  upsert, so a missing table is a normal state (fresh install, after clear). */
function isUndefinedTable(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; meta?: { code?: unknown } | null };
  if (err.code === '42P01') return true;
  return err.code === 'P2010' && err.meta?.code === '42P01';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

@Injectable()
export class VectorService implements OnModuleInit {
  private readonly logger = new Logger(VectorService.name);
  private ready = false;
  /** Optional EMBEDDING_DIMENSION check (inference from the first vector otherwise). */
  private readonly expectedDim?: number;
  /** Dimension recorded per collection once its table exists. */
  private readonly dims = new Map<VectorCollection, number>();

  constructor(
    private readonly prisma: PrismaService,
    config?: ConfigService,
  ) {
    this.expectedDim = config?.get<number>('embedding.dimension');
  }

  async onModuleInit(): Promise<void> {
    try {
      const ext = await this.prisma.$queryRawUnsafe<
        Array<{ extversion: string }>
      >(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
      if (ext.length === 0) {
        this.logger.error(
          'pgvector extension is not installed — vector search disabled. ' +
            'Run "pnpm prisma:deploy" (the baseline migration enables it) or CREATE EXTENSION vector.',
        );
        return;
      }

      const schema = await this.prisma.$queryRawUnsafe<Array<{ ok: number }>>(
        `SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = $1`,
        VECTOR_SCHEMA,
      );
      if (schema.length === 0) {
        this.logger.error(
          `Schema "${VECTOR_SCHEMA}" is missing — vector search disabled. Run "pnpm prisma:deploy".`,
        );
        return;
      }

      this.ready = true;
      for (const collection of COLLECTIONS) {
        await this.recoverDim(collection);
      }
      this.logger.log(
        `pgvector ${ext[0].extversion} ready (schema ${VECTOR_SCHEMA})`,
      );
    } catch (e) {
      this.logger.error(
        `pgvector unavailable — vector search disabled. ${errorMessage(e)}`,
      );
    }
  }

  /** Upsert a vector for (collection, id). No-op when pgvector is disabled.
   *  An optional transaction client runs the INSERT atomically with the
   *  caller's other writes (embedding-backfill's Json write). Table DDL
   *  (ensureTable) always runs on the root client — Prisma interactive
   *  transactions cannot nest, and the DDL is advisory-locked + idempotent. */
  async upsert(
    collection: string,
    id: number,
    vector: number[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (!this.ready) return;
    assertCollection(collection);
    this.assertDimension(vector);

    const literal = toVectorLiteral(vector);
    await this.ensureTable(collection, vector.length);

    await client.$executeRawUnsafe(
      `INSERT INTO ${qualifiedTable(collection)} (id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      id,
      literal,
    );
  }

  /** Remove a vector. No-op if the table or pgvector is unavailable. */
  async remove(collection: string, id: number): Promise<void> {
    if (!this.ready) return;
    assertCollection(collection);
    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM ${qualifiedTable(collection)} WHERE id = $1`,
        id,
      );
    } catch (e) {
      if (!isUndefinedTable(e)) throw e;
    }
  }

  /** k nearest neighbors by cosine distance. Empty when disabled / no table. */
  async search(
    collection: string,
    query: number[],
    k = 5,
  ): Promise<VectorHit[]> {
    if (!this.ready) return [];
    assertCollection(collection);
    this.assertDimension(query);

    const literal = toVectorLiteral(query);
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ id: number | bigint; distance: number | string }>
      >(
        `SELECT id, embedding <=> $1::vector AS distance
         FROM ${qualifiedTable(collection)}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        literal,
        k,
      );
      return rows.map((row) => ({
        id: Number(row.id),
        distance: Number(row.distance),
      }));
    } catch (e) {
      if (isUndefinedTable(e)) return [];
      throw e;
    }
  }

  /** Drop + forget a collection's table (used by tests / rebuild flows). */
  async clear(collection: string): Promise<void> {
    if (!this.ready) return;
    assertCollection(collection);
    await this.prisma.$executeRawUnsafe(
      `DROP TABLE IF EXISTS ${qualifiedTable(collection)}`,
    );
    this.dims.delete(collection);
  }

  /** Whether vector search is active (pgvector extension + schema present). */
  get available(): boolean {
    return this.ready;
  }

  // --- internals -----------------------------------------------------------

  private assertDimension(vector: number[]): void {
    if (this.expectedDim !== undefined && vector.length !== this.expectedDim) {
      throw new Error(
        `Embedding dimension ${vector.length} does not match EMBEDDING_DIMENSION=${this.expectedDim}. ` +
          'Update the env var or use a matching embedding model.',
      );
    }
  }

  private async ensureTable(
    collection: VectorCollection,
    dim: number,
  ): Promise<void> {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`Invalid embedding dimension: ${dim}`);
    }

    const known = this.dims.get(collection);
    if (known !== undefined && known !== dim) {
      throw this.dimensionMismatch(collection, known, dim);
    }
    if (known === dim) return;

    await this.prisma.$transaction(
      async (tx) => {
        // Serialise DDL across multiple app instances. The subquery keeps the
        // void-returning lock function out of the result set (Prisma cannot
        // deserialize a void column).
        await tx.$queryRawUnsafe(
          `SELECT 1 AS locked
             FROM (SELECT pg_advisory_xact_lock(hashtext($1)::bigint)) AS lock_holder`,
          `${VECTOR_SCHEMA}.${tableOf(collection)}`,
        );

        const existing = await this.tableDim(tx, collection);
        if (existing !== null && existing !== dim) {
          throw this.dimensionMismatch(collection, existing, dim);
        }
        if (existing === null) {
          await tx.$executeRawUnsafe(
            `CREATE TABLE IF NOT EXISTS ${qualifiedTable(collection)} (
               id INTEGER PRIMARY KEY,
               embedding vector(${dim}) NOT NULL
             )`,
          );
        }
        // HNSW needs no training and can be created on an empty table.
        await tx.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS ${indexOf(collection)}
             ON ${qualifiedTable(collection)}
             USING hnsw (embedding vector_cosine_ops)`,
        );
      },
      { timeout: 15_000 },
    );

    this.dims.set(collection, dim);
  }

  private async recoverDim(collection: VectorCollection): Promise<void> {
    const dim = await this.tableDim(this.prisma, collection);
    if (dim !== null) this.dims.set(collection, dim);
  }

  /** Read `vector(n)` from pg_attribute; null when the table/column is absent. */
  private async tableDim(
    client: Pick<PrismaService, '$queryRawUnsafe'>,
    collection: VectorCollection,
  ): Promise<number | null> {
    const rows = await client.$queryRawUnsafe<Array<{ type: string }>>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1)
          AND a.attname = 'embedding'
          AND a.attnum > 0`,
      `${VECTOR_SCHEMA}.${tableOf(collection)}`,
    );
    const match = /vector\((\d+)\)/i.exec(rows[0]?.type ?? '');
    return match ? Number(match[1]) : null;
  }

  private dimensionMismatch(
    collection: VectorCollection,
    expected: number,
    received: number,
  ): Error {
    return new Error(
      `Embedding dimension mismatch for ${collection}: column expects ${expected}, got ${received}. ` +
        `Change the embedding model back, or clear and rebuild the vector_store.${tableOf(collection)} table.`,
    );
  }
}
