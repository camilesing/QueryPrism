# QueryPrism 全仓 Code Review 改进计划

- **日期**：2026-09-14（晚 20:00 定时任务产出）
- **输入**：一份全仓 code review 摘要（Top Issues ×10、Module Hotspots、Cross-Cutting Concerns、Quick Wins）
- **核实方法**：对本仓库当前工作区逐条比对源码（直接读取 + 3 个并行探索 agent），行号以当前代码为准
- **核实结论概览**：review 约 34 项主张中，**约 22 项属实、8 项部分属实、6 项不属实或需复核**（明细见[附录 A](#附录-a核实结果明细)）。所有 P0/P1 主张核心成立，均可直接进入修复；个别 Quick Win 因 SQLite 特性不适用，已给出替代方案

## 实施进度

- **批 1「安全止血」✅（2026-09-14 完成，commit ce27d418）**：P0-1（filter-tree 六项加固 + 保存期校验，偏离记录于 implementation-decisions.md §116.6）、P0-3（路径穿越白名单 + upload 内置校验）、P0-4（AdminGuard + UpdateLicenseDto）、P0-5（重置密码 AdminGuard + EMBEDDED_SIGN_DEV_SECRET 单一来源）、QW1/3/4/5/8。验证：`lint` 0 错误、单测 756/756、e2e 217/217、前端 `npm run build` 通过。e2e 中两处依赖旧行为的断言已按新语义更新（chat.e2e `recordIdFromSse` 改为顺序无关 JSON 解析；permission.e2e 的退化 `items:[1]` fixture 改为合法树）。注：`{license_key: 42}` 数字载荷因 `enableImplicitConversion` 会隐转通过——归入 P2-2（批 4）处理。P0-3 与 QW3 两处修复位于并发 WIP 文件（assistant-file.service.ts / parameter.service.ts），随 WIP 一并入库
- **批 2「密钥治理」✅（2026-09-14 完成）**：P0-2 apikey reveal-on-demand——列表 `secret_key` 掩码为 `''`，新增属主范围的 `GET /system/apikey/:id/secret`；前端 Apikey.vue 显示/复制改为按需拉取；e2e 旧「列表明文」契约替换为掩码 + reveal 四用例（401/属主/越权 404/未知 404），新增 apikey.service 单测。验证：lint 0 错误、单测 759/759、e2e 221/221、前端 build 通过。对 SQLBot 明文列表契约的有意偏离
- **批 3「数据完整性」✅（2026-09-14 完成）**：P1-1 事务化——permission.service（create/update/remove 全路径）、workspace.service（update/remove 查存在+写同事务；uwsCreate 去重读移入事务）、system-variable.service（save 查重+写同事务）、user.service（update + reconcileUserWorkspaces 同事务）；约定写入 AGENTS.md。P1-2——`Chat.datasourceId` 可空关系 `onDelete: Cascade → SetNull`（迁移 `20260914152517_chat_datasource_set_null`，数据保留式重建；Table/DsRecommendedProblem 必填关系保留 Cascade 并在 schema 注释说明）；datasource.e2e 新增「删数据源后 Chat 存活且 datasourceId=null」断言。P1-3——dashboard `listResource` 对管理员（uid 1）额外可见 `createBy IS NULL` 的遗留行。terminology 的原子化并入批 5（文件与 WIP 纠缠，届时重写导入管线时统一处理）。验证：lint 0 错误、单测 762/762、e2e 221/221；dev.db 迁移前备份、e2e 后恢复数据并重放迁移
- **批 4「正确性」✅（2026-09-14 完成）**：P2-1——新增 `common/utils/parse-int.ts`（`parseStrictInt`：拒绝 `''`/`null`/`true`/浮点/`0x`/越界，全量矩阵单测）并替换 6 处调用点（workspace 空白 keyword、system-variable `"abc"` id→400、custom-prompt `toIdList`、permission-snake-mapper `toNumberArray`、dashboard service+controller 5 处 `Number()`、sign-embedded CLI）。P2-2——`SavePermissionDto`（嵌套条目校验）与 `SaveSysVariableDto`（value 必须为数组）落地，缺 `users`/坏形状 → 400 而非 TypeError 500；common/dtos 六个数值字段补 `@IsInt()@Min()`（origin 枚举单独 `@Min(0)`）。P2-3——SseWriter 增加断连跟踪（`res.on('close')`，断后 send/ping no-op、`isClosed` 供排空循环早停）、背压（write false 时 await drain/close）、`ping()` 接入 chat 排空循环 15s keep-alive（finally 清理）。P2-5——llm `aesKey` 缺失时带可操作信息快速失败、env 回退模型 id 0 显式化为保留哨兵 `ENV_FALLBACK_MODEL_ID`、prompt.service YAML 读取/解析/结构三层错误上下文（template.yaml 值必须为字符串）、mcp-auth JWT 错误转 401 带原因（spec 断言同步更新）。验证：lint 0 错误（ai-model.controller 2 个既有 warning 留待批 7）、单测 770/770、e2e 221/221。注：`{license_key: 42}` 类数字→字符串隐转仍是 `enableImplicitConversion` 的全局行为，SQLBot 前端契约如此，保持
- **批 5「Excel 导入管线」✅（2026-09-14 完成）**：P2-4——schema 新增 `Terminology @@unique([oid, word])` 与 `CustomPrompt @@unique([oid, type, name])`（迁移 `20260914155818_terminology_customprompt_unique`，建唯一索引前先按 min(id) 去重存量、清理孤儿 synonym children；`name` 可空行不在键内）；两个导入器改为**自然键 upsert**（一次预载 file 内全部 word/name → id，命中即走更新路径并计入 `duplicate_count`，重导入幂等）；`advanced_application` 不再因 `specific_ds=false` 被静默丢弃（解析移出 specific_ds 分支）；terminology 导入 embedding 改为整文件**一次 `embedBatch`**（`upsert` 增加可选 `precomputedEmbedding`，新增 `safeEmbedBatch` 失败降级）；`xlsx.load` 两处包 try/catch → 400 带原因；user.service 4 处 `bcrypt.hashSync` → `await bcrypt.hash`（导入循环不再阻塞事件循环）；terminology/custom-prompt e2e 新增重导入幂等断言。验证：lint 0 错误、单测 770/770、e2e 221/221；dev.db 迁移前备份、验证后恢复。注：五个涉及文件与并发 WIP 纠缠，已按 hunk 精确提交我的改动段
- **批 6「性能与结构」✅（2026-09-15 完成）**：P3-1——迁移 `20260915000100_fk_indexes` 补 `Table.datasourceId`、`Field.tableId`、`DataTraining(oid, datasource)` 索引（EXPLAIN 已验证走索引）。P3-2——permission `createItems` 逐行 create → 一次 `createMany`；parameter save 逐行 upsert → 分桶（新键 createMany + 存量键逐个 update，随 WIP 文件入库）。P3-3——新建 `common/import-export/helpers.ts`（cellText / applyDsAdvFilters / 四个 name-map builder），terminology 与 custom-prompt 各删五份复制实现改引共享模块；system-variable `listFilter` 合一 listAll/listPage 的重复 where/orderBy；parameter 三处 mapper 收敛为 `toParameterItems`（随 WIP）。P3-5——user `pager` 无关键词路径下推 DB 分页（count+take/skip 事务），关键词路径保留相似度排序但先 SQL contains 预筛（只取命中行而非全表）。验证：lint 0 错误、单测 770/770、e2e 221/221；parameter spec 按分桶实现更新。注：user/terminology/custom-prompt 与 WIP 纠缠，按 hunk 提取提交；parameter.service(.spec) 的改动位于 WIP 重写文件内，随 WIP 入库
- **批 7「测试卫生 + 工具链」✅（2026-09-15 完成，全部批次收尾）**：工具链——`ai-model.controller` 两处浮动 promise（批 4 async send 的遗留）改 await；`vector.service` 一处 catch 模板字符串修正（strict 暴露）；eslint `globals.jest` 从生产 lint 范围收敛到 `src/**/*.spec.ts` + `test/**`；`endOfLine: 'lf'` + 根目录 `.gitattributes`；lint 脚本加 `--max-warnings 0`（当前 0 问题）；`tsconfig` 升级为完整 `"strict": true`（合并原有三个单项）+ 显式 include/exclude——构建与单测全绿，说明代码库本就只差这一处模板字符串。测试卫生——18 个 e2e 的 `login()` 全部补 `expect(res.status).toBe(200)`（app.e2e 内联登录同改）；三处固定 100ms sleep（audit/data-training/terminology 的 fire-and-forget 审计等待）改为共享 `test/helpers/wait-for.ts` 有界轮询（≤1s，按 `create_time >= 测试起点` 判落地）；9 处同义反复 `typeof res.text === 'string'` 断言（干净文件）改为非空体断言；apikey e2e 的 `firstId` 顺序依赖改为 `ensureFirstId()` 按需供给（乱序可执行）。验证：lint（--max-warnings 0）0 问题、单测 770/770、e2e 222/222、前端 build 通过。**遗留（明确不做/随 WIP）**：sweepAll 全表清空的结构化改造与路由 base 常量抽取（全部位于 WIP 纠缠 spec，收益/风险比低）；custom-prompt e2e 幂等断言、parameter 批量写/mapper 去重、`applyDsAdvFilters` 采纳（随 WIP 入库）

## 总结

七批全部完成（批 1 `ce27d418`、批 2 `5a7dd905`、批 3 `65151e16`、批 4 `42f71902`、批 5 `a17e90fa`、批 6 `cad3e5f7`、批 7 本次）。review 的 P0/P1/P2/P3 全量落地，其中因与并发 WIP 纠缠而「随 WIP 入库」的四处已在各批注明。最终状态：lint `--max-warnings 0` 零问题、TS strict 全开、单测 770、e2e 222、前端构建通过；数据库历经 4 次数据保留型迁移（SetNull、双唯一键、FK 索引）。

工作量标记：**S** ≈ 半天内，**M** ≈ 1–2 天，**L** ≈ 3 天以上（含测试）。

---

## 一、P0 安全（第一批，最高优先）

### P0-1 行级权限过滤引擎：SQL 注入 + fail-open + 语义反转

**问题与影响**（全部核实属实，`backend/src/permission/filter-tree.ts`）：

| 缺陷 | 位置 | 后果 |
|---|---|---|
| `quoteIdentifier` 不转义内嵌引号 | `filter-tree.ts:158-161` | `fieldName` 含 `"` 或反引号即可逃逸 quoting，向生成的 WHERE 片段注入任意 SQL（片段经 `row-permission.service.ts:117-118` 拼入查询） |
| 转换结果为 null 时 **fail-open** | `filter-tree.ts:204,218,225,231` → `177-179` | 字段查不到 / `value_type==='variable'` / enum 空值 → 该条件被**静默跳过**；全部树为 null → 整表**无行级过滤**（权限放大） |
| enum 分支无视 `term` 恒发 `IN` | `filter-tree.ts:227-233` | 管理员配的 `not in` 被反转为 `IN`（权限放大），注释自认 "whereTerm is ignored" |
| `between` 落入单操作数分支 | `filter-tree.ts:248-252` | 产出 `BETWEEN 'x'` 语法错误 SQL（注释自认镜像了 SQLBot 的 quirk） |
| LIKE 通配符未转义 | `filter-tree.ts:247` | 值里的 `%`/`_` 成为通配符；`escapeSqlValue:110-112` 无条件双写反斜杠，在 PG 标准字符串下会破坏含 `\` 的字面量 |

**修复方案**：
1. `quoteIdentifier`：内嵌引号双写（MySQL → `` ` `` 双写，其余 → `"` 双写）；并在 Field 同步/保存入口对 `fieldName` 做 `^[A-Za-z0-9_$\u4e00-\u9fa5]+$` 白名单校验（纵深防御）。
2. **fail-closed 策略**：区分「该用户无任何匹配规则」（维持现状：无过滤，SQLBot 语义）与「有规则但无法渲染」（改为拒绝：渲染结果为 deny 片段 `1 = 0` 或直接抛错），在 `row-permission.service.ts` 层落地；同时 `permission.service` 保存时校验拒绝存储 `value_type==='variable'` 的 deferred 项，而不是存进去再静默丢。
3. enum 分支按 `term` 分发 `IN` / `NOT IN`。
4. `between` 按逗号拆分为 `BETWEEN 'a' AND 'b'`；操作数 ≠2 时保存期报错。
5. LIKE 值转义 `%`/`_`/转义字符；反斜杠双写改为按引擎（仅 MySQL）。

**配套测试**：`filter-tree.spec.ts` 新增注入用例（fieldName 带 `"`、反引号、null byte）、enum `not in`、`between` 双操作数、LIKE 通配符；`row-permission.service.spec.ts` 新增 fail-closed 用例。

**工作量**：M。**验收标准**：注入向量全部产出安全片段；不可渲染规则使查询被拒而非放行；`pnpm run test` 全绿。注：以上是对 SQLBot 逐字移植（§116）的**有意偏离**，需同步更新 `implementation-decisions.md` 的 deviation 清单。

### P0-2 ApiKey 列表明文批量暴露 secret_key

**问题与影响**（属实）：`ApiKeyService.findAll`（`backend/src/apikey/apikey.service.ts:53-67`）对用户**每个 key** 解密并返回明文 `secret_key`，经 `apikey-snake-mapper.ts:47-55` 出参；`backend/test/apikey.e2e-spec.ts:102-120` 把该契约固化；前端 `frontend/src/components/layout/Apikey.vue:56,174-182` 直接从列表行读取明文（toggle 显示 + 复制）。任何 XSS/日志泄漏即批量泄漏全部密钥。注：注释自述这是对齐 SQLBot 前端契约的**有意决策（§99）**，修复需前后端同改并记录偏离。

**修复方案**：
1. 列表接口不再返回明文：`secret_key` 出参替换为掩码（如 `''` 或 `****`，保留字段名以兼容前端列）。
2. 新增 reveal-on-demand 端点：`GET /apikey/:id/secret`（ownership-scoped，404 防枚举），返回单 key 明文。
3. 前端 `Apikey.vue`：reveal 开关/复制按钮改为调用该端点按需取值，列表行不再持有明文。
4. e2e 改造：列表断言 `secret_key` 为空/掩码；新增 reveal 端点用例（属主 200、非属主 404）。

**工作量**：M（后端 S + 前端 S + 测试）。**验收标准**：`GET /apikey` 响应体中不出现任何明文 secret；reveal 端点仅属主可用；前端显示/复制功能回归正常。

### P0-3 Assistant 文件服务路径穿越 + 校验解耦

**问题与影响**（属实）：`pathFor`（`backend/src/assistant/assistant-file.service.ts:90-93`）仅剥 `/` 和 `\`，`..`、`.`、null byte 均可穿透 `join()`，`GET /system/assistant/picture/:file_id` 可读 `uploadDir` 之外任意文件；`exists('..')` 因父目录可 access 而返回 true。`upload()`（:79-85）自身不强制 `checkFile()`——核实发现当前唯一调用点 `assistant.service.ts:232` **有**调用，故「任意路由可存任意内容」目前是设计耦合风险而非现实漏洞，并入本项加固。

**修复方案**：
1. `pathFor`：fileId 严格白名单 `/^[0-9a-f]{16}(\.(jpg|jpeg|png))?$/i`（与生成的 id 形制一致），不匹配直接拒绝；叠加 `resolve()` 后必须以 `uploadDir + path.sep` 为前缀的双保险。
2. `exists()`：改用 `fs.stat()` 且要求 `isFile()`（目录不算存在）。
3. `upload()`：内部强制调用 `checkFile()`（纵深防御，调用方无需记得调用）；可选加 JPG/PNG 魔数嗅探。

**配套测试**：`assistant-file.service.spec.ts` 穿越向量用例（`..`、`../..`、`.`、null byte、绝对路径、`foo/../bar`、反斜杠）；`exists('..')` 为 false；e2e `/picture/..%2f..` 类请求 404。

**工作量**：S。**验收标准**：所有穿越向量被拒；正常上传/替换/删除流程 e2e 不回归。

### P0-4 License 接口越权 + 载荷零校验

**问题与影响**（属实）：`POST /system/license`（`backend/src/license/license.controller.ts:64-68`）仅有 `JwtAuthGuard`，任意登录用户可替换 license；`LicenseUpdateBody` 是运行时被擦除的纯 interface，载荷完全不校验。头注释自认 "admin-specific enforcement deferred (§113)"。仓库无现成 AdminGuard（`assistant-token.guard.ts:187` 已有 uid 1 + account 'admin' 的 admin 语义可参照；前端 `stores/user.ts:67` 同为 uid===1）。

**修复方案**：新建 `AdminGuard`（uid === 1，语义与 `assistant-token.guard.ts` 一致）挂到 POST 路由；`LicenseUpdateBody` 改为带 `class-validator` 装饰器的 DTO class。

**配套测试**：e2e 非管理员 POST → 403、管理员 → 200、畸形载荷 → 400。

**工作量**：S。**验收标准**：非 uid 1 用户无法触发 license 更新；非法载荷 400 而非透传。

### P0-5 凭据卫生：默认弱密码端点越权 + HMAC dev secret 重复

**问题与影响**（核实后**升级**为账号接管）：`DEFAULT_PWD='123456'`（`backend/src/user/user.service.ts:59`）；`resetToDefaultPassword`（:289-297）的路由 `PATCH /user/pwd/:id`（`user.controller.ts:219-227`）仅 `JwtAuthGuard` —— **任意登录用户可把任意账号（含 uid 1 管理员）重置为 123456 再登录**，构成纵向越权。`GET /user/defaultPwd`（:101-104）明文下发默认密码（`login.initial_pwd_hidden` 可关，SQLBot 契约，保留但文档化）。HMAC dev secret：`configuration.ts:29-35` 的 env 回退默认值与 `backend/scripts/sign-embedded.ts:46` 的回退重复（「e2e 三处复制」经核实**不成立**——spec 复用 `signEnvelope`），存在漂移风险。

**修复方案**：`PATCH /user/pwd/:id` 挂 P0-4 的 AdminGuard；dev 回退 secret 收敛为单一导出常量模块（config 与 script 共同 import）；`getDefaultPwd` 行为保留但在 AGENTS.md/安全文档记录明文下发的前提。

**配套测试**：e2e 非管理员重置他人密码 → 403；管理员重置 → 200。

**工作量**：S。**验收标准**：普通用户无法重置他人密码；secret 默认值仅存在一处。

---

## 二、P1 数据完整性（第二批）

### P1-1 非事务多步写与 check-then-act 竞态

**问题与影响**（全部属实）：
- `permission.service.ts:109-116`：`deleteMany → update → createItems` 三次独立 await，中途失败**永久丢失**该组规则（create/remove 路径 :100-103、:132-133 同样裸奔）。
- `user.service.ts:226-229`：`update` 与 `reconcileUserWorkspaces` 两次独立 await（对比 `create` :177-199 有事务）。
- `workspace.service.ts:64-65,77-82`：先 `findOne` 再 update/remove 无事务；`uwsCreate:264-287` 的 findMany 查重在 `$transaction` **之外**。
- `terminology.service.ts` upsert 路径、`system-variable.service.ts` save 路径同类。

**修复方案**：统一包 `prisma.$transaction`；查重逻辑移入事务内（或改 `upsert`，参照 `uwsUpdate:298` 已有写法）。修复模式沉淀为约定写入 AGENTS.md（"多步写必须 $transaction"）。

**配套测试**：单测 mock 事务中段抛错，断言无半状态；现有 e2e 回归。

**工作量**：M。**验收标准**：上述 5 个服务的多步写全部原子；e2e 全绿。

### P1-2 Datasource 级联删除策略

**问题与影响**（部分属实）：`Chat.datasourceId Int?` + `onDelete: Cascade`（`schema.prisma:82-83`）——**可空**关系上挂 Cascade，`DatasourceService.remove()`（`datasource.service.ts:174-177`）删数据源即清空该源全部 Chat（「稍后再选数据源」语义被毁灭性删除打破）；`Table.datasourceId` 为**必填**（:39-40，review 称可空不属实），必填级联相对可辩护；`DsRecommendedProblem`（:73）同样 Cascade。前端 `chat/index.vue:651`、`ChatListContainer.vue:129` 已有管理员确认弹窗，与后端毁灭性行为不匹配。

**修复方案**：逐关系定策——可空的改 `SetNull`（Chat 保留、`datasourceId` 置空，符合「稍后再选」）；必填的 Table/Field 保留 Cascade 或改 `Restrict`+显式确认；产出一次 Prisma 迁移。历史已删数据不可恢复，属既成事实（dev 阶段）。

**配套测试**：e2e 删除数据源后断言 Chat 仍在且 `datasourceId` 为 null。

**工作量**：M。**验收标准**：删除数据源不再静默清空聊天；迁移可重复执行。

### P1-3 历史迁移数据丢失的补救

**问题与影响**（属实，均为既成损失/不可见）：
- phase2（`20260723005041_.../migration.sql`）：`INSERT INTO new_Datasource` 列清单丢弃全部既有连接凭证（host/port/user/password 等）。
- phase5（`20260723060000_...`）：Message 拆 ChatRecord 时 `1 AS "oid"` 硬编码，全部 legacy chat 归到 oid 1。
- dashboard 契约迁移（`20260726100000_...`）：新增可空 `createBy` 无 backfill，而 `dashboard.service.ts:117` 过滤 `{ oid, createBy: uid }` → `createBy=NULL` 的行**永久不可见**。
- 「dev.db has 0 rows」假设（`20260726110000_...:5-6`）在 dev 阶段成立，上线前必须清除这类假设。

**修复方案**（不改历史迁移，新增纠正迁移/代码兜底）：
1. dashboard：查询侧兜底 —— `createBy IS NULL` 的行对 workspace 管理员（uid 1）可见，或纠正迁移按业务映射回填 `createBy`；二选一，倾向查询侧（数据无主可回填）。
2. phase5 oid：若存在多 workspace 真实数据，按 Chat 原属信息纠正回填；dev-only 数据则记录已知问题即可。
3. phase2 凭证：无法找回，在部署文档标注「升级到该版本前必须导出连接配置」。
4. 流程改进：破坏性迁移前 `cp database/dev.db` 快照；AGENTS.md 增补迁移评审清单（禁 hardcode oid、禁无 backfill 的可空列）。

**工作量**：S–M。**验收标准**：NULL `createBy` 的 dashboard 行不再对管理员不可见；迁移清单落文档。

---

## 三、P2 正确性（第四批）

### P2-1 统一严格整数解析，替换全部 `Number()` + NaN 守卫

**问题与影响**（属实，6 处）：`workspace.service.ts:228-230`（空白 keyword → `Number('')===0` → `{id:0}` 绑定任意用户；`Number(null)` 分支经核实不可达——controller 有空守卫）；`system-variable.service.ts:92,103`（`"abc"` → NaN → 落 CREATE 分支静默新建）；`custom-prompt.service.ts:100-103`（`toIdList` 放过 `Number('')/Number(null)===0`）；`permission-snake-mapper.ts:94-97`（`toNumberArray` 把 `[null,'',1]` 变 `[0,0,1]` 伪造 uid）；`dashboard.service.ts:273` + controller 多处裸 `Number(body.id)`（NaN 进 Prisma filter → 500）；`backend/scripts/sign-embedded.ts:64-65`（`1.5`/`-1`/`0x10` 均被签名，dev 工具，低危）。

**修复方案**：新增 `backend/src/common/utils/parse-int.ts`：`parseStrictInt(v): number | null`（仅接受整数字符串/整数，拒绝 `''`、`null`、`true`、浮点、`0x` 前缀），替换上述全部调用点；dashboard NaN → 400。

**配套测试**：工具单测矩阵 + 各调用点边界用例（空白 keyword、`"abc"` id、`[null,'',1]`）。

**工作量**：S–M。**验收标准**：全仓 `grep "Number(" 生产代码仅剩合法用途；上述边界输入不再产生 0/1/NaN 污染。

### P2-2 ValidationPipe 缺口与弱 DTO

**问题与影响**（属实）：`PermissionSaveBody`（`permission.service.ts:44-49`）与 `SysVariableSaveBody`（`system-variable.service.ts:39-44`）是纯 interface（注释自认 "ValidationPipe passthrough"）——缺 `body.users` 时 `permission.service.ts:96→186` 抛 TypeError(500)；`value:"oops"` 被 `as Prisma.InputJsonValue` 盲写（:109,120）。`src/common/dtos/` 全目录无 `@IsInt()`/`@Min(1)`（`delete-chat.dto.ts:7-9`、`start-chat.dto.ts:9,13`、`question.dto.ts:8,17`、`rename-chat.dto.ts:7`、`regenerate-chat.dto.ts:9`、`create-chat.dto.ts:7`），`app.module.ts:116-120` 的 `enableImplicitConversion` 使 `"1e3"` 隐转后通过。

**修复方案**：两个 interface 升级为 class-validator DTO；公共 DTO 数值字段补 `@IsInt() @Min(1)`；复核 `enableImplicitConversion` 对字符串数字的容忍是否符合预期（`"1e3"`→1000 通过 `@IsInt` 在语义上可接受，但 `"abc"` 必须被拒）。

**配套测试**：e2e 缺字段/畸形类型载荷 → 400 而非 500。

**工作量**：M。**验收标准**：无接口因缺字段抛 5xx；数值字段拒收浮点/负数/非数字串。

### P2-3 SseWriter 三缺陷

**问题与影响**（部分属实）：spread 顺序 `{ type, ...data }`（`sse-writer.ts:35`）让 `data.type` **覆盖**事件类型——与 JSDoc（:29-33）宣称相反，破坏前端事件路由（属实）；无 `res.on('close')` 处理，断连后写挤爆缓冲（属实）；`res.write()` 返回值被忽略，长 LLM 流无背压（属实）；`ping()`（:40-42）为生产死代码（属实）。**「sse.send 在 try/catch 之外」不属实**：`chat.controller.ts:285-292` 首拉有 try、:296-303 循环内 gen 错误有 catch 并转 error 帧。

**修复方案**：spread 改 `{ ...data, type }` 并更新 JSDoc；构造器注册 `res.on('close')` 置 closed 标记，`send()`/`close()` 对已断连 no-op；`send()` 检查 `write()` 返回 false 时暂停推送（简单实现：异步 send + `await once(res,'drain')`，或维护队列）；`ping()` 二选一——删掉，或接入 stream 循环作为长调用 keep-alive（推荐后者，物尽其用）。

**配套测试**：单测：`data.type` 不可覆盖事件 type、close 后 send 不抛不写、背压模拟；流式 e2e 回归。

**工作量**：S–M。**验收标准**：事件路由不再被 payload 劫持；客户端断开后服务端不积累内存、不抛错。

### P2-4 Excel 导入管线（terminology / custom-prompt / user 三处）

**问题与影响**（属实）：
- 重复导入不去重：`terminology.service.ts:479` 逐行 `upsert` 但 Excel 行无 id 全走 create，schema 无 `@@unique([oid, word])` → 重复建行（`custom-prompt.service.ts:377-410` 同款，缺 `@@unique([oid, type, name])`）。
- `specific_ds=false` 时静默丢 `advanced_application`：`terminology.service.ts:475-478`、`custom-prompt.service.ts:398-401`。
- N 次顺序 await：terminology 每行一次 embedding 网络往返（:452-487，`embedBatch` 已存在于 `embedding.service.ts:64` 未用）；`user.service.ts:422` 循环内 `bcrypt.hashSync` 阻塞事件循环（每行另有独立事务）。
- `xlsx.load`（`terminology.service.ts:397`）抛错经全局 `HttpExceptionFilter` 变成**无上下文** 500（过滤器存在但缺文件上下文）。

**修复方案**：
1. schema 增 `@@unique`（先出纠正迁移去重存量：同 key 保留最早行）；导入改按自然键 upsert，导入结果返回 `duplicate_count`/`skipped`。
2. `advanced_application`：**保留不丢**（使用期仅在 `specific_ds=true` 时生效）；或至少在导入结果中显式提示被丢弃——倾向前者。
3. terminology 导入改 `embedBatch` 批量向量化；`bcrypt.hashSync` → `bcrypt.hash`（异步），行处理分批入事务。
4. `xlsx.load` 包 try/catch → `BadRequestException('Excel 文件解析失败: <文件名>')`。

**配套测试**：同文件二次导入行数不翻倍、`advanced_application` 保留、损坏 xlsx → 400 带文件名。

**工作量**：L（含迁移）。**验收标准**：幂等重导入；无静默数据丢失；解析失败有可读错误。

### P2-5 错误透明化（llm / prompt / mcp-auth / Prisma NaN）

**问题与影响**（大部分属实）：`llm.service.ts:89-91` `aes.key` 非空断言 `!` → 未配置时 `decrypt` 晦涩失败；:130-150 env 回退**伪造 `id:0` 模型**；:186 `total_tokens ?? 0` 未用 `input+output` 兜底；`prompt.service.ts:78-81` YAML 无结构校验直接 `as T` 消费（**「ENOENT 静默替换 ''」不属实**——ENOENT 直接抛出，'' 是 `renderTemplate:30` 缺 token 行为）；`mcp-auth.helper.ts` 原样透出 "jwt malformed"。`extract-json.ts` fragment fallback **核实不属实**（`extract-json.ts:52-70` 失败返回 null），无需处理。

**修复方案**：`aes.key`/关键 env 在 `configuration.ts` 启动期校验（fail-fast + 明确报错信息）；假模型回退改为显式 "not configured" 哨兵并由调用方处理；`total_tokens` 缺失用 `input_tokens + output_tokens`；prompt YAML 加最小 schema 校验（字段存在性 + 类型）；mcp-auth 捕获 JWT 错误转 401 带上下文；Prisma NaN 由 P2-1 消灭。

**工作量**：M。**验收标准**：缺配置启动即失败且信息可读；流式 usage 统计不再恒 0。

---

## 四、P3 性能与可维护性（第六批）

### P3-1 缺失索引（含迁移）

**问题与影响**（属实）：`Table.datasourceId`（`schema.prisma:37-51` 无任何 `@@index`）、`Field.tableId`（:54-67 同）、`DataTraining` 缺 `(oid, datasource)` 复合索引（:346-347 仅单列）。SQLite/Prisma 不自动为 FK 建索引（review 称 `20260519093200` 有此注释——**该注释不存在**，但索引缺口本身属实）。

**修复方案**：schema 增 `@@index([datasourceId])`（Table）、`@@index([tableId])`（Field）、`@@index([oid, datasource])`（DataTraining，可替换单列 `[oid]`）；走标准 `pnpm run prisma:migrate` 流程。

**配套测试**：`EXPLAIN QUERY PLAN` 断言走索引（集成测试）。

**工作量**：S。**验收标准**：迁移后同步表/字段/训练数据查询计划使用索引。

### P3-2 顺序 await 与内存分页

**问题与影响**（属实）：`parameter.service.ts:103-115` 事务内逐行 upsert；`permission.service.ts` `createItems` 逐条；`user.service.ts:97-105` `pager()` 全表 `findMany`（含 workspace include）后内存 `slice`，关键字路径 :112-142 同样全量取回打分。

**修复方案**：parameter 改分桶 `createMany`/`updateMany`；permission 批量 createMany；pager 改 DB 侧 `take/skip` + `contains` 过滤（SQLite 大小写敏感限制见附录 A-7 说明）。

**工作量**：M。**验收标准**：导入千行级参数耗时数量级下降；用户列表分页不再随表增长线性变慢。

### P3-3 重复代码抽取

**问题与影响**（属实部分）：terminology 与 custom-prompt 之间 5 组成对复制（`applyListFilters` 606-628 vs 471-493、`buildDatasourceNamesMap` 653 vs 514、`buildAdvancedAppNamesMap` 672 vs 533、name→id maps 694/704 vs 555/565、`cellText` 829 vs 587）；`system-variable.service.ts:54-56/70-72` where-builder 逐字重复；`parameter.service.ts:82-85/93-96/119-122` mapper ×3；e2e 路由 base `/api/v1` 每 spec 硬编码 11–29 次。**「embedded-sign 三处复制」「binaryParser 跨 spec 复制」核实不属实**（前者仅 1 处且复用 `signEnvelope`，后者同文件内 2 处）。

**修复方案**：抽 `src/common/import-export/` 共享 helper（terminology/custom-prompt）；system-variable where-builder 合一；parameter mapper 提函数；`test/helpers/routes.ts` 统一路由常量。

**工作量**：M。**验收标准**：上述重复归一，行为零变化（纯重构批次，测试全绿即达）。

### P3-4 工具链收紧（放最后，避免噪声掩盖业务修复）

**问题与影响**（基本属实）：`tsconfig.json` 无 `"strict": true`、无 include/exclude；`eslint.config.mjs:30-31` `no-floating-promises`/`no-unsafe-argument` 仅 warn 而 lint 脚本无 `--max-warnings 0`（:14-25 行 `globals.jest` 注入生产 lint 范围；:29 `no-explicit-any` off）；`package.json` 含未用依赖 `sqlite3`(:60)/`p-queue`(:55)，`pnpm.onlyBuiltDependencies`(:30-35) 仍列 sqlite3，prisma(:84)/@prisma/client(:45) 未钉同版本；`pnpm-workspace.yaml` 用无效键 `allowBuilds`（package.json 内的 `onlyBuiltDependencies` 是有效兜底）；无 `.gitattributes`，`endOfLine:"auto"` 在 `eslint.config.mjs:42`（review 说是 `.prettierrc`——位置有误）。

**修复方案**：按序：删未用依赖 → `allowBuilds`→`onlyBuiltDependencies` → prisma 钉精确同版 → jest globals 限定 `test/**` → lint 加 `--max-warnings 0`（先清零存量 warn）→ `strict: true`（增量修暴露错误）→ `endOfLine:'lf'` + `.gitattributes`。

**工作量**：S–M（strict 视暴露错误量可能到 M）。**验收标准**：`pnpm run lint` 无警告也失败于警告；两套 TS 配置 strict 全开编译通过。

---

## 五、测试卫生（贯穿各批，随对应修复同步做）

核实属实项：
- **login() 无成功断言**：全部 18 个 spec 直接 `return res.body.data.access_token`（如 `apikey.e2e-spec.ts:28-37`）→ 共享 helper 内断言 `status===200` 且有 token。
- **无范围全表清空**：`assistant.e2e-spec.ts:66-76`、`embedded.e2e-spec.ts:65-75`（sweepAll）、`apikey.e2e-spec.ts:56-64`，另 `audit/data-training/terminology` 直连 `deleteMany({})` → 改 `createdIds` 范围清理，**停止把 e2e 当 dev.db 清洁器**。
- **同义反复断言** ×13（`typeof res.text === 'string'`）→ 换成 status + 响应结构断言。
- **固定 100ms sleep**（`audit.e2e-spec.ts:272-274`、`data-training.e2e-spec.ts:357`、`terminology.e2e-spec.ts:389`）→ 有界轮询（超时上限断言失败）。
- **顺序依赖状态**：`apikey.e2e-spec.ts:98` 的 `firstId` 跨 4 个 it → 每个 it 自建或 beforeAll 显式准备。
- **过时注释**：`ai-model.e2e-spec.ts:189-190` 的 unused-m 抑制注释（m 实际已被使用）→ 删除。

工作量：M（增量分摊）。验收标准：e2e 可乱序执行、可重复执行不依赖外部 dev.db 状态。

## 六、文档漂移清单（S，随手修）

| 位置 | 修复 |
|---|---|
| `mcp.module.ts:2` | "the 5 tools" → 6（`mcp.service.ts` 实际 6 个 registerTool） |
| `apikey-snake-mapper.ts:6` | "Two contract-specific behaviors" → Three；:3-4 "Applied in the controller" → 实际在 service（`apikey.service.ts:35,59`） |
| `sse-writer.ts:29-33` JSDoc | 随 P2-3 更新覆盖方向说明 |
| `ping()` | 随 P2-3 决定接入 keep-alive 或删除 |
| license.controller 头注释 | 随 P0-4 移除 "admin enforcement deferred" 字样 |

---

## 七、Quick Wins（一天内可完成，可独立提交）

1. sse-writer spread 顺序 `{ ...data, type }` + JSDoc（P2-3 核心）。
2. `PATCH /user/pwd/:id` 与 `POST /system/license` 挂 AdminGuard（P0-4/P0-5 核心，先建 guard）。
3. parameter group `startsWith` 前缀补尾部 `'.'`（`parameter.service.ts:80`，`abc` 不再误匹配 `abcd.*`）。
4. `llm.service.ts:186` `total_tokens` 缺失用 `input+output` 兜底。
5. `package.json` 删 `sqlite3`/`p-queue`；`pnpm-workspace.yaml` `allowBuilds`→`onlyBuiltDependencies`；prisma 钉精确同版。
6. embedded-sign dev secret 收敛单一模块（P0-5）。
7. `parseStrictInt` 工具落地并替换 6 个调用点（P2-1 核心）。
8. 文档漂移 5 项（上表）。
9. schema 三处 `@@index` + 迁移（P3-1）。

**不适用/降级的 Quick Win**：system-variable `contains` 加 `mode:'insensitive'` —— **SQLite provider 不支持该选项**（`schema.prisma:6`；`workspace.service.ts:96` 注释已说明），替代方案：raw SQL `lower()` 查询或入参归一化，需单独设计（并入 P3-2 时处理）。

## 八、实施顺序（分批提交，每批独立可验证）

| 批次 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| 1 | **安全止血**：P0-1 filter-tree、P0-3 路径穿越、P0-4+P0-5 守卫与 secret 收敛、Quick Wins 1/2/4/5/6/8 | 2 天 | 无 |
| 2 | **密钥治理**：P0-2 apikey reveal-on-demand（后端+前端+e2e） | 1 天 | 批 1 的 AdminGuard 无强依赖，可并行 |
| 3 | **数据完整性**：P1-1 事务、P1-2 级联策略迁移、P1-3 dashboard 可见性兜底（迁移前备份 dev.db） | 2–3 天 | 无 |
| 4 | **正确性**：P2-1 int-parse（若未随 Quick Wins 完成）、P2-2 DTO、P2-3 SSE 余项、P2-5 错误透明 | 2–3 天 | 批 1 |
| 5 | **导入管线**：P2-4（含 `@@unique` 去重迁移与存量清理） | 2 天 | 批 3 的迁移规范 |
| 6 | **性能与结构**：P3-1（若未随 Quick Wins）、P3-2、P3-3、P3-5 pager | 2–3 天 | 批 4 |
| 7 | **测试卫生收尾 + 工具链**：第五节剩余项、P3-4（strict 放最后） | 2 天 | 全部 |

每批验证命令（遵循 AGENTS.md）：

```bash
cd backend && pnpm run lint && pnpm run test && pnpm run test:e2e
# 涉及前端（批 2）: cd frontend && npm run build
# 涉及迁移（批 3/5/6）: 先 cp database/dev.db database/dev.db.bak，再 pnpm run prisma:migrate
```

总量约 **2 周单人**；批 1+2 完成后即可消除全部 P0 风险面。

---

## 附录 A：核实结果明细

### A-1 属实（按 review 条目）

| Review 主张 | 位置（当前行号） |
|---|---|
| quoteIdentifier 不转义内嵌引号 | filter-tree.ts:158-161 |
| null 转换结果 fail-open | filter-tree.ts:204,218,225,231,177-179；消费点 row-permission.service.ts:117-118 |
| enum 恒发 IN（反转 not in） | filter-tree.ts:227-233 |
| between 单操作数 | filter-tree.ts:248-252 |
| LIKE 通配符未转义 | filter-tree.ts:247 |
| apikey 列表明文批量 secret | apikey.service.ts:53-67；e2e 契约 apikey.e2e-spec.ts:102-120；前端 Apikey.vue:56,174-182 |
| pathFor 路径穿越 / exists('..') | assistant-file.service.ts:90-93,95-102 |
| Chat 可空关系 Cascade 毁数据 | schema.prisma:82-83；datasource.service.ts:174-177 |
| phase2 丢凭证 / phase5 oid=1 / dashboard createBy=NULL 不可见 | 20260723005041 / 20260723060000 / 20260726100000 迁移；dashboard.service.ts:117 |
| license 仅 JwtAuthGuard + 纯 interface 载荷 | license.controller.ts:64-68 |
| DEFAULT_PWD 越权风险（升级为账号接管） | user.service.ts:59,289-297；user.controller.ts:219-227 |
| permission/user/workspace/system-variable 非事务多步写 | permission.service.ts:109-116；user.service.ts:226-229；workspace.service.ts:64-65,77-82,264-287 |
| 缺 body.users → TypeError；纯 interface body | permission.service.ts:44-49,96,186；system-variable.service.ts:39-44,109,120 |
| DTO 无 @IsInt/@Min，"1e3" 隐转通过 | delete-chat.dto.ts:7-9 等 6 个 DTO；app.module.ts:116-120 |
| 两个导入器重复建行 + 丢 advanced_application + 顺序 upsert | terminology.service.ts:479,475-478,452-487；custom-prompt.service.ts:377-410,398-401 |
| bcrypt.hashSync 在导入循环 | user.service.ts:422 |
| SSE spread 顺序 / 无 close 处理 / 无背压 / ping 死代码 | sse-writer.ts:35,40-42；chat.controller.ts:280-306 |
| Table.datasourceId / Field.tableId / DataTraining 复合索引缺失 | schema.prisma:37-51,54-67,346-347 |
| 数值强转 6 处（含 [0,0,1] 伪造、NaN→500） | workspace.service.ts:228-230；system-variable.service.ts:92,103；custom-prompt.service.ts:100-103；permission-snake-mapper.ts:94-97；dashboard.service.ts:273；scripts/sign-embedded.ts:64-65 |
| terminology↔custom-prompt 管线复制、where-builder 重复、parameter mapper ×3 | 见 P3-3 行号 |
| parameter startsWith 缺 '.'；事务内逐行 upsert | parameter.service.ts:80,103-115 |
| llm aes.key 非空断言 / id:0 假模型 / total_tokens 不兜底 | llm.service.ts:89-91,130-150,186 |
| user pager() 全表内存分页 | user.service.ts:97-105,112-142 |
| e2e：无登录断言 ×18、全表清空、同义反复断言 ×13、100ms sleep、firstId 顺序依赖、路由 base 11–29×/spec、apikey 明文契约 | 见第五节行号 |
| tsconfig 非 strict 无 include/exclude；eslint warn 降级无 --max-warnings 0；jest globals 全局注入；sqlite3/p-queue 未用；allowBuilds 无效键；prisma 未钉版本；无 .gitattributes | tsconfig.json；eslint.config.mjs:14-31,42；package.json:30-35,45,55,60,84；pnpm-workspace.yaml:1-6 |
| 文档漂移 5 项 | mcp.module.ts:2；apikey-snake-mapper.ts:3-6；sse-writer.ts:29-33；ai-model.e2e-spec.ts:189-190 |

### A-2 部分属实（前提或范围需修正）

| Review 主张 | 修正 |
|---|---|
| 「Table.datasourceId 可空关系挂 Cascade」 | Table 侧**必填**（schema.prisma:39-40）；可空的是 Chat（:82-83） |
| 「upload() 完全未校验，任意路由可存任意内容」 | 唯一调用点 assistant.service.ts:232 已调 checkFile；属设计耦合风险而非现实漏洞 |
| 「xlsx.load 无异常过滤器 → 裸 500」 | 全局 HttpExceptionFilter 存在（app.module.ts:127），但确实无文件上下文且非 Http 统一 500 |
| 「HMAC secret 四处重复」 | config（configuration.ts:29-35）与 script（sign-embedded.ts:46）重复确认；「e2e 三处复制」不成立 |
| 「PRAGMA foreign_keys=OFF 事务内无效（六迁移危险）」 | SQLite 行为描述正确，但该写法是 Prisma 官方生成模式（配 defer_foreign_keys=ON），风险下调，不建议改历史迁移 |
| 「宽松相等违反项目 strict-equality 规定」 | 未找到该规定（eslint 未启用 eqeqeq）；现存 `==` 均为 `== null` 惯用法（dashboard.service.ts:87,96,147,153,270,385 等），低优先级 |
| 「isPrimaryKey/fieldIndex/createBy 缺 backfill 的注释」 | 注释不存在；字段 NULL 无 backfill 的**事实**成立（dashboard 部分已在 P1-3 处理） |
| 「prompt.service ENOENT 静默替换 ''」 | ENOENT 直接抛出；'' 是 renderTemplate 缺 token 行为（prompt.service.ts:30） |
| 「.prettierrc endOfLine:"auto"」 | 该配置在 eslint.config.mjs:42 的 prettier 规则，不在 .prettierrc |

### A-3 不属实（无需处理）

| Review 主张 | 事实 |
|---|---|
| extract-json fragment fallback 返回错误 payload | extract-json.ts:52-70 解析失败返回 null，从不构造错误 payload |
| `20260519093200` 迁移含「SQLite 不自动建关系索引」注释 | 该文件无任何注释（索引缺失本身属实，见 P3-1） |
| embedded-sign bootstrap 三个 e2e 逐字复制 | 仅 assistant.e2e-spec.ts:82-87 一处，且复用 signEnvelope |
| binaryParser 跨 spec 重复 | 仅 custom-prompt.e2e-spec.ts 同文件内 2 处 |
| sse.send 位于 controller try/catch 之外 | chat.controller.ts:285-292/296-303 已捕获生成器错误并转 error 帧 |
| workspace 空白 keyword 经 `Number(null)===0` 触发 | 该分支不可达（controller 空守卫 + null 在 trim() 抛错）；`Number('')===0` 路径属实 |

---

*本计划基于 2026-09-14 工作区快照核实产出；实施时行号可能漂移，以符号名为准。*
