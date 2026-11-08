// AssistantFileService — local on-disk file storage for the
// embedded-settings routes. The frontend settings page
// (SetUi.vue:121) PATCHes /system/assistant/ui with multipart `data` (a
// JSON-stringified AssistantUiSchema) + `files` whose originalname encodes the
// target field as `"<name>,<flag>"` (flag = logo | float_icon). upload()
// returns a file_id persisted into configuration.<flag>; the embedded page
// then builds `baseUrl + file_id` and GETs /system/assistant/picture/:file_id
// (Card.vue:67). Replacing or clearing a flag deletes the prior file_id.
//
// This is a QueryPrism-defined on-disk implementation. Files land under
// `assistant.uploadDir` (default `uploads/assistant`, .gitignored). Buffer-
// based (AnyFilesInterceptor memory storage) — images are ≤10 MB.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tr } from '../common/i18n/translate';

export interface SplitFile {
  /** The real filename (with extension), e.g. `logo.png`. */
  fileName: string;
  /** The configuration field the file targets: `logo` | `float_icon` | `''`. */
  flagName: string;
}

/** The configuration fields that accept an uploaded file. */
export const FILE_FLAGS = ['logo', 'float_icon'] as const;
export type FileFlag = (typeof FILE_FLAGS)[number];

@Injectable()
export class AssistantFileService {
  private readonly logger = new Logger(AssistantFileService.name);
  private readonly uploadDir: string;
  private static readonly ALLOWED_EXTS = ['.jpg', '.jpeg', '.png'];
  private static readonly MAX_BYTES = 10 * 1024 * 1024;

  constructor(config: ConfigService) {
    const dir =
      config.get<string>('assistant.uploadDir') ?? 'uploads/assistant';
    // Resolve once so relative dirs are anchored to the backend cwd (idempotent
    // for absolute env overrides).
    this.uploadDir = resolve(dir);
  }

  /** Split `"<name>,<flag>"` → { fileName, flagName }. The frontend
   *  (SetUi.vue:138) appends `,<flag>` to each file's name; flag names the
   *  configuration field the file targets (logo | float_icon). No comma → the
   *  whole string is the filename and flagName is ''. */
  splitFilenameAndFlag(originalname: string): SplitFile {
    const idx = originalname.lastIndexOf(',');
    if (idx < 0) return { fileName: originalname, flagName: '' };
    return {
      fileName: originalname.slice(0, idx),
      flagName: originalname.slice(idx + 1),
    };
  }

  /** Validate extension + size: .jpg/.jpeg/.png, ≤10 MB. */
  checkFile(
    file: Express.Multer.File,
    allowedExts: readonly string[] = AssistantFileService.ALLOWED_EXTS,
    maxBytes = AssistantFileService.MAX_BYTES,
  ): void {
    const ext = extname(file.originalname).toLowerCase();
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException(tr('assistant.image_type_unsupported'));
    }
    if (file.size > maxBytes) {
      throw new BadRequestException(tr('assistant.file_too_large'));
    }
  }

  /** Persist a buffered upload → opaque file_id (the stored filename).
   *  file_id = hex + original extension; collisions are astronomically
   *  unlikely (8 random bytes). checkFile() runs HERE — validation must not
   *  depend on the caller remembering to call it first (a route that skips
   *  checkFile could otherwise persist arbitrary content/extensions; the
   *  check is idempotent for callers that ran it). */
  async upload(
    file: Express.Multer.File,
    allowedExts: readonly string[] = AssistantFileService.ALLOWED_EXTS,
    maxBytes = AssistantFileService.MAX_BYTES,
  ): Promise<string> {
    this.checkFile(file, allowedExts, maxBytes);
    await fs.mkdir(this.uploadDir, { recursive: true });
    const ext = extname(file.originalname) || '';
    const fileId = `${randomBytes(8).toString('hex')}${ext}`;
    await fs.writeFile(this.pathFor(fileId), file.buffer);
    return fileId;
  }

  /** Absolute path for a stored file_id. /picture/:file_id is user-supplied,
   *  so anything that is not EXACTLY a generated id shape (16 hex chars +
   *  optional whitelisted image extension) is rejected outright — `..`, `.`,
   *  separators, null bytes, absolute paths, and unknown extensions all fail
   *  the regex, which closes the path-traversal hole the old strip-separators
   *  approach left open (it never handled `..`, `.`, or NUL). */
  private static readonly FILE_ID_RE = /^[0-9a-f]{16}(?:\.(?:jpg|jpeg|png))?$/i;

  /** Path for a stored file_id; throws NotFound for anything not matching the
   *  generated-id shape (traversal guard). Callers that probe (exists/delete)
   *  catch and treat it as missing; the picture route turns it into a 404. */
  pathFor(fileId: string): string {
    if (!AssistantFileService.FILE_ID_RE.test(fileId)) {
      throw new NotFoundException(
        tr('assistant.file_id_not_found', { id: fileId }),
      );
    }
    return join(this.uploadDir, fileId);
  }

  /** True only when a REGULAR FILE with a valid file_id shape exists (a
   *  matching directory — e.g. the parent via '..' — must not count). */
  async exists(fileId: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.pathFor(fileId));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /** Delete a file_id. No-op if missing — a missing file on replace/clear
   *  shouldn't fail the request. */
  async delete(fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    try {
      await fs.unlink(this.pathFor(fileId));
    } catch (e) {
      this.logger.debug(`delete(${fileId}) skipped: ${(e as Error).message}`);
    }
  }
}
