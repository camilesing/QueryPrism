// Spec for the robust nested-JSON extractor. LLMs frequently wrap JSON in
// prose or markdown fences and may include brace characters inside SQL string
// literals — a naive JSON.parse or regex fails.
import { extractNestedJson } from './extract-json';

describe('extractNestedJson', () => {
  it('returns a plain object untouched', () => {
    expect(extractNestedJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns a top-level array', () => {
    expect(extractNestedJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strips a markdown code fence', () => {
    expect(extractNestedJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts from leading/trailing prose', () => {
    expect(extractNestedJson('here is the answer: {"sql":"x"} done')).toEqual({
      sql: 'x',
    });
  });

  it('keeps nested object braces balanced', () => {
    expect(extractNestedJson('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
  });

  it('ignores braces inside string literals', () => {
    // The SQL string contains literal { and } which must not perturb depth.
    expect(
      extractNestedJson('{"sql":"select {x} from t where a=\'b\'"}'),
    ).toEqual({ sql: "select {x} from t where a='b'" });
  });

  it('respects escaped quotes inside strings', () => {
    expect(extractNestedJson('{"q":"he said \\"hi\\""}')).toEqual({
      q: 'he said "hi"',
    });
  });

  it('returns null when no JSON is present', () => {
    expect(extractNestedJson('no json anywhere')).toBeNull();
  });

  it('returns null for an unbalanced brace string', () => {
    expect(extractNestedJson('{"a":1')).toBeNull();
  });

  it('falls back to the next candidate when the first parse fails', () => {
    // First { opens a malformed object; the second is valid.
    expect(extractNestedJson('noise {bad} then {"ok":true}')).toEqual({
      ok: true,
    });
  });

  // --- brace-in-SQL-literal edge cases -------------------------------------

  it.each([
    "SELECT * FROM config WHERE path LIKE '{'",
    "SELECT * FROM logs WHERE note LIKE '%}'",
    "SELECT * FROM users WHERE tag LIKE '%{vip}%'",
  ])('extracts JSON whose SQL string contains braces (%s)', (sql) => {
    // The braces stay literal (unescaped) in the SQL, as an LLM would emit.
    const text = `{"sql": "${sql}", "success": true}`;
    expect(extractNestedJson(text)).toEqual({ sql, success: true });
  });

  it('extracts JSON with escaped quotes and braces in the SQL literal', () => {
    const text =
      '{"sql": "SELECT \\"col\\" FROM t WHERE json_val = \'{\\"key\\": \\"val\\"}\'", "success": true}';
    expect(extractNestedJson(text)).toEqual({
      sql: 'SELECT "col" FROM t WHERE json_val = \'{"key": "val"}\'',
      success: true,
    });
  });

  it('extracts JSON with escaped backslashes', () => {
    const text = String.raw`{"sql": "SELECT * FROM files WHERE path = 'C:\\Users\\default\\{tmp}'", "success": true}`;
    expect(extractNestedJson(text)).toEqual({
      sql: String.raw`SELECT * FROM files WHERE path = 'C:\Users\default\{tmp}'`,
      success: true,
    });
  });

  it('extracts JSON wrapped in a markdown code block', () => {
    const text = `Here is the query result:
\`\`\`json
{
  "sql": "SELECT * FROM users WHERE template LIKE '%{test}%'",
  "success": true
}
\`\`\`
Hope this helps!`;
    expect(extractNestedJson(text)).toEqual({
      sql: "SELECT * FROM users WHERE template LIKE '%{test}%'",
      success: true,
    });
  });

  it('skips leading prose that itself contains braces and quotes', () => {
    const text =
      '注意：参数模板例如 {workspace_id}，大模型返回的结果如下：\n{"sql": "SELECT * FROM table WHERE col = \'{foo}\'", "success": true}';
    expect(extractNestedJson(text)).toEqual({
      sql: "SELECT * FROM table WHERE col = '{foo}'",
      success: true,
    });
  });

  it('an invalid braced block before the valid JSON does not break extraction', () => {
    expect(
      extractNestedJson(
        '{invalid json here} Followed by valid: {"sql": "SELECT 1", "success": true}',
      ),
    ).toEqual({ sql: 'SELECT 1', success: true });
  });

  it.each(['', '   ', 'No json at all here'])(
    'returns null for empty or JSON-free input (%s)',
    (input) => {
      expect(extractNestedJson(input)).toBeNull();
    },
  );

  it.each([
    '{"tables": [],}',
    '{"outer": {"success": true, "sql": "SELECT 0"}, bad}',
    '[{"year": 2026, "value": 10},]',
    // mixed brackets — the scanner counts boundaries, JSON.parse rejects
    '{"tables": [}, "other": {"success": true}}',
    '{"value": NaN, "tables": []}',
    '{"sql": "SELECT\n1", "tables": []}',
  ])('an invalid outer candidate never exposes nested values (%s)', (bad) => {
    expect(extractNestedJson(bad)).toBeNull();
    const answer = '{"success": true, "sql": "SELECT 1", "tables": ["t"]}';
    expect(extractNestedJson(`${bad} then ${answer}`)).toEqual({
      success: true,
      sql: 'SELECT 1',
      tables: ['t'],
    });
  });

  it.each([
    '{"sql": "SELECT 1", "tables": ["t"]',
    '[{"year": 2026, "value": 10},',
    '[{"x": 1}',
    '{"outer": {"success": true, "sql": "SELECT 1"}',
    '{"text": "unterminated [] {}',
  ])('a truncated outer candidate is rejected (%s)', (truncated) => {
    expect(extractNestedJson(truncated)).toBeNull();
  });

  it.each([
    '{"outer": [{"inner": [1, 2]}, []], "empty": {}}',
    "{\"sql\": \"SELECT '[', ']', '{', '}'\", \"tables\": []}",
    '{"text": "escaped quote: \\" { [", "tail": "ends in slash \\\\"}',
    '{}',
    '[]',
  ])('a complete outer candidate is preserved (%s)', (answer) => {
    expect(
      extractNestedJson(`Explanation: "answer" \`\`\`json\n${answer}\n\`\`\``),
    ).toEqual(JSON.parse(answer));
    expect(extractNestedJson(`${answer} {"next": true}`)).toEqual(
      JSON.parse(answer),
    );
  });
});
