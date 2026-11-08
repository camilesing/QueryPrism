# QueryPrism 改名迁移说明

本仓库已从 `MiniChartBot` / `MiniChatBot` 全面改名为 **QueryPrism**。本文档记录已有环境升级时需要执行的一次性操作；全新环境只需按 README 启动即可。

## 1. 数据库与角色

Compose 中的默认值已改为：

| 项目 | 新值 |
|---|---|
| PostgreSQL 用户 | `queryprism` |
| PostgreSQL 密码 | `queryprism` |
| 主数据库 | `queryprism` |
| 测试数据库 | `queryprism_test` |

### 保留现有数据（推荐）

在**更新 compose 之前**，对现有卷执行：

```bash
docker compose stop app

# 主库与测试库（测试库不存在时跳过该条）
docker compose exec db psql -U minichartbot -d postgres -c \
  "ALTER DATABASE minichartbot RENAME TO queryprism;"
docker compose exec db psql -U minichartbot -d postgres -c \
  "ALTER DATABASE minichartbot_test RENAME TO queryprism_test;"

# 同一会话内完成角色改名 + 密码更新
docker compose exec db psql -U minichartbot -d postgres -c \
  "ALTER ROLE minichartbot RENAME TO queryprism; ALTER ROLE queryprism PASSWORD 'queryprism';"
```

然后更新 `docker-compose.yml` / `.devcontainer/devcontainer.json` / `backend/.env`，并重启：

```bash
docker compose up -d db
cd backend && pnpm prisma:deploy
```

如果测试库不存在：

```bash
docker compose exec db psql -U queryprism -d postgres -c \
  "CREATE DATABASE queryprism_test;"
```

e2e 的 global setup 会在 `queryprism_test` 上执行 `prisma migrate reset`，自动建表并启用 pgvector。

> 旧卷注意：Compose 项目名已固定为 `queryprism`，且 PostgreSQL 18 的挂载点改为 `/var/lib/postgresql`（原为 `/var/lib/postgresql/data`）。旧卷名通常是 `<旧项目名>_pgdata`，新项目不会自动复用它。若旧卷里有数据，推荐用 `pg_dump` / `pg_restore` 迁到新库；直接复用旧卷需要同时迁移 Docker 卷名和 PostgreSQL 18 的目录布局。

### 不保留现有数据

```bash
docker compose down -v
docker compose up -d db
cd backend && pnpm prisma:deploy && pnpm prisma:seed
```

`down -v` 会删除 `pgdata` 卷，请确认没有需要保留的数据。

## 2. 已有行数据修正

```sql
UPDATE "User"
   SET email = 'admin@queryprism.local'
 WHERE email = 'admin@minichartbot.local';

UPDATE "SystemVariable"
   SET name = 'chat.queryprism_name'
 WHERE name = 'chat.sqlbot_name';

UPDATE "SystemVariable"
   SET value = '"QueryPrism"'::jsonb
 WHERE type = 'appearance'
   AND name = 'name'
   AND value = '"SQLBot"'::jsonb;
```

如果外观配置里的 `pc_welcome` 等字段仍写着 SQLBot，请在「系统 → 外观」中重新保存，或按同样方式更新对应行。

## 3. 加密数据与登录态重置

以下默认值已改变，旧密文无法解密，属于本次改名的预期影响：

- `AES_KEY` 默认值
- `common/utils/aes.ts` 的 scrypt SALT
- 前端数据源配置 AES key（`QueryPrism123456`）
- `JWT_SECRET` 默认值
- 浏览器缓存前缀（`queryprism_v1_`）

升级后按需处理：

```sql
-- 旧数据源配置解密会得到空对象；在界面重新保存连接配置即可
UPDATE "Datasource" SET configuration = NULL WHERE configuration IS NOT NULL;

-- 旧模型 key 解密会抛错，先置空再在界面重新录入
UPDATE "AiModel" SET "apiKey" = NULL WHERE "apiKey" IS NOT NULL;

-- 旧 MCP access key 的 secretKey 已无法解密，删除后重新生成
DELETE FROM "ApiKey";
```

Assistant 的 `appSecret` 使用 `PATCH /system/embedded/secret/:id`（界面中的“重置密钥”）轮换即可。所有用户因 JWT 密钥变化需要重新登录。

## 4. 外部集成影响

如果有外部页面/服务接入了本项目，需要同步修改：

| 旧标识 | 新标识 |
|---|---|
| `X-SQLBOT-TOKEN` | `X-QUERYPRISM-TOKEN` |
| `X-SQLBOT-ASSISTANT-TOKEN` | `X-QUERYPRISM-ASSISTANT-TOKEN` |
| `X-SQLBOT-ASSISTANT-CERTIFICATE` | `X-QUERYPRISM-ASSISTANT-CERTIFICATE` |
| `X-SQLBOT-ASSISTANT-ONLINE` | `X-QUERYPRISM-ASSISTANT-ONLINE` |
| `X-SQLBOT-HOST-ORIGIN` | `X-QUERYPRISM-HOST-ORIGIN` |
| `SQLBOT-EMBEDDED-SIGN` | `QUERYPRISM-EMBEDDED-SIGN` |
| `sqlbot_embedded_event` | `queryprism_embedded_event` |
| `sqlbot_assistant_event` | `queryprism_assistant_event` |
| `sqlbot_embedded_token` | `queryprism_embedded_token` |
| `sqlbot_origin_data` | `queryprism_origin_data` |
| `xpack_static/sqlbot-embedded-dynamic.umd.js` | `xpack_static/queryprism-embedded-dynamic.umd.js` |

嵌入 widget 的构建产物不在本仓库中；如果单独维护，需要按新文件名发布。

## 5. 仓库与本地目录（手动）

代码内无法重命名当前工作目录和 GitHub 远程仓库，请在关闭会话后执行：

```bash
# GitHub 上先把仓库改名，然后：
git remote set-url origin git@github.com:camilesing/QueryPrism.git

# 可选：重命名本地目录
mv /Users/xinyiqi/Dev/TypeScript/MiniChatBot_Private /Users/xinyiqi/Dev/TypeScript/QueryPrism
```

`.idea/MiniChartBot.iml` 等 IDE 元数据可在重命名目录后由 IDE 重新生成；`.omc`、`.zcode`、`dist` 为忽略/生成产物，不需要手工修改。

## 6. 验证清单

```bash
# 旧名称应无输出（排除生成/忽略目录）
rg --hidden --no-ignore -n "MiniChartBot|MiniChatBot|minichartbot|minichatbot" \
  -g '!node_modules' -g '!dist' -g '!.git' -g '!.zcode' -g '!.omc' -g '!.idea' \
  -g '!backend/database'

cd backend && pnpm run lint && pnpm run build && pnpm run test
pnpm run test:e2e        # 需要 queryprism_test 数据库
cd ../frontend && npm run build
cd ../backend/g2-ssr && pnpm test
```

运行时检查：登录 `admin/admin`，确认标题、侧边栏、欢迎语、参数页均显示 QueryPrism；带 `X-QUERYPRISM-TOKEN` 的请求成功，旧 `X-SQLBOT-TOKEN` 返回 401；MCP 初始化返回 `serverInfo.name = "queryprism"`。