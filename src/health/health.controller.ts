import { Controller, Get, HttpCode } from '@nestjs/common';
import { AppwriteService, type AppwritePingResult } from '../appwrite/appwrite.service';

/**
 * Liveness endpoint.
 *
 * As of milestone #2 the response includes the Appwrite subsystem state.
 * The endpoint always returns HTTP 200 — the JSON body distinguishes
 * subsystem health. A future milestone may switch to 503 once the project
 * has a uniform health policy across Appwrite + Redis.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly appwrite: AppwriteService) {}

  @Get()
  @HttpCode(200)
  async check(): Promise<{ status: 'ok'; appwrite: AppwritePingResult }> {
    const appwrite = await this.appwrite.ping();
    return { status: 'ok', appwrite };
  }
}
