// ImportErrorFileService — writes the per-row failure workbook that the
// import surfaces advertise as `error_excel_filename`, and resolves it back
// for POST /system/download-fail-info.
//
// Files live under `importError.dir` (default `uploads/import-errors`,
// .gitignored). The filename is the download handle: it is generated
// server-side, must end in `_error.xlsx`, and is resolved strictly inside the
// configured directory (no traversal). The same store backs the user
// batch-import error record (`GET /user/errorRecord/:key`).
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ExcelJS from 'exceljs';
import { tr } from '../i18n/translate';

export interface ImportErrorFileInput {
  /** Short stable prefix, e.g. `terminology` / `data-training` / `user`. */
  prefix: string;
  /** Original column labels (without the trailing error column). */
  headers: string[];
  /** One row per failed input row, aligned with `headers`. */
  rows: unknown[][];
  /** Per-row failure message, aligned with `rows`. */
  messages: string[];
}

const ERROR_SUFFIX = '_error.xlsx';
const PREFIX_RE = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class ImportErrorFileService {
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.dir = resolve(
      config.get<string>('importError.dir') ?? 'uploads/import-errors',
    );
  }

  /** Write an error workbook and return its filename (the download handle). */
  async write(input: ImportErrorFileInput): Promise<string> {
    if (input.rows.length !== input.messages.length) {
      throw new Error('error file rows/messages length mismatch');
    }
    const prefix = PREFIX_RE.test(input.prefix) ? input.prefix : 'import';
    const filename = `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}${ERROR_SUFFIX}`;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Errors');
    ws.columns = [
      ...input.headers.map((header) => ({ header, key: header, width: 24 })),
      { header: tr('import-export.error_column'), key: '__error__', width: 48 },
    ];
    const errorColumn = ws.getColumn('__error__');
    errorColumn.font = { color: { argb: 'FFFF0000' } };

    input.rows.forEach((row, idx) => {
      const cells: Record<string, unknown> = {};
      input.headers.forEach((header, col) => {
        cells[header] = row[col] ?? null;
      });
      cells.__error__ = input.messages[idx] ?? '';
      ws.addRow(cells);
    });
    ws.getRow(1).font = { bold: true };

    await fs.mkdir(this.dir, { recursive: true });
    const buffer = await wb.xlsx.writeBuffer();
    await fs.writeFile(resolve(this.dir, filename), Buffer.from(buffer));
    return filename;
  }

  /** Resolve a download handle to an on-disk path, rejecting traversal. */
  async resolveDownload(filename: string): Promise<string> {
    if (!filename || filename !== basename(filename)) {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    if (!filename.endsWith(ERROR_SUFFIX)) {
      throw new BadRequestException(tr('import-export.error_file_only'));
    }
    const full = resolve(this.dir, filename);
    if (dirname(full) !== this.dir) {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    try {
      await fs.access(full);
    } catch {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    return full;
  }

  /** Delete a download handle (clearErrorRecord). Missing files are a no-op. */
  async delete(filename: string): Promise<void> {
    let full: string;
    try {
      full = await this.resolveDownload(filename);
    } catch {
      return;
    }
    await fs.unlink(full).catch(() => undefined);
  }
}
