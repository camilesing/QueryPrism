# QueryPrism 实施计划

## 📋 项目概述

**项目名称**: QueryPrism
**项目目标**: 创建一个简版的SQLBot，专注于数据源管理和对话式数据分析
**开发周期**: 2-3周
**技术栈**: NestJS + TypeScript + SQLite + Prisma | Vue 3 + Element Plus + AntV G2

## 🎯 核心功能范围

### 功能包含
- ✅ 数据源管理 (CRUD + 连接测试 + 表同步)
- ✅ 对话系统 (自然语言查询 + 自动SQL生成)
- ✅ 自动图表生成 (智能图表选择)
- ✅ 对话历史管理 (最近20条)

### 功能不包含
- ❌ 导出功能 (PDF、图片、CSV、Excel)
- ❌ AI集成 (预留接口但不实现)
- ❌ 权限系统
- ❌ 数据预览功能
- ❌ 传统报表系统

## 🔧 技术架构

### 开发环境
- Node.js: v18+ (当前环境 v25.9.0)
- npm: v11.12.1
- 包管理器: pnpm (可用)
- TypeScript: 严格模式
- 代码规范: ESLint + Prettier

### 后端技术栈
- **框架**: NestJS 10.x
- **语言**: TypeScript 5.x
- **数据库**: SQLite (后续可迁移PostgreSQL)
- **ORM**: Prisma 5.x
- **API**: RESTful
- **端口**: 3000

### 前端技术栈
- **框架**: Vue 3.5.x
- **语言**: TypeScript 5.7.x
- **构建工具**: Vite 6.x
- **UI库**: Element Plus 2.10.x
- **图表库**: AntV G2 5.x
- **状态管理**: Pinia 3.x
- **HTTP客户端**: Axios 1.8.x
- **端口**: 5173

## 📁 项目结构

```
QueryPrism/
├── backend/                          # 后端项目
│   ├── src/
│   │   ├── datasource/               # 数据源模块
│   │   ├── chat/                    # 对话模块 (核心)
│   │   ├── database/                # 数据库模块
│   │   ├── common/                  # 公共模块
│   │   ├── config/                  # 配置模块
│   │   ├── app.module.ts
│   │   └── main.ts
│   ├── prisma/
│   │   └── schema.prisma           # 数据模型
│   ├── database/                   # SQLite数据库目录 (可配置)
│   │   └── dev.db
│   ├── .env                        # 环境变量
│   ├── .eslintrc.js              # ESLint配置
│   └── package.json
├── frontend/                       # 前端项目
│   ├── src/
│   │   ├── views/                # 页面组件
│   │   ├── components/           # 公共组件
│   │   ├── api/                  # API服务
│   │   ├── types/                # 类型定义
│   │   ├── stores/               # Pinia状态管理
│   │   ├── utils/                # 工具函数
│   │   ├── router/               # 路由配置
│   │   ├── App.vue
│   │   └── main.ts
│   ├── .env                      # 环境变量
│   ├── .eslintrc.cjs           # ESLint配置
│   └── package.json
└── README.md
```

## 🗄️ 数据模型设计

### Prisma Schema (prisma/schema.prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

// 数据源
model Datasource {
  id           Int      @id @default(autoincrement())
  name         String
  description  String?
  type         String   // mysql, postgresql, sqlite
  host         String?
  port         Int?
  database     String?
  username     String?
  password     String?
  schema       String?  // 数据库schema
  status       String   @default("active") // active, inactive, error
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tables       Table[]
  chats        Chat[]
}

// 表结构
model Table {
  id            Int      @id @default(autoincrement())
  datasourceId  Int
  datasource    Datasource @relation(fields: [datasourceId], references: [id], onDelete: Cascade)
  tableName     String
  tableComment  String?
  customComment String?
  checked       Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  fields        Field[]
}

// 字段结构
model Field {
  id            Int      @id @default(autoincrement())
  tableId       Int
  table         Table    @relation(fields: [tableId], references: [id], onDelete: Cascade)
  fieldName     String
  fieldType     String?
  fieldComment  String?
  customComment String?
  checked       Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

// 对话会话
model Chat {
  id           Int      @id @default(autoincrement())
  datasourceId Int
  datasource   Datasource @relation(fields: [datasourceId], references: [id], onDelete: Cascade)
  title        String   @default("新对话")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  messages     Message[]
}

// 消息记录
model Message {
  id        Int      @id @default(autoincrement())
  chatId    Int
  chat      Chat    @relation(fields: [chatId], references: [id], onDelete: Cascade)
  role      String   // user, assistant
  content   String
  sql       String?  // 生成的SQL
  result    String?  // JSON字符串存储查询结果
  chart     String?  // JSON字符串存储图表配置
  error     String?
  createdAt DateTime @default(now())
}
```

## 🚀 API端点设计

### 数据源管理API

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/datasource` | 创建数据源 | 公开 |
| GET | `/api/datasource` | 获取数据源列表 | 公开 |
| GET | `/api/datasource/:id` | 获取数据源详情 | 公开 |
| PUT | `/api/datasource/:id` | 更新数据源 | 公开 |
| DELETE | `/api/datasource/:id` | 删除数据源 | 公开 |
| POST | `/api/datasource/:id/test` | 测试连接 | 公开 |
| POST | `/api/datasource/:id/sync` | 同步表结构 | 公开 |

### 对话管理API

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/chat` | 创建新对话 | 公开 |
| GET | `/api/chat` | 获取对话列表(最近20个) | 公开 |
| GET | `/api/chat/:id` | 获取对话详情 | 公开 |
| DELETE | `/api/chat/:id` | 删除对话 | 公开 |
| PUT | `/api/chat/:id/title` | 修改对话标题 | 公开 |

### 消息交互API

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| POST | `/api/chat/:id/message` | 发送消息获取响应 | 公开 |
| POST | `/api/chat/:id/message/:messageId/regenerate` | 重新生成图表 | 公开 |

## ⏱️ 实施步骤

### Phase 1: 项目初始化 (95% 完成)

#### 1.1 后端初始化
- [x] 创建项目目录结构 `backend/`, `frontend/`
- [x] 初始化NestJS项目: `npx @nestjs/cli new backend`
- [x] 配置TypeScript严格模式
- [x] 配置ESLint + Prettier
- [x] 集成Prisma: `npm install prisma @prisma/client`
- [x] 初始化Prisma: `npx prisma init`
- [x] 设计并编写Prisma Schema
- [x] 配置SQLite数据库路径 (环境变量)
- [ ] 生成Prisma Client: `npx prisma generate` (等待依赖安装)
- [ ] 创建数据库迁移: `npx prisma migrate dev --name init` (等待依赖安装)
- [x] 设置全局异常处理过滤器 (基础版本)
- [x] 配置CORS中间件
- [x] 创建基础模块结构

#### 1.2 前端初始化
- [x] 创建Vue 3项目: `npm create vite@latest frontend`
- [x] 安装TypeScript: `npm install -D typescript`
- [x] 配置TypeScript严格模式
- [x] 配置ESLint + Prettier (参考SQLBot配置)
- [x] 安装Element Plus: `npm install element-plus`
- [x] 配置Element Plus自动导入
- [x] 安装AntV G2: `npm install @antv/g2`
- [x] 安装Pinia: `npm install pinia`
- [x] 配置Vue Router: `npm install vue-router`
- [x] 安装Axios: `npm install axios`
- [x] 配置Axios请求拦截器
- [x] 创建基础组件结构
- [x] 配置环境变量

### Phase 2: 数据源管理模块 (80% 完成)

#### 2.1 后端数据源模块
- [x] 创建Datasource实体 (Prisma Schema)
- [x] 创建Table实体 (Prisma Schema)
- [x] 创建Field实体 (Prisma Schema)
- [x] 创建DTO类 (CreateDatasourceDto, UpdateDatasourceDto, etc.)
- [x] 实现DatasourceService
  - [x] CRUD操作
  - [x] 数据库连接管理
  - [x] 连接测试功能
  - [x] 表结构同步功能
- [x] 实现DatasourceController
- [x] 创建数据库连接工具类
- [x] 实现表结构解析工具

#### 2.2 前端数据源模块
- [x] 创建数据源列表页面 `DataSourceList.vue` (DataSource.vue)
- [x] 创建数据源表单组件 `DataSourceForm.vue` (集成在DataSource.vue中)
- [ ] 实现表结构查看器 `TableViewer.vue` (待开发)
- [x] 创建数据源API服务 `api/datasource.ts`
- [x] 实现连接状态显示
- [x] 创建数据源类型选择器
- [x] 实现表单验证
- [x] 添加加载和错误状态处理

### Phase 3: 对话系统核心 (50% 完成)

#### 3.1 后端对话模块
- [x] 创建Chat实体
- [x] 创建Message实体
- [x] 创建DTO类 (CreateChatDto, CreateMessageDto, etc.)
- [x] 实现ChatService
  - [x] 对话会话管理
  - [x] 消息管理
- [x] 实现基于规则的SQL生成器
- [x] 实现自动图表分析器
- [x] 实现对话历史管理服务
- [x] 创建ChatController
- [x] 实现对话API端点

#### 3.2 前端对话模块
- [x] 创建对话主页面布局
- [x] 实现消息列表组件 `MessageList.vue` (集成在Chat.vue中)
- [x] 实现消息输入组件 `InputBox.vue` (集成在Chat.vue中)
- [x] 实现图表查看器组件 `ChartViewer.vue` (集成在Chat.vue中)
- [x] 实现数据表格组件 `DataTable.vue` (集成在Chat.vue中)
- [x] 创建对话API服务 `api/chat.ts`
- [x] 实现对话历史界面 `ChatHistory.vue`
- [x] 创建Chat.vue对话页面 (基础版本)

### Phase 4: 前端优化和测试 (未开始)
- [ ] 响应式设计
- [ ] 错误处理优化
- [ ] 性能优化
- [ ] 功能测试

### Phase 5: 部署准备 (未开始)
- [ ] Docker配置
- [ ] 文档编写

## 🔑 关键技术实现要点

### 1. 数据库路径配置

```typescript
// backend/.env
DATABASE_URL="file:./database/dev.db"
```

### 2. ESLint配置 (参考SQLBot)

```javascript
// backend/.eslintrc.js
module.exports = {
  extends: [
    '@nestjs/eslint-config',
    'prettier'
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    'prettier/prettier': 'warn'
  }
};
```

### 3. 基于规则的SQL生成

```typescript
class SqlGeneratorService {
  generateSql(question: string, schema: any): string {
    const patterns = {
      '查询.*表': (q: string) => `SELECT * FROM ${this.extractTableName(q)}`,
      '显示.*数量': (q: string) => `SELECT COUNT(*) FROM ${this.extractTableName(q)}`,
      // 更多规则...
    };
    // 匹配规则并生成SQL
  }
}
```

### 4. 自动图表分析

```typescript
class ChartAnalyzerService {
  analyzeChart(queryResult: any[], question: string): ChartConfig {
    const intent = this.analyzeIntent(question);
    const chartType = this.selectChartType(intent);
    return this.generateChartConfig(chartType, queryResult);
  }
}
```

## 📊 项目时间估算

| 阶段 | 工作量 | 累计时间 |
|------|--------|----------|
| Phase 1: 项目初始化 | 2-3天 | 2-3天 |
| Phase 2: 数据源管理 | 3-4天 | 5-7天 |
| Phase 3: 对话系统 | 5-6天 | 10-13天 |
| Phase 4: 前端优化 | 2-3天 | 12-16天 |
| Phase 5: 部署准备 | 1-2天 | 13-18天 |

**总计：2-3周**

## ✅ 验收标准

### 功能验收
- ✅ 能够创建、编辑、删除数据源
- ✅ 能够测试数据源连接并同步表结构
- ✅ 能够通过自然语言进行查询
- ✅ 能够自动生成合适的图表
- ✅ 对话历史限制为最近20条

### 质量验收
- ✅ 代码符合TypeScript严格模式
- ✅ 前端无ESLint错误
- ✅ 后端无TypeScript编译错误
- ✅ 基本的错误处理和用户提示
- ✅ 响应式设计支持移动端

## 📚 参考资源

### SQLBot项目参考
- 数据模型设计：`/backend/apps/datasource/models/datasource.py`
- 对话API实现：`/backend/apps/chat/api/chat.py`
- 前端对话界面：`/frontend/src/views/chat/index.vue`
- 数据源CRUD：`/backend/apps/datasource/crud/datasource.py`

### 技术文档
- NestJS官方文档
- Prisma文档
- Vue 3官方文档
- Element Plus文档
- AntV G2文档

## 🎯 下一步行动

1. **确认计划**：Review并确认实施计划
2. **开始实施**：开始Phase 1的项目初始化
3. **持续反馈**：每个阶段完成后汇报进度

---

**计划制定时间**: 2026-05-09
**预计完成时间**: 2-3周
**项目状态**: 待启动
