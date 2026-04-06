import { Controller, Get, HttpCode } from '@nestjs/common';

/**
 * Liveness endpoint.
 *
 * In milestone #1 (scaffold) this is a stub that always returns
 * `{ status: 'ok' }`. Subsystem checks (Redis, Appwrite) are added
 * in later milestones — see docs/implementation-plan.md issues #2 and #5.
 */
@Controller('health')
export class HealthController {
  @Get()
  @HttpCode(200)
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
