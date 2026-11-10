import {
  Allow,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import {
  SYNC_HTTP_METHODS,
  SYNC_KINDS,
  SYNC_TARGETS,
  type SyncAuth,
  type SyncHttpMethod,
  type SyncKind,
  type SyncTarget,
} from '../../metadata-sync/metadata-sync-policy';

/** Body for POST/PUT `/system/metadata-sync` (MetaDataImprove M5). `id` is
 *  present on update. `auth` is write-only: the service AES-encrypts it and
 *  responses only expose `has_auth`. */
export class MetadataSyncUpsertDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn([...SYNC_KINDS])
  kind!: SyncKind;

  @IsIn([...SYNC_TARGETS])
  target!: SyncTarget;

  @IsString()
  @IsNotEmpty()
  endpoint!: string;

  @IsOptional()
  @IsIn([...SYNC_HTTP_METHODS])
  http_method?: SyncHttpMethod;

  /** Arbitrary JSON body for HTTP_API + POST. */
  @IsOptional()
  @Allow()
  http_body?: unknown;

  /** Auth headers / bearer token. `null` clears a previously saved secret. */
  @IsOptional()
  auth?: SyncAuth | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  mcp_tool?: string;

  @IsOptional()
  @IsObject()
  mcp_args?: Record<string, unknown>;

  /** 5/6-field cron expression; null/omitted = manual-only. */
  @IsOptional()
  @IsString()
  cron?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
