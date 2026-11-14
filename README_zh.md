# QueryPrism

[English](README.md) | [简体中文](README_zh.md)

一个智能数据可视化聊天机器人，通过自然语言与数据库交互，自动生成图表。

## 功能特性

- 🔌 多数据源支持 - 连接和管理多个数据源
- 💬 智能对话 - 通过自然语言查询数据
- 📊 自动图表 - 根据查询结果自动选择并生成图表
- 📝 对话历史 - 保存最近20条对话记录
- 🔄 图表重生成 - 支持重新生成不同类型的图表
- 🧭 语义层治理 - 表/字段业务含义、指标口径与数据标准,三层级作用域 + 审批流,支持外部同步与 API 录入
- 🧠 20+ 大模型接入 - LangChain 原生集成(OpenAI、智谱GLM、Claude、Grok、Gemini、DeepSeek、Kimi、通义千问、Ollama、Groq、Mistral 等),另支持任意 OpenAI 兼容端点
- 🧪 语义回归测试 - 治理审批通过后自动重跑标准问题,用数据库端行数与数值汇总对比基准;join 扇出与口径放宽在用户看到错误数字之前被标记(`/set/regression`)
- 🛡️ LLM 字数预算与结果缓存 - 按用户/Agent 的每日 LLM 交互字数上限（输入提示词 + 输出内容，不是提问次数）、单次执行行数上限、可选的 SQL 结果缓存——Agent 流量打不爆账单(`/system/setting/quota`)

## 技术栈

### Backend
- **框架**: NestJS 11.x
- **语言**: TypeScript 5.x
- **数据库**: PostgreSQL 18 + pgvector
- **ORM**: Prisma 6.x

### Frontend
- **框架**: Vue 3.5.x
- **语言**: TypeScript 6.x
- **构建工具**: Vite 8.x
- **UI组件**: Element Plus
- **图表库**: AntV G2
- **状态管理**: Pinia
- **路由**: Vue Router 4.x

## 项目结构

```
QueryPrism/
├── backend/          # NestJS 后端 API
│   ├── prisma/      # 数据库模型和迁移
│   ├── src/
│   │   ├── datasource/  # 数据源管理模块
│   │   ├── chat/        # 聊天对话模块
│   │   └── common/      # 公共模块
│   └── test/        # 测试文件
└── frontend/         # Vue 3 前端应用
    ├── src/
    │   ├── views/      # 页面组件
    │   ├── stores/     # Pinia 状态管理
    │   ├── api/        # API 调用
    │   └── utils/      # 工具函数
```

## 快速开始

### 后端设置

先启动 PostgreSQL 18 + pgvector（推荐用 devcontainer；也可以只起数据库）：

```bash
# 仓库根目录：只启动数据库（宿主机开发）
docker compose up -d db

# 或者：Reopen in Container（自动启动 app + db，并安装依赖）
```

然后：

```bash
cd backend
pnpm install
pnpm run prisma:generate
pnpm run prisma:migrate
pnpm run start:dev
```

后端服务运行在: http://localhost:3000

### 前端设置

```bash
cd frontend
npm install
npm run dev
```

前端服务运行在: http://localhost:5173

### 默认登录账号

初次启动（执行过 `prisma:seed`）后可用的管理员账号：

| 账号 | 密码 |
| --- | --- |
| `admin` | `admin` |

> 注意：`123456` 是管理员在「用户管理」里重置其他用户密码时使用的默认密码（`DEFAULT_PWD`），不是 admin 的初始密码。

## 开发命令

### Backend

```bash
cd backend

# 开发模式
pnpm run start:dev

# 生产构建
pnpm run build

# 运行测试
pnpm run test
pnpm run test:e2e
pnpm run test:cov

# 代码检查和格式化
pnpm run lint
pnpm run format

# Prisma 相关
pnpm run prisma:studio    # 打开数据库管理界面
pnpm run prisma:generate  # 生成 Prisma Client
pnpm run prisma:migrate   # 运行数据库迁移
```

### Frontend

```bash
cd frontend

# 开发模式
npm run dev

# 生产构建
npm run build

# 预览构建结果
npm run preview
```

## API 文档

### 数据源管理 (`/api/datasource`)

- `POST /api/datasource` - 创建数据源
- `GET /api/datasource` - 获取所有数据源
- `GET /api/datasource/:id` - 获取单个数据源
- `PATCH /api/datasource/:id` - 更新数据源
- `DELETE /api/datasource/:id` - 删除数据源
- `POST /api/datasource/:id/test` - 测试数据源连接
- `POST /api/datasource/:id/sync` - 同步数据源表结构

### 聊天会话 (`/api/chat`)

- `POST /api/chat` - 创建新的聊天会话
- `GET /api/chat` - 获取最近的聊天会话（最多20条）
- `GET /api/chat/:id` - 获取单个聊天会话详情
- `DELETE /api/chat/:id` - 删除聊天会话

### 消息发送 (`/api/chat/:id/message`)

- `POST /api/chat/:id/message` - 发送消息并生成图表
- `POST /api/chat/:id/message/regenerate` - 重新生成图表

## 数据库模型

- **Datasource**: 数据源配置信息
- **Table**: 数据表结构
- **Field**: 表字段定义
- **Chat / ChatRecord**: 聊天会话与消息记录
- **向量索引**: `vector_store` schema 下的 `vec_*` 表（pgvector + HNSW，由应用维护）

## 环境配置

### Backend (.env)

```env
# 本地宿主机开发；devcontainer 内由 compose 覆盖为 db 主机
DATABASE_URL="postgresql://queryprism:queryprism@localhost:5432/queryprism"
FRONTEND_URL="http://localhost:5173"
PORT=3000
```

生产环境通过部署平台注入 `DATABASE_URL`，并在启动前执行：

```bash
cd backend
pnpm run prisma:deploy
NODE_ENV=production pnpm run prisma:seed   # 仅首次
node dist/src/main
```

### Frontend (.env)

```env
VITE_API_BASE_URL=http://localhost:3000/api
```

## 核心特性说明

- **数据源管理**: 支持连接数据库，自动同步表结构
- **智能SQL生成**: 基于 LLM 的 NL2SQL（LangChain，SSE 流式）
- **图表自动选择**: 由 LLM 选择图表类型，前端用 AntV G2 渲染
- **对话历史**: 保留最近20条对话记录
- **数据存储**: 查询结果和图表配置以JSON格式存储
- **向量检索**: PostgreSQL pgvector，支持术语/样例/表召回的混合检索
- **反问收敛（澄清）**: 问题在多张候选表（默认阈值 `clarify.table_threshold`=3）间有歧义且未点名任何表时，管线先反问用户选表/补充说明/跳过，再生成 SQL（`POST /chat/record/:rid/clarify` 恢复同一记录；MCP `ask_question` 返回 `needs_clarification` 支持两段式交互）。候选展示有效表语义（缺失时回退表注释）；`need_clarify` 暂停时把“召回但未塞入”的表列给 LLM，其点名的表通过 `suggested_table_ids` 回传并在卡片中预选（仅建议，恢复时仍强制 `max_select`）。每次暂停递增 `ChatRecord.clarifyRound`，`clarify.max_rounds`（默认 1）限制单条记录的追问轮数——大于 1 时预算内可继续反问，补充说明跨轮累积（表选择按最新一轮为准）。每次暂停的轮次会下发到客户端（SSE `clarify` 帧 `data.round`、持久化 clarify JSON 的 `round`、MCP `needs_clarification` 的 `round`），恢复时原样回传（`round` / `clarify_round`）；服务端在开始流式输出前用一次条件 `updateMany`（`clarifyStatus='pending'` + `clarifyRound=round`）抢占记录，因此重复点击、重试或过期轮次都匹配 0 行并直接返回 400，不会重跑管线（旧客户端不带 `round` 时仍为单写者抢占，只是无法按轮次收敛）
- **业务语义（M2）**: 表/字段业务含义三层 scope（个人 > 工作空间 > 全局，跨层修改走审批队列，每次保存留版本）——语义覆盖的问题仅把前 `semantic.max_tables`（默认 1）张表放入 SQL 提示词，LLM 可通过 `need_clarify` 请求更多表；有效语义会装饰每一次实际塞入的 schema（表含义、字段说明、枚举缓存），不只限于规则 2 截断的场景。录入渠道：管理页（`/set/semantic`）、Excel 导入导出、API Key 认证的 `POST /meta/semantic/import`。导入行支持 `scope`（默认工作空间）与 `enabled`；仅具备对应层级权限时直接写入（个人：仅本人，空间：空间管理员，全局：系统管理员），越权行逐行失败；导出包含 `scope` 列
- **Join 拓扑（M3）**: 关系编辑器的图（`Datasource.tableRelation`，按 X6 cells 原样存储）在读取时归一化为 FK 边——cell/port id 优先经同步的 Table/Field 行解析，画布标签兜底。SQL 提示词中的 FK 行只覆盖已塞入表的可见字段，BFS ≤2 跳的桥接表（连接被召回表的中间表）自动塞入（并加入澄清候选），多表问题带上真实 join 路径。每次保存关系同时追加版本快照（`POST /table_relation/versions/:dsId`）便于审阅，运行时仍读最新关系图；空间管理员还可将任一历史版本与当前图对比（`POST /table_relation/compare/:dsId`）并恢复（`POST /table_relation/restore/:dsId/:version`），恢复仅追加新版本、不改写历史并记入审计
- **维度枚举（M3）**: `role=dimension` 字段一键枚举采集——有界 DISTINCT 采样（`semantic.enum_scan_rows`，默认 10000）+ 低基数校验（`semantic.enum_max_values`，默认 50），回填带版本的 `enumValues` 缓存；按数据源限流 `semantic.enum_cooldown`（默认 60 秒）。重新采集时仍被采样到的值保留已有 `value|label` 标签，SQL 提示词按 `value(label)` 渲染。字段语义页管理按钮，`POST /system/semantic/collect_enum/:datasource_id`
- **指标体系（M4）**: 原子指标（绑定字段的聚合度量）、修饰词（统计范围过滤条件）、时间周期、派生指标与复合指标（对派生/复合指标编码做四则运算）——复用 M2 的三层 scope、审批队列与版本历史。问题命中指标（名称/别名）时，完整统计口径注入 generate_sql 提示词并强制纳入所需表（`metric.enabled` 开关，上限 `metric.max_definitions`，默认 5）。录入渠道：管理页（`/set/metric`）、六 sheet Excel 导入导出、API Key 认证的 `POST /meta/metric/import` 与 `POST /meta/standard/import`；导入行支持 `scope`（默认工作空间）与 `enabled`，遵循同样的逐层权限规则，导出包含 `scope` 列。匹配以字面优先：名称/别名命中永远优先，其后由指标向量（collection `vec_metric_def`，写入/审批后增量建索引、启动与手动回填补齐 NULL 行）补充剩余 `metric.max_definitions` 空位，只纳入余弦相似度严格高于 `metric.similarity_threshold`（默认 0.55）的原子指标；派生/复合指标仍需字面命中。embedding 或 pgvector 不可用时自动退化为纯字面匹配并记日志。复合指标为简单四则运算版，更深的组合留作后续扩展
- **数据标准（M4）**: 度量单位字典（advisory——供管理与自动补全）与命名词典（业务词/词根 → 标准译名），同一治理栈；命名词典命中时将 `<naming_rules>` 注入 SQL 提示词（`naming.enabled` 可关）
- **外部元数据同步（M5）**: 空间管理员可在 `/set/metadata-sync` 配置 HTTP API 或 MCP 拉取源，按与 `/meta/*` 相同的行格式导入（行可携带 `scope`；运行身份需具备目标层级的直接写权限），支持 5 段 cron 定时或立即执行；凭据 AES 加密且不回传，每次运行记录成功/失败行数与逐行失败明细。同一同步源的并发触发通过进程内 FIFO 队列串行执行，第二次触发会排队等待而不是重复运行。调度器按单实例设计（已知限制）

## 开发注意事项

- TypeScript版本不匹配: 前端使用TS 6.x，后端使用TS 5.x
- 修改Prisma schema后需运行 `prisma:generate` 重新生成Prisma Client
- 端口配置: 后端3000，前端5173
- CORS配置: 确保 `.env` 中 `FRONTEND_URL` 设置正确

## License

本项目采用 [GNU Affero 通用公共许可证 v3.0](LICENSE)（AGPL-3.0-only）授权，许可证全文见 [LICENSE](LICENSE)。