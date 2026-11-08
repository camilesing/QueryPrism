// Seed: default workspace + admin user + base system variables + a default
// SQLite datasource, so the app is usable on first boot and the chat e2e
// (which binds a chat to datasourceId=1) has its fixture.
// Load .env explicitly: this script is also run directly via `pnpm prisma:seed`
// (without the Prisma CLI's dotenv loading).
import { config } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { encryptFrontendConfig } from '../src/datasource/frontend-config-crypto';

config({ quiet: true });

const prisma = new PrismaClient();

async function main() {
  // 1. Default workspace (id auto, but we want id=1 referenced by admin.oid).
  const workspace = await prisma.workspace.upsert({
    where: { name: 'default' },
    update: {},
    create: { name: 'default', description: '默认工作空间' },
  });

  // 2. Default admin user.
  const passwordHash = await bcrypt.hash('admin', 10);
  const admin = await prisma.user.upsert({
    where: { account: 'admin' },
    update: {},
    create: {
      account: 'admin',
      password: passwordHash,
      email: 'admin@queryprism.local',
      name: 'admin',
      oid: workspace.id,
      status: 1,
      origin: 0,
      language: 'zh-CN',
    },
  });

  // Bind admin to default workspace. Phase 10 §85: the phase10_user_compat
  // migration's `DROP TABLE "User"` cascade-deletes all UserWs rows (the
  // uid FK is ON DELETE CASCADE), so this re-bind is what restores admin's
  // workspace membership on every seed run. The earlier `.catch(() => undefined)`
  // masked a real failure (admin ended up with zero UserWs rows, breaking
  // GET /user/ws + PUT /user/ws/:oid) — let errors surface instead.
  await prisma.userWs.upsert({
    where: { uid_oid: { uid: admin.id, oid: workspace.id } },
    update: {},
    create: { uid: admin.id, oid: workspace.id, weight: 0 },
  });

  // 3. Built-in system variables (type='system',
  // var_type='text', value=[<user field>]). There is no backend i18n
  // service, so human-readable display names are stored directly.
  // The 3 built-ins occupy ids 1/2/3 (frontend variables/index.vue:33
  // hardcodes `![1,2,3].includes(row.id)` as non-selectable). The legacy
  // type='chat' variables (chat.history_round_count etc., used by the
  // parameter module whose frontend is a 404 prefix-mismatch) are removed —
  // the chat service doesn't read them; 10d will reconcile the parameter page.
  await prisma.systemVariable.deleteMany({
    where: {
      name: {
        in: [
          'chat.history_round_count',
          'chat.limit_rows',
          'chat.chat_limit',
          'queryprism_name',
        ],
      },
    },
  });
  const systemVariables: Array<{
    name: string;
    varType: string;
    type: string;
    value: Prisma.InputJsonValue;
  }> = [
    { name: 'Name', varType: 'text', type: 'system', value: ['name'] },
    { name: 'Account', varType: 'text', type: 'system', value: ['account'] },
    { name: 'Email', varType: 'text', type: 'system', value: ['email'] },
  ];

  for (const v of systemVariables) {
    await prisma.systemVariable.upsert({
      where: { name: v.name },
      update: {},
      create: v,
    });
  }

  // 4. Default SQLite datasource (development/test only). On a fresh DB this is
  // the first Datasource row → id=1, which the chat e2e binds to (POST
  // /chat/start {datasourceId:1}) and first-run manual use can target.
  // configuration is AES-encrypted with the frontend's key (Phase 10
  // §95: AES-128-ECB/Pkcs7, key 'QueryPrism123456') and points at the app's
  // bundled demo SQLite file — an external datasource, independent of the
  // PostgreSQL metadata DB. Production seeds skip it (no dev.db there).
  if (process.env.NODE_ENV !== 'production') {
    const configuration = encryptFrontendConfig({ db: './database/dev.db' });
    const existingDs = await prisma.datasource.findFirst({
      where: { name: '默认数据源' },
    });
    if (existingDs) {
      await prisma.datasource.update({
        where: { id: existingDs.id },
        data: { configuration, oid: workspace.id },
      });
    } else {
      await prisma.datasource.create({
        data: {
          name: '默认数据源',
          description: '指向演示用 SQLite 文件的示例数据源',
          type: 'sqlite',
          configuration,
          oid: workspace.id,
        },
      });
    }
  }

  console.log('Seed complete:', {
    workspace: workspace.name,
    admin: admin.account,
    variables: systemVariables.length,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
