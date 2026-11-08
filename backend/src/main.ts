import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { I18nService } from 'nestjs-i18n';
import { AppModule } from './app.module';
import { AssistantService } from './assistant/assistant.service';
import { setI18n } from './common/i18n/translate';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Wire the i18n facade so tr() works everywhere without DI.
  setI18n(app.get(I18nService));
  const config = app.get(ConfigService);

  // 动态CORS: 静态 admin 前端 URL + 各 Assistant.domain 字段 (embedded 页面
  // 所在域). AssistantService.listAllowedOrigins 60s 缓存, mutation 清缓存.
  // 无 Origin 头 (同源/非浏览器) 一律放行; 查询失败 fail-closed.
  const assistantService = app.get(AssistantService);
  const frontendUrl = config.get<string>('frontendUrl');
  const staticOrigins = [frontendUrl, 'http://localhost:5173'].filter(
    (o): o is string => typeof o === 'string' && o.length > 0,
  );
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: string | boolean) => void,
    ) => {
      if (!origin) return callback(null, true); // 同源 / 非浏览器请求
      if (staticOrigins.includes(origin)) return callback(null, true);
      assistantService
        .isOriginAllowed(origin)
        .then((allowed) => callback(null, allowed))
        .catch(() => callback(null, false)); // fail-closed
    },
    credentials: true,
  });

  // Phase 9: frontend expects `/api/v1`.
  app.setGlobalPrefix('api/v1');

  // Note: ValidationPipe / TransformInterceptor / HttpExceptionFilter are
  // registered via APP_PIPE / APP_INTERCEPTOR / APP_FILTER in AppModule so
  // they also apply to unit/e2e tests that build the app through the DI container.

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  Logger.log(
    `Application running on http://localhost:${port}/api/v1`,
    'Bootstrap',
  );
}
void bootstrap();
