// AppearanceFileService — local on-disk storage for branding images
// (website logo / login logo / backgrounds). Mirrors the assistant file store
// pattern: opaque file ids persisted in SystemVariable(type='appearance') and
// streamed back through GET /system/appearance/picture/:file.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tr } from '../common/i18n/translate';

const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'];
const MAX_BYTES = 5 * 1024 * 1024;
const FILE_ID_RE = /^[a-f0-9]{32}\.(png|jpe?g|svg|webp|gif)$/i;

@Injectable()
export class AppearanceFileService {
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.dir = resolve(
      config.get<string>('appearance.uploadDir') ?? 'uploads/appearance',
    );
  }

  /** Persist an uploaded image and return its opaque file id. */
  async save(file: Express.Multer.File): Promise<string> {
    // The frontend encodes the target field as "<name>,<flag>" in the
    // multipart filename; the extension belongs to the part before the flag.
    const original = file.originalname ?? '';
    const comma = original.lastIndexOf(',');
    const fileName = comma >= 0 ? original.slice(0, comma) : original;
    const ext = extname(fileName).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      throw new BadRequestException(tr('appearance.image_type_unsupported'));
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(tr('appearance.image_too_large'));
    }
    await fs.mkdir(this.dir, { recursive: true });
    const fileId = `${randomBytes(16).toString('hex')}${ext}`;
    await fs.writeFile(resolve(this.dir, fileId), file.buffer);
    return fileId;
  }

  async exists(fileId: string): Promise<boolean> {
    try {
      return await this.resolve(fileId).then(() => true);
    } catch {
      return false;
    }
  }

  pathFor(fileId: string): string {
    return resolve(this.dir, fileId);
  }

  async delete(fileId: string): Promise<void> {
    if (!FILE_ID_RE.test(fileId)) return;
    await fs.unlink(resolve(this.dir, fileId)).catch(() => undefined);
  }

  mediaType(fileId: string): string {
    switch (extname(fileId).toLowerCase()) {
      case '.png':
        return 'image/png';
      case '.svg':
        return 'image/svg+xml';
      case '.webp':
        return 'image/webp';
      case '.gif':
        return 'image/gif';
      default:
        return 'image/jpeg';
    }
  }

  private async resolve(fileId: string): Promise<string> {
    if (!FILE_ID_RE.test(fileId)) {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    const full = resolve(this.dir, fileId);
    if (dirname(full) !== this.dir) {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    await fs.access(full).catch(() => {
      throw new NotFoundException(tr('common.file_not_found'));
    });
    return full;
  }
}
