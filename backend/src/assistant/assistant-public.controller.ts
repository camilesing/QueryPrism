// AssistantPublicController — public (no-JWT) read surface for the embedded
// page. Split from AssistantController (which has a class-level JwtAuthGuard)
// because JwtAuthGuard doesn't honour the @Public() metadata — keeping public
// routes on a guard-less controller is the clean way to expose them. Both
// controllers mount under `/assistant` (Nest allows same-path multi-controller
// routing as long as routes don't collide: public routes are 2-segment
// `/info/:appId` + `/app/:appId`, admin's `GET /:id` is 1-segment). The
// embedded page calls `/info/:appId` (render projection, no admin fields);
// `/app/:appId` returns the full safe assistant for future programmatic
// use. Both surface only active assistants.
//
// Phase 11F: added `AssistantBootstrapController` mounted under
// `/system/assistant`, which verifies the `QUERYPRISM-EMBEDDED-SIGN` header +
// issues the assistant JWT. NO
// collision with the admin `AssistantController @Controller('system/assistant')`
// (class-level JwtAuthGuard): admin routes are `GET /` (list),
// `GET /advanced_application`, `POST /`, `PUT /`, `DELETE /:id` — none match
// the bootstrap's 2-segment `GET /info/:id`. Guard-less + @Public() for
// documentation (the sign IS the auth).
import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AssistantService } from './assistant.service';
import { EmbeddedSignService } from './embedded-sign.service';

@Controller('assistant')
export class AssistantPublicController {
  constructor(private readonly assistantService: AssistantService) {}

  // Lightweight render projection — no id/appId/status/oid leaked.
  @Get('info/:appId')
  getInfo(@Param('appId') appId: string) {
    return this.assistantService.getInfo(appId);
  }

  // Full safe assistant (no appSecret) — public lookup by appId.
  @Get('app/:appId')
  findByAppId(@Param('appId') appId: string) {
    return this.assistantService.findByAppId(appId);
  }
}

/** Bootstrap route — sign-verified assistant JWT issuer. Reads the numeric
 *  assistant `id` from the path, the optional `virtual` query (the virtual
 *  user id to embed in the issued JWT), and the `QUERYPRISM-EMBEDDED-SIGN`
 *  header (a QueryPrism HMAC-SHA256 envelope). On success returns
 *  `{...safeAssistant, token}`. On failure → 401. */
@Controller('system/assistant')
export class AssistantBootstrapController {
  constructor(private readonly embeddedSignService: EmbeddedSignService) {}

  @Public()
  @Get('info/:id')
  async bootstrap(
    @Param('id', ParseIntPipe) id: number,
    @Query('virtual') virtual: string | undefined,
    @Req() req: Request,
  ) {
    const result = await this.embeddedSignService.bootstrap(
      id,
      virtual ? Number(virtual) : null,
      req.header('queryprism-embedded-sign') ?? undefined,
      req.header('user-agent') ?? '',
      req.header('origin') || undefined,
      req.header('referer') || undefined,
    );
    // Flatten to `{...assistantFields, token}`.
    return { ...result.assistant, token: result.token };
  }
}
