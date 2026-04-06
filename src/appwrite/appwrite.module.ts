import { Module, type DynamicModule } from '@nestjs/common';
import type { Env } from '../config/env';
import { AppwriteService } from './appwrite.service';

/**
 * Persistence foundation. Registers a single `AppwriteService` provider,
 * built from the validated `Env` once at boot.
 *
 * Use `AppwriteModule.forRoot(env)` from the application root so the env
 * is loaded exactly once and the same `AppwriteService` instance is
 * available across the app.
 */
@Module({})
export class AppwriteModule {
  static forRoot(env: Env): DynamicModule {
    const provider = {
      provide: AppwriteService,
      useFactory: () => new AppwriteService(env),
    };
    return {
      module: AppwriteModule,
      providers: [provider],
      exports: [provider],
      global: true,
    };
  }
}
