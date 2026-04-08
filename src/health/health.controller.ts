import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { AppwriteService, type AppwritePingResult } from '../appwrite/appwrite.service';
import { REDIS_HEALTH, type RedisHealthPort } from '../queue/queue.tokens';
import type { RedisPingResult } from '../queue/redis.connection';

/**
 * Liveness endpoint.
 *
 * As of milestone #5 the response includes both subsystem states:
 * `appwrite` (the Appwrite project ping from #2) and `redis` (the
 * BullMQ shared client ping from #5). The endpoint always returns
 * HTTP 200 — the JSON body distinguishes subsystem health via a
 * discriminated union per subsystem. A future milestone may switch to
 * 503 once the project has a uniform health policy across all
 * subsystems.
 *
 * The Redis dependency is injected via the `REDIS_HEALTH` token rather
 * than the raw `ioredis` client. That keeps `ioredis` symbols out of
 * `src/health/` and preserves the hexagonal containment rule from
 * `docs/swe-config.json` (BullMQ + ioredis types live only in
 * `src/queue/` and `src/schedule/`).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly appwrite: AppwriteService,
    @Inject(REDIS_HEALTH) private readonly redis: RedisHealthPort,
  ) {}

  @Get()
  @HttpCode(200)
  async check(): Promise<{
    status: 'ok';
    appwrite: AppwritePingResult;
    redis: RedisPingResult;
  }> {
    // Run both probes in parallel — there's no ordering relationship
    // between them, and a slow Appwrite ping should not delay the
    // Redis result (or vice versa). Both helpers are contracted to
    // never throw, so `Promise.all` is safe here.
    const [appwrite, redis] = await Promise.all([
      this.appwrite.ping(),
      this.redis.ping(),
    ]);
    return { status: 'ok', appwrite, redis };
  }
}
