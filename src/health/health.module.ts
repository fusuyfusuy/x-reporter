import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * `HealthModule` depends on `AppwriteService`, but the provider is supplied
 * by `AppwriteModule.forRoot(env)` registered as a global module from
 * `AppModule`. We don't import `AppwriteModule` here directly so the health
 * module stays env-agnostic and easy to test in isolation (override the
 * `AppwriteService` provider via `Test.createTestingModule`).
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
