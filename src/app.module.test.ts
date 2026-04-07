import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule (e2e-lite)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    // Force test env so the logger is silent.
    // PORT must satisfy schema (>0); the actual listen port is decided
    // by app.listen(0) below, which asks the OS for a free port.
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';

    // Appwrite vars are required as of milestone #2. They never need to be
    // reachable here — the e2e-lite test stubs `AppwriteService` so no real
    // SDK call is made (see the override below).
    process.env.APPWRITE_ENDPOINT = 'https://appwrite.test/v1';
    process.env.APPWRITE_PROJECT_ID = 'test_project';
    process.env.APPWRITE_API_KEY = 'test_key';
    process.env.APPWRITE_DATABASE_ID = 'xreporter_test';
    // X OAuth + crypto + session vars are required as of milestone #3. The
    // values don't have to be real — AppwriteService is stubbed and
    // AuthService never calls X in this lite e2e run.
    process.env.X_CLIENT_ID = 'test_x_client_id';
    process.env.X_CLIENT_SECRET = 'test_x_client_secret';
    process.env.X_REDIRECT_URI = 'http://localhost:3000/auth/x/callback';
    process.env.X_SCOPES = 'tweet.read users.read offline.access';
    process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 0).toString('base64');
    process.env.SESSION_SECRET = 'a-test-session-secret-at-least-32-chars-long';

    const { AppwriteService } = await import('./appwrite/appwrite.service');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot()],
    })
      .overrideProvider(AppwriteService)
      .useValue({
        get databaseId() {
          return 'xreporter_test';
        },
        async ping() {
          return { status: 'ok' as const };
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    const url = await app.getUrl();
    // Nest sometimes returns [::1] on IPv6; rewrite for fetch portability
    baseUrl = url.replace('[::1]', '127.0.0.1').replace('://localhost', '://127.0.0.1');
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /health responds 200 with status + appwrite subsystem', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', appwrite: { status: 'ok' } });
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown-route-does-not-exist`);
    expect(res.status).toBe(404);
  });
});
