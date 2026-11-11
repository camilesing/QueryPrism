// SQL result cache (MetaDataImprove M7): high-frequency requests (agents
// re-running the same question, dashboards refreshing) hit a Postgres-backed
// cache instead of re-executing. Guarded by cache.enabled (default OFF) and
// a TTL; the per-workspace semantic revision (SystemVariable type='cache_rev')
// is part of the lookup so a revision bump (datasource rebind / table-structure
// sync / Excel re-import) invalidates every entry in O(1) reads.
//
// Revision bumps only hook the sites where the UNDERLYING DATA can change in
// place under identical SQL. Semantic/metric/standard/relation edits need no
// bump: they change the LLM-generated SQL, and the SQL-hash key already
// isolates different SQL.
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { QueryResult } from '../datasource/db-connector/db-connector.interface';
import { PrismaService } from '../database/prisma.service';

const revisionKey = (oid: number) => `cache.rev.${oid}`;

@Injectable()
export class QueryCacheService {
  private readonly logger = new Logger(QueryCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Current semantic revision of the workspace (0 = never bumped). One tiny
   * indexed read per cached execSql call. */
  async currentRevision(oid: number): Promise<number> {
    const row = await this.prisma.systemVariable.findUnique({
      where: { name: revisionKey(oid) },
    });
    if (!row) return 0;
    const v = row.value;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  /** Invalidate every cached entry of the workspace (read +1, upsert).
   *  Concurrent bumps may coalesce to the same next value — harmless, any
   *  change invalidates. Callers fire-and-forget; errors are theirs to catch
   *  (a failed bump only means entries live until their TTL). */
  async bumpRevision(oid: number): Promise<void> {
    const current = await this.currentRevision(oid);
    await this.prisma.systemVariable.upsert({
      where: { name: revisionKey(oid) },
      create: {
        name: revisionKey(oid),
        varType: 'number',
        type: 'cache_rev',
        value: current + 1,
        createTime: new Date(),
      },
      update: { value: current + 1 },
    });
  }

  /** Cached result for the exact (oid, datasource, effective-SQL hash) at the
   *  CURRENT revision, unexpired. null = miss (go execute). */
  async lookup(
    oid: number,
    datasourceId: number,
    sqlHash: string,
    revision: number,
  ): Promise<QueryResult | null> {
    const row = await this.prisma.queryCacheEntry.findUnique({
      where: { oid_datasourceId_sqlHash: { oid, datasourceId, sqlHash } },
    });
    if (!row || row.revision !== revision) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return row.result as unknown as QueryResult;
  }

  /** Store an execution result. Best-effort: a store failure is logged and
   *  swallowed (the caller already has the fresh result). Also lazily purges
   *  this workspace's expired rows — bounded housekeeping without a cron. */
  async store(
    oid: number,
    datasourceId: number,
    sqlHash: string,
    finalSql: string,
    result: QueryResult,
    revision: number,
    ttlSeconds: number,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    // rows is unknown[][] (values are JSON-safe at runtime — they came out of
    // the connector); Prisma's InputJsonValue can't express that, so cast.
    const resultJson = {
      columns: result.columns,
      rows: result.rows,
    } as unknown as Prisma.InputJsonValue;
    try {
      await this.prisma.queryCacheEntry.upsert({
        where: { oid_datasourceId_sqlHash: { oid, datasourceId, sqlHash } },
        create: {
          oid,
          datasourceId,
          sqlHash,
          sql: finalSql,
          result: resultJson,
          rowCount: result.rows.length,
          revision,
          expiresAt,
        },
        update: {
          result: resultJson,
          rowCount: result.rows.length,
          revision,
          expiresAt,
        },
      });
      // Housekeeping piggybacked on writes (no dedicated cron; expired rows
      // are never served so their only cost is disk until purged).
      await this.prisma.queryCacheEntry.deleteMany({
        where: { oid, expiresAt: { lt: new Date() } },
      });
    } catch (e) {
      this.logger.warn(
        `query cache store failed (oid=${oid} ds=${datasourceId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
