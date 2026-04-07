import { describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { AppwriteModule } from '../appwrite/appwrite.module';
import { AppwriteService } from '../appwrite/appwrite.service';
import { IngestionModule, X_SOURCE } from './ingestion.module';
import { XApiV2Source } from './x-api-v2.source';
import type { XSource } from './x-source.port';

/**
 * Module-level wiring test for `IngestionModule`.
 *
 * This exists because `X_SOURCE` is a string token — Nest has no way to
 * statically check that consumers can resolve it. If `IngestionModule`
 * ever loses its `AuthModule` import or mis-binds the factory, this
 * test catches it at `bun test` time rather than at app-boot time in
 * production.
 *
 * We override `AppwriteService` because otherwise `UsersRepo`'s
 * constructor would try to read real Appwrite config off `AppwriteService`
 * and the `forRoot` chain would try to validate the env. The override is
 * the same slice `app.module.test.ts` already uses; reproducing it here
 * keeps the ingestion test self-contained.
 */
function makeStubAppwrite(): {
  databaseId: string;
  ping(): Promise<{ status: 'ok' }>;
  databases: Record<string, unknown>;
} {
  return {
    databaseId: 'xreporter_test',
    async ping() {
      return { status: 'ok' as const };
    },
    // Nothing in this test actually calls the DB — the ingestion module's
    // `X_SOURCE` factory only references `UsersRepo` and `AuthService`
    // from the DI container, it does not invoke them. A bare object is
    // enough to satisfy the UsersRepo constructor's structural slice.
    databases: {},
  };
}

describe('IngestionModule.forRoot', () => {
  it('resolves X_SOURCE to an XApiV2Source instance', async () => {
    // Match the test env populated by `app.module.test.ts`. `AuthModule`
    // pulls these in via `Env`, so they must be present on process.env
    // before `forRoot` runs or env validation fails loud.
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.APPWRITE_ENDPOINT = 'https://appwrite.test/v1';
    process.env.APPWRITE_PROJECT_ID = 'test_project';
    process.env.APPWRITE_API_KEY = 'test_key';
    process.env.APPWRITE_DATABASE_ID = 'xreporter_test';
    process.env.X_CLIENT_ID = 'test_x_client_id';
    process.env.X_CLIENT_SECRET = 'test_x_client_secret';
    process.env.X_REDIRECT_URI = 'http://localhost:3000/auth/x/callback';
    process.env.X_SCOPES = 'tweet.read users.read offline.access';
    process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 0).toString('base64');
    process.env.SESSION_SECRET = 'a-test-session-secret-at-least-32-chars-long';

    const { loadEnv } = await import('../config/env');
    const env = loadEnv();

    // `AppwriteModule` is `@Global()` in production wiring, so importing
    // it here makes `AppwriteService` visible to `UsersRepo` inside the
    // `AuthModule` chain that `IngestionModule` imports. The override
    // below replaces the real Appwrite client with a stub so no network
    // call escapes.
    const moduleRef = await Test.createTestingModule({
      imports: [AppwriteModule.forRoot(env), IngestionModule.forRoot(env)],
    })
      .overrideProvider(AppwriteService)
      .useValue(makeStubAppwrite())
      .compile();

    const xSource = moduleRef.get<XSource>(X_SOURCE);
    expect(xSource).toBeDefined();
    expect(xSource).toBeInstanceOf(XApiV2Source);

    await moduleRef.close();
  });
});
