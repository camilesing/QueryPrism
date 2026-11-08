// PromptService — loads the YAML prompt templates + per-engine few-shot SQL
// examples and renders them by substituting `{token}` placeholders. The
// templates ship as .yaml files (template.yaml /
// sql_examples/*.yaml) and are copied to dist/ via nest-cli.json assets, so
// `path.join(__dirname, 'templates', ...)` resolves under both ts-jest (src/)
// and the compiled bundle (dist/src/). Pure rendering — the queryprismName / lang
// are passed in by the caller (AiQuestionService) via the context object.
import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EngineType } from './ai-question';

type Templates = Record<string, string>;
interface ExampleEntry {
  question: string;
  sql: string;
  /** Optional counter-example rendered before `sql` (the
   *  LIMIT-inside-subquery bad/good few-shot pairs). */
  badSql?: string;
}
type EngineExamples = Record<EngineType, ExampleEntry[]>;

const ENGINES: EngineType[] = ['MySQL', 'PostgreSQL', 'SQLite'];

/** Indent every line of a (possibly multi-line) example SQL block. */
function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .trimEnd()
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

/** Substitute every `{token}` in `tpl` with `ctx[token]`, or '' when absent.
 *  Substituted values are inserted verbatim (not re-scanned), so literal
 *  braces inside example SQL or sample data are safe. */
export function renderTemplate(
  tpl: string,
  ctx: Record<string, string | undefined>,
): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => ctx[key] ?? '');
}

@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);
  private readonly templates: Templates;
  private readonly sqlExamples: EngineExamples;

  constructor() {
    const dir = join(__dirname, 'templates');
    this.templates = this.loadTemplates(join(dir, 'template.yaml'));
    this.sqlExamples = ENGINES.reduce((acc, engine) => {
      const file = this.loadYaml<{ examples: ExampleEntry[] }>(
        join(dir, 'sql_examples', `${engine}.yaml`),
      );
      acc[engine] = file.examples ?? [];
      return acc;
    }, {} as EngineExamples);
    this.logger.log(
      `loaded ${Object.keys(this.templates).length} prompt templates, ` +
        `${ENGINES.length} engine example sets`,
    );
  }

  /** Render the named template with the given context. Throws on an unknown
   *  template key (a programming error, not a user error). */
  render(templateKey: string, ctx: Record<string, string | undefined>): string {
    const tpl = this.templates[templateKey];
    if (tpl === undefined) {
      throw new Error(`Unknown prompt template: ${templateKey}`);
    }
    return renderTemplate(tpl, ctx);
  }

  /** Format the static few-shot examples for an engine into an XML-ish block.
   *  Empty string when the engine has no examples (so the section is omitted).
   *  Entries may carry a `badSql` counter-example, rendered as an explicit
   *  incorrect→correct contrast so multi-line SQL stays readable. */
  getSqlExamples(engine: EngineType): string {
    const entries = this.sqlExamples[engine] ?? [];
    if (entries.length === 0) return '';
    return entries
      .map((e) => {
        const parts = [`<example>`, `  question: ${e.question}`];
        if (e.badSql != null && e.badSql !== '') {
          parts.push('  incorrect (do NOT generate this):');
          parts.push(indentLines(e.badSql, 4));
        }
        parts.push('  sql:');
        parts.push(indentLines(e.sql, 4));
        parts.push('</example>');
        return parts.join('\n');
      })
      .join('\n');
  }

  /** Load + parse a YAML file with actionable error context (P2-5: a
   *  missing/corrupt file used to bubble a raw ENOENT/yaml error out of the
   *  DI container with no hint of WHICH template file was broken). */
  private loadYaml<T>(file: string): T {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(
        `无法读取 prompt 模板文件 ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      return parseYaml(text) as T;
    } catch (e) {
      throw new Error(
        `prompt 模板不是合法 YAML: ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** template.yaml specifically: Templates is a keyed-string map — a YAML
   *  typo (a nested block where a string was expected) fails HERE at boot,
   *  not as undefined-template weirdness on first render (P2-5). */
  private loadTemplates(file: string): Templates {
    const parsed = this.loadYaml<Record<string, unknown>>(file);
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (typeof v !== 'string') {
        throw new Error(
          `prompt 模板 ${file} 的 ${k} 条目必须是字符串（得到 ${typeof v}）`,
        );
      }
    }
    return parsed as Templates;
  }
}
