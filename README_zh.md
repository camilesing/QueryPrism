# QueryPrism

[English](README.md) | [简体中文](README_zh.md)

一个智能数据可视化聊天机器人，通过自然语言与数据库交互，自动生成图表。

## 功能特性

- 🔌 多数据源支持 - 连接和管理多个数据源
- 💬 智能对话 - 通过自然语言查询数据
- 📊 自动图表 - 根据查询结果自动选择并生成图表
- 📝 对话历史 - 保存最近20条对话记录
- 🔄 图表重生成 - 支持重新生成不同类型的图表

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
- **反问收敛（澄清）**: 问题在多张候选表（默认阈值 `clarify.table_threshold`=3）间有歧义且未点名任何表时，管线先反问用户选表/补充说明/跳过，再生成 SQL（`POST /chat/record/:rid/clarify` 恢复同一记录；MCP `ask_question` 返回 `needs_clarification` 支持两段式交互）
- **业务语义（M2）**: 表/字段业务含义三层 scope（个人 > 工作空间 > 全局，跨层修改走审批队列，每次保存留版本）——语义覆盖的问题仅把前 `semantic.max_tables`（默认 1）张表放入 SQL 提示词，LLM 可通过 `need_clarify` 请求更多表；录入渠道：管理页（`/set/semantic`）、Excel 导入导出、API Key 认证的 `POST /meta/semantic/import`

## 开发注意事项

- TypeScript版本不匹配: 前端使用TS 6.x，后端使用TS 5.x
- 修改Prisma schema后需运行 `prisma:generate` 重新生成Prisma Client
- 端口配置: 后端3000，前端5173
- CORS配置: 确保 `.env` 中 `FRONTEND_URL` 设置正确

## License

本项目采用 [GNU Affero 通用公共许可证 v3.0](LICENSE)（AGPL-3.0-only）授权，许可证全文见 [LICENSE](LICENSE)。