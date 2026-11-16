// Spec for the YAML-backed prompt template service. Asserts against the
// real authored templates (so it also catches a malformed template.yaml).
import { PromptService } from './prompt.service';
import type { EngineType } from './ai-question';

describe('PromptService', () => {
  let svc: PromptService;
  beforeAll(() => {
    svc = new PromptService();
  });

  describe('render', () => {
    it('substitutes provided placeholders', () => {
      const out = svc.render('generate_sql', {
        schema: 'MY SCHEMA',
        question: 'how many users?',
      });
      expect(out).toContain('MY SCHEMA');
      expect(out).toContain('how many users?');
    });

    it('replaces missing placeholders with an empty string (no leftover braces)', () => {
      const out = svc.render('generate_sql', {
        schema: 'S',
        question: 'Q',
      });
      // every documented token is gone — no {word} survives
      expect(out).not.toMatch(/\{[a-z_]+\}/);
    });

    it('throws on an unknown template key', () => {
      expect(() => svc.render('no_such_template', {})).toThrow();
    });

    it('renders the select_datasource template with the datasource list', () => {
      const out = svc.render('select_datasource', {
        datasource_list: '1. orders\n2. users',
        question: 'sales trend?',
      });
      expect(out).toContain('1. orders');
      expect(out).toContain('sales trend?');
    });

    it('renders every generate_sql context section and keeps the output contract', () => {
      const markers = {
        schema: 'SCHEMA_MARKER',
        terminologies: 'TERM_MARKER',
        data_training: 'TRAIN_MARKER',
        sample_data: 'SAMPLE_MARKER',
        question: 'QUESTION_MARKER',
      };
      const out = svc.render('generate_sql', {
        ...markers,
        engine: 'PostgreSQL',
      });
      for (const marker of Object.values(markers)) {
        expect(out).toContain(marker);
      }
      expect(out).toContain('PostgreSQL');
      expect(out).toContain('"sql"');
      expect(out).toContain('"chart-type"');
      expect(out).toContain('"brief"');
    });

    it('renders the permissions system/human pair', () => {
      const sys = svc.render('permissions_system', { engine: 'MySQL' });
      expect(sys).toContain('MySQL');
      expect(sys).toContain('"success"');

      const human = svc.render('permissions', {
        sql: 'SQL_MARKER',
        filter: 'FILTER_MARKER',
      });
      expect(human).toContain('SQL_MARKER');
      expect(human).toContain('FILTER_MARKER');
    });
  });

  describe('getSqlExamples', () => {
    it('returns a non-empty block for MySQL', () => {
      const out = svc.getSqlExamples('MySQL');
      expect(out).toContain('COUNT(*)');
      expect(out).toContain('DATE_FORMAT');
    });

    it('returns PostgreSQL-flavoured SQL', () => {
      const out = svc.getSqlExamples('PostgreSQL');
      expect(out).toContain('EXTRACT');
    });

    it('returns SQLite-flavoured SQL', () => {
      const out = svc.getSqlExamples('SQLite');
      expect(out).toContain('strftime');
    });

    it('returns an empty string for an engine with no examples', () => {
      // EngineType is a closed union; exercise the no-examples branch by
      // casting an unknown value through the back door.
      expect(svc.getSqlExamples('Oracle' as unknown as EngineType)).toBe('');
    });

    it('renders badSql counter-examples as an incorrect/sql contrast', () => {
      // LIMIT-inside-subquery few-shot pairs.
      const out = svc.getSqlExamples('MySQL');
      expect(out).toContain('incorrect (do NOT generate this):');
      expect(out).toMatch(/LIMIT 100\) t/); // the bad variant's inner LIMIT
      // the good variant keeps LIMIT on the outermost query only
      expect(out).toContain('ORDER BY total_amount DESC');
      // multi-line SQL is indented inside the example block
      expect(out).toMatch(/^ {4}SELECT o\.customer_id/m);
    });
  });
});

// ─────────────── tail-sweep: loadYaml / loadTemplates failure arms ───────────────
// The loader is private; the back-door cast keeps the boot-time P2-5 error
// context pinned (WHICH file, and WHY) without shipping broken template files.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PromptService template loading failures', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qp-prompt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function loader(svc: PromptService) {
    return svc as unknown as {
      loadYaml: <T>(file: string) => T;
      loadTemplates: (file: string) => Record<string, string>;
    };
  }

  it('a missing template file fails with the file path in the message', () => {
    const svc = new PromptService();
    const missing = join(dir, 'nope.yaml');
    expect(() => loader(svc).loadYaml(missing)).toThrow(
      `无法读取 prompt 模板文件 ${missing}`,
    );
  });

  it('corrupt YAML fails with the file path in the message', () => {
    const svc = new PromptService();
    const corrupt = join(dir, 'corrupt.yaml');
    writeFileSync(corrupt, 'a: [unclosed', 'utf8');
    expect(() => loader(svc).loadYaml(corrupt)).toThrow(
      `prompt 模板不是合法 YAML: ${corrupt}`,
    );
  });

  it('an empty (null-parsed) template file skips the entries loop cleanly', () => {
    const svc = new PromptService();
    const empty = join(dir, 'empty.yaml');
    writeFileSync(empty, '', 'utf8');
    // parseYaml('') === null → the ?? {} guard keeps Object.entries safe; the
    // raw null still flows through the cast return (render would 404 later).
    expect(() => loader(svc).loadTemplates(empty)).not.toThrow();
    expect(loader(svc).loadTemplates(empty)).toBeNull();
  });

  it('a nested block where a string was expected fails at load time (P2-5)', () => {
    const svc = new PromptService();
    const nested = join(dir, 'nested.yaml');
    writeFileSync(nested, 'generate_sql:\n  oops: true\n', 'utf8');
    expect(() => loader(svc).loadTemplates(nested)).toThrow(
      /generate_sql 条目必须是字符串（得到 object）/,
    );
  });
});
