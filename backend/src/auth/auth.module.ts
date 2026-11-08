import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { WsAdminGuard } from './ws-admin.guard';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        // @types/jsonwebtoken v9 brands expiresIn as a `StringValue` template
        // type (from `ms`); the configured value is a valid duration string at
        // runtime, so we cast here. `ms` is only a transitive dep (via
        // jsonwebtoken) and not directly resolvable under pnpm's strict layout.
        signOptions: {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          expiresIn: config.get<string>('jwt.expiresIn') as any,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, WsAdminGuard],
  exports: [AuthService, JwtAuthGuard, WsAdminGuard, JwtModule],
})
export class AuthModule {}
