// Audit operation modules + types.

export enum OperationModule {
  USER = 'user',
  WORKSPACE = 'workspace',
  AI_MODEL = 'ai_model',
  DATASOURCE = 'datasource',
  CHAT = 'chat',
  TERMINOLOGY = 'terminology',
  DATA_TRAINING = 'data_training',
  DASHBOARD = 'dashboard',
  ASSISTANT = 'assistant',
  CUSTOM_PROMPT = 'custom_prompt',
  PERMISSION = 'ds_permission',
  SYSTEM_VARIABLE = 'system_variable',
  PARAMETER = 'parameter',
  API_KEY = 'api_key',
  AUTH = 'auth',
  EMBEDDING = 'embedding',
  MCP = 'mcp',
  SEMANTIC = 'semantic',
  METRIC = 'metric',
}

export enum OperationType {
  LOGIN = 'login',
  LOGOUT = 'logout',
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  IMPORT = 'import',
  EXPORT = 'export',
  TEST = 'test',
  SYNC = 'sync',
  ENABLE = 'enable',
  DISABLE = 'disable',
  RESET = 'reset',
}
