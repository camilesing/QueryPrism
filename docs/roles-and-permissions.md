# QueryPrism 角色与权限说明

> 适用范围：当前 `dev` 分支实现（2026-11-12）。本文以源码为准，逐条核对过路由守卫、菜单过滤与控制器 Guard。
>
> 结论来源：
>
> - 后端角色判定：`backend/src/auth/admin.guard.ts`、`backend/src/auth/ws-admin.guard.ts`、`backend/src/auth/jwt-auth.guard.ts`
> - 前端路由守卫：`frontend/src/router/watch.ts`、`frontend/src/router/dynamic.ts`
> - 前端菜单过滤：`frontend/src/components/layout/Menu.vue`、`frontend/src/components/layout/Person.vue`
> - 前端角色标记：`frontend/src/stores/user.ts`
> - 数据范围：`backend/src/permission/row-permission.service.ts`、`backend/src/chat/chat.service.ts`、`backend/src/dashboard/dashboard.service.ts`
>
> 修改权限相关代码时请同步更新本文，尤其是第 3、4 节的矩阵。

## 1. 角色模型

QueryPrism 没有数据库层面的角色字段，只有三种实际身份：

| 角色 | 判定方式 | 作用范围 |
|---|---|---|
| 系统管理员 | 硬编码 `uid === 1`（`ADMIN_UID`） | 全平台 |
| 空间管理员 | 当前工作空间的 `UserWs.weight !== 0`（DB 只允许 0/1） | 当前工作空间 |
| 普通用户 | 当前空间 `weight === 0`，且 `uid !== 1` | 当前工作空间 |

关键规则：

- JWT 每次请求都会从 DB 重新读取 `User.oid` 与当前空间的 `UserWs.weight`，因此移除成员、禁用账号、归档工作空间**立即生效**，不需要重新登录（`backend/src/auth/jwt-auth.guard.ts`）。
- 系统管理员可以进入任意已存在的工作空间（包括已归档空间）；非 uid 1 用户必须是该空间的成员，且空间未归档，否则 403。
- `WsAdminGuard` 对 uid 1 直接放行，其他人的判定是 `weight !== 0`（不是严格等于 1）。
- 前端：`isAdmin = uid === '1'`，`isSpaceAdmin = uid === '1' || !!weight`（`frontend/src/stores/user.ts`）。因此系统管理员天然拥有空间管理员能力。
- `weight` 只能由系统管理员通过 `PUT /system/workspace/uws` 调整；空间管理员添加成员时 `weight` 被强制为 0（`backend/src/workspace/workspace.service.ts`）。

## 2. 前端页面可见性

### 2.1 页面矩阵

| 页面 | 普通用户 | 空间管理员 | 系统管理员 |
|---|:---:|:---:|:---:|
| 数据问答 `/#/chat/index` | ✓ | ✓ | ✓ |
| 仪表盘 `/#/dashboard/index` | ✓ | ✓ | ✓ |
| 数据连接 `/#/ds/index` | ✗ | ✓ | ✓ |
| 应用集成 → 嵌入式 `/#/app-integration/embedded` | ✗ | ✓ | ✓ |
| 应用集成 → MCP `/#/app-integration/mcp` | ✗ | ✓ | ✓ |
| 设置 → 自定义提示词 `/#/set/prompt` | ✗ | ✓ | ✓ |
| 设置 → 语义层 `/#/set/semantic` | ✗ | ✓ | ✓ |
| 设置 → 指标体系 `/#/set/metric` | ✗ | ✓ | ✓ |
| 设置 → 元数据同步 `/#/set/metadata-sync` | ✗ | ✓ | ✓ |
| 设置 → 回归测试 `/#/set/regression` | ✗ | ✓ | ✓ |
| 系统管理 → 权限管控 → 工作空间 | ✗ | ✗ | ✓ |
| 系统管理 → 权限管控 → 成员管理 | ✗ | ✓ | ✓ |
| 系统管理 → 权限管控 → 权限配置 | ✗ | ✓ | ✓ |
| 系统管理 → 用户管理 | ✗ | ✗ | ✓ |
| 系统管理 → 模型配置 | ✗ | ✗ | ✓ |
| 系统管理 → 系统设置 → 外观 | ✗ | ✗ | ✓ |
| 系统管理 → 系统设置 → 参数 | ✗ | ✗ | ✓ |
| 系统管理 → 系统设置 → 系统变量 | ✗ | ✗ | ✓ |
| 系统管理 → 系统设置 → 查询预算 | ✗ | ✗ ⚠️ | ✓ |
| 系统管理 → 审计日志 | ✗ | ✗ | ✓ |

说明：

- `/dsTable/:dsId/:dsName` 是从对话中进入的表结构页，不在菜单里，所有登录用户可打开。
- `/canvas`、`/dashboard-preview`、`/assistant`、`/embeddedPage`、`/embeddedCommon` 等页面不在主导航中；嵌入/助手入口按 token 机制访问，不走上述角色矩阵。
- 普通用户菜单只有「数据问答」「仪表盘」；个人弹层提供修改密码、管理自己的 API Key、切换语言、关于/帮助。
- 空间管理员的「系统管理」只会显示权限管控下的「成员管理」「权限配置」两项。
- ⚠️ 查询预算当前有前后端不一致，见第 6.1 节。

### 2.2 路由与菜单实现

- 静态路由全部注册在 `frontend/src/router/index.ts`；`/ds` 与 `/app-integration` 是动态路由，只对 `isAdmin || isSpaceAdmin` 注册，普通用户会被 `reduceRouters` 移除（`frontend/src/router/dynamic.ts`）。
- 路由守卫 `watch.ts` 的 `accessCrossPermission` 决定实际可达性：
  - `/system/**`：仅 uid 1 可进；空间管理员只放行 `/system/permission-control/member` 与 `/system/permission-control/permission`。
  - `/set/**`：仅空间管理员（含系统管理员）可进。
  - `/ds/index`、`/app-integration/**`：仅空间管理员（含系统管理员）可进。
- 被拦截时的跳转：
  - 空间管理员访问 `/system/**` 其他页面 → `/system/permission-control/member`
  - 普通用户访问上述受限页面 → `/chat`
- 菜单过滤在 `Menu.vue`：非系统管理员进入 `/system` 时只渲染权限管控下的成员/权限两个子项；`/set` 仅在 `isSpaceAdmin` 时出现在一级菜单。

## 3. 后端 API 权限

后端没有全局 Guard，每个控制器自行声明 `@UseGuards(...)`，且 `AdminGuard` / `WsAdminGuard` 必须写在 `JwtAuthGuard` 之后。

### 3.1 按能力划分

| 能力 / 模块 | 普通用户 | 空间管理员 | 系统管理员 | Guard |
|---|:---:|:---:|:---:|---|
| 登录、个人资料、改密、切换工作空间 | ✓ | ✓ | ✓ | `JwtAuthGuard` |
| 对话、SSE、重新生成、澄清回答 | ✓ | ✓ | ✓ | `JwtAuthGuard` |
| 仪表盘 CRUD（仅自己的资源） | ✓ | ✓ | ✓ | `JwtAuthGuard` |
| API Key（仅自己的） | ✓ | ✓ | ✓ | `JwtAuthGuard` |
| `GET /datasource/list` | ✓（连接配置置空） | ✓ | ✓ | `JwtAuthGuard` |
| 数据源增删改、测试连接、同步表、选表、执行 SQL、Excel 导入、表关系版本 | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 自定义提示词 | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 嵌入式助手、MCP 集成配置 | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 行权限规则 `/ds_permission` | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 推荐问题（管理列表 / 保存） | ✗ | ✓ | ✓ | `WsAdminGuard`（对话侧 `get_datasource_recommended_base` 仅 `JwtAuthGuard`） |
| 元数据同步 `/system/metadata-sync` | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 回归测试 `/system/regression` | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 查询预算 `/system/quota` | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 语义层 / 指标 / 数据标准 | 读 + 个人层写（受治理） | ✓ | ✓ | `JwtAuthGuard` + 服务层治理 |
| 用户管理 | ✗ | ✗ | ✓ | `AdminGuard` |
| 查看/绑定/移除本空间普通成员 | ✗ | ✓ | ✓ | `WsAdminGuard` |
| 调整成员权重（设为空间管理员） | ✗ | ✗ | ✓ | `AdminGuard` |
| 工作空间创建/删除/归档/恢复 | ✗ | ✗ | ✓ | `AdminGuard` |
| AI 模型配置 | ✗ | ✗ | ✓ | `AdminGuard` |
| 外观保存 | ✗ | ✗ | ✓ | `AdminGuard` |
| 系统变量 | ✗ | ✗ | ✓ | `AdminGuard` |
| 参数保存（读取仅 JWT） | ✗ | ✗ | ✓ | `AdminGuard` |
| 审计日志 | ✗ | ✗ | ✓ | `AdminGuard` |
| `/meta/*`（语义/指标/标准导入、回归触发） | API Key | API Key | API Key | `ApiKeyGuard` |

### 3.2 语义层 / 指标 / 标准的特殊治理

这三个模块的控制器只挂 `JwtAuthGuard`，权限由服务层按「作用域 + 治理」判定，而不是靠 `WsAdminGuard`：

- 所有用户都能读。
- PERSONAL 层：用户可读写自己的行。
- WORKSPACE 层直接写：需要当前空间管理员；GLOBAL 层直接写：仅 uid 1。
- 非管理员跨层修改不会直接落库，而是生成 `SemanticChangeRequest`，由空间管理员或 uid 1 审批后生效。
- 因此「页面只有空间管理员能进」是 UI 限制，API 本身对普通用户开放读/提案入口。

## 4. 数据范围与行级安全

- **工作空间隔离**：所有业务行带 `oid`，租户数据查询必须过滤当前用户的 `oid`。
- **对话**：按 `createBy` 归属到用户，每人每空间最多保留 20 条会话（`maintainChatLimit`）。
- **仪表盘**：按 `createBy` 可见；uid 1 额外可见历史遗留的 `createBy = null` 行，但默认也看不到其他用户的资源。
- **数据源列表**：所有登录用户都能看到本空间数据源，但 `configuration` 连接配置只返回给 uid 1 / 空间管理员，普通用户拿到 `null`（前端持有解密能力，等同明文凭据）。
- **行级权限**：`RowPermissionService.isNormalUser` 的定义是 `user.id !== 1`，因此：
  - 普通用户受行权限规则过滤；
  - **空间管理员同样受行权限规则过滤**；
  - 只有系统管理员（uid 1）绕过行权限。
- **查询预算**：按主体解析（`assistant > agent > user`，再回落到 `default`），所有请求都会计入；回归任务以 `agent={type:'regression'}` 豁免。额度按 LLM 交互字符数计算。
- **嵌入 / MCP**：分别使用 `AssistantTokenGuard` 与 per-integration Bearer Token，不走用户角色体系。

## 5. 角色能力速查

| 能做什么 | 普通用户 | 空间管理员 | 系统管理员 |
|---|:---:|:---:|:---:|
| 提问、生成 SQL/图表、查看自己的历史 | ✓ | ✓ | ✓ |
| 创建/编辑自己的仪表盘 | ✓ | ✓ | ✓ |
| 选择工作空间内已接入的数据源提问 | ✓ | ✓ | ✓ |
| 接入/修改数据源、同步表结构、配置表关系 | ✗ | ✓ | ✓ |
| 维护提示词、语义/指标/标准 | ✗ | ✓ | ✓ |
| 配置嵌入助手、MCP 集成、推荐问题、行权限 | ✗ | ✓ | ✓ |
| 查看/维护元数据同步、回归测试、查询预算 | ✗ | ✓（预算见 6.1） | ✓ |
| 管理本空间成员（仅普通成员）与权限配置 | ✗ | ✓ | ✓ |
| 创建/删除/归档工作空间，调整成员为管理员 | ✗ | ✗ | ✓ |
| 管理用户、模型、外观、参数、系统变量、审计日志 | ✗ | ✗ | ✓ |
| 跨工作空间切换（含已归档空间） | ✗ | ✗ | ✓ |
| 绕过行级权限 | ✗ | ✗ | ✓ |

## 6. 已知差异与注意事项

### 6.1 查询预算页面的前后端权限不一致（当前未提交改动）

- 后端 `QuotaController` 使用 `WsAdminGuard`，设计意图是空间管理员可配置本空间预算。
- 前端当前未提交改动把页面从 `/set/quota` 移到了 `/system/setting/quota`（`frontend/src/router/index.ts`），并保留 `/set/quota` 重定向。
- 但 `watch.ts` 对非系统管理员只放行 `/system/permission-control/member|permission`，`Menu.vue` 也只渲染这两项。结果是空间管理员访问 `/set/quota` 会被重定向到 `/system/setting/quota`，再被弹回成员管理页。
- 处理方式二选一：
  1. 保持空间管理员可配置：在 `watch.ts` 的 `spaceAdminSystemRouterList` 加入 `/system/setting/quota`，并在 `Menu.vue` 中为空间管理员补上「系统设置 → 查询预算」入口；
  2. 明确改为系统管理员专属：把 `QuotaController` 改成 `AdminGuard`，并同步更新文档与 i18n 文案。

### 6.2 其他边界

- 系统管理员是硬编码 uid 1，不是可配置角色；新增管理员只能共用该账号或提升为空间管理员。
- `WsAdminGuard` 判断 `weight !== 0`，数据库层面目前只写入 0/1；若未来引入更多权重值，需要先明确语义。
- 行权限对空间管理员生效，配置行权限时不要把「空间管理员」默认为豁免对象。
- 前端角色判断依赖登录后 `user.info()` 返回的 `uid` / `weight`；切换工作空间后需要重新拉取用户信息，否则菜单与路由判断会停留在旧空间。
- 嵌入助手与 MCP 的调用主体不是用户角色，预算与审计按 `assistant` / `mcp_integration` 主体归属。

## 7. 变更指引

新增页面或接口时，至少同步检查以下位置：

1. 后端控制器：是否需要 `JwtAuthGuard`、`WsAdminGuard`、`AdminGuard`；Guard 顺序必须是 JWT 在前。
2. 前端静态路由 / 动态路由：新页面是否只对管理员注册（`dynamic.ts`）或需要在 `watch.ts` 中放行。
3. 菜单：`Menu.vue` 的系统菜单分支与 `/set` 分支是否需要新增项。
4. 数据范围：新表是否带 `oid`，查询是否过滤当前工作空间；写操作是否需要事务。
5. 测试：至少覆盖「普通用户 403 / 空间管理员 200（本空间）/ 跨空间 403 / 系统管理员 200」四类断言。
6. 文档：更新本文第 2、3 节的矩阵。