// chat-messages — the zh/en strings the chat SSE pipeline shows the user:
// status `info` frames, `error`/fail payloads, and the pre-stream 404
// messages the controller returns as plain text. The language follows the
// question's own language (detect-language.ts); every locale other than
// zh-CN — en plus any unrecognized fallback like ja/ko — resolves to the
// English set. Interpolated messages are functions on the interface.
export interface ChatMessages {
  selectDatasource: string;
  generateSql: string;
  execSql: string;
  generateChart: string;
  generateAnalysis: string;
  generatePredict: string;
  datasourceNotSelected: string;
  noDatasource: string;
  datasourceRequired: string;
  unsupportedEngine: string;
  sqlGenNoResult: string;
  sqlGenFailed: string;
  sqlEmpty: string;
  sqlSafetyFailed: string;
  filterGenFailed: string;
  filterSafetyFailed: string;
  sqlExecFailed: (detail: string) => string;
  analysisNoResult: string;
  predictNoResult: string;
  secondaryNoResult: string;
  quickCmdMissingId: (cmd: string) => string;
  chatNotFound: (chatId: number) => string;
  recordNotFound: (rid: number) => string;
  recordNotClarifying: (rid: number) => string;
  clarifyAnswerRequired: string;
  clarifyTablesInvalid: string;
  clarifyTooManyTables: (max: number) => string;
  sqlSchemaInsufficient: string;
}

const ZH_CN: ChatMessages = {
  selectDatasource: '正在选择数据源',
  generateSql: '正在生成SQL',
  execSql: '正在执行SQL',
  generateChart: '正在生成图表',
  generateAnalysis: '正在生成分析',
  generatePredict: '正在生成预测',
  datasourceNotSelected: '未能选择数据源',
  noDatasource: '未选择数据源',
  datasourceRequired: '请先选择数据源',
  unsupportedEngine: '不支持的数据源类型',
  sqlGenNoResult: 'SQL 生成未返回结果',
  sqlGenFailed: 'SQL 生成失败',
  sqlEmpty: 'SQL 为空',
  sqlSafetyFailed: 'SQL 安全校验失败',
  filterGenFailed: '行权限过滤条件生成失败',
  filterSafetyFailed: '行权限 SQL 安全校验失败',
  sqlExecFailed: (detail) => `SQL 执行失败: ${detail}`,
  analysisNoResult: '分析生成未返回结果',
  predictNoResult: '预测生成未返回结果',
  secondaryNoResult: '该记录缺少SQL执行结果，无法分析',
  quickCmdMissingId: (cmd) => `请指定记录ID，如 /${cmd} 100`,
  chatNotFound: (chatId) => `对话 #${chatId} 不存在`,
  recordNotFound: (rid) => `记录 #${rid} 不存在`,
  recordNotClarifying: (rid) => `记录 #${rid} 不在待澄清状态`,
  clarifyAnswerRequired: '请选择候选表、填写补充说明，或选择跳过',
  clarifyTablesInvalid: '所选表不在澄清候选列表中',
  clarifyTooManyTables: (max) => `最多只能选择 ${max} 张表`,
  sqlSchemaInsufficient: '当前选定的表不足以回答该问题，请调整所选表后重试',
};

const EN: ChatMessages = {
  selectDatasource: 'Selecting datasource',
  generateSql: 'Generating SQL',
  execSql: 'Executing SQL',
  generateChart: 'Generating chart',
  generateAnalysis: 'Generating analysis',
  generatePredict: 'Generating prediction',
  datasourceNotSelected: 'Could not select a datasource',
  noDatasource: 'No datasource is selected',
  datasourceRequired: 'Select a datasource first',
  unsupportedEngine: 'Unsupported datasource type',
  sqlGenNoResult: 'SQL generation returned no result',
  sqlGenFailed: 'SQL generation failed',
  sqlEmpty: 'SQL is empty',
  sqlSafetyFailed: 'SQL safety check failed',
  filterGenFailed: 'Row-permission filter generation failed',
  filterSafetyFailed: 'Row-permission SQL safety check failed',
  sqlExecFailed: (detail) => `SQL execution failed: ${detail}`,
  analysisNoResult: 'Analysis returned no result',
  predictNoResult: 'Prediction returned no result',
  secondaryNoResult: 'The record has no SQL result to analyze yet',
  quickCmdMissingId: (cmd) => `Specify a record id, e.g. /${cmd} 100`,
  chatNotFound: (chatId) => `Chat #${chatId} not found`,
  recordNotFound: (rid) => `Record #${rid} not found`,
  recordNotClarifying: (rid) =>
    `Record #${rid} is not waiting for a clarification answer`,
  clarifyAnswerRequired: 'Pick candidate tables, add a supplement, or skip',
  clarifyTablesInvalid: 'Selected tables are not in the clarify candidates',
  clarifyTooManyTables: (max) => `Pick at most ${max} tables`,
  sqlSchemaInsufficient:
    'The selected tables cannot answer this question; adjust the selection and retry',
};

/** Resolve the message set for a language tag: 'zh-CN' → Chinese, anything
 *  else → English. */
export function chatMessages(lang: string): ChatMessages {
  return lang === 'zh-CN' ? ZH_CN : EN;
}
