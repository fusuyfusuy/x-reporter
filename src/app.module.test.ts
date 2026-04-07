import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { SESSION_COOKIE_NAME } from './auth/auth.controller';
import { signCookieValue } from './auth/cookies';
import { REDIS_HEALTH, type RedisHealthPort } from './queue/queue.tokens';
import { ScheduleService } from './schedule/schedule.service';

const TEST_SESSION_SECRET = 'a-test-session-secret-at-least-32-chars-long';
const TEST_USER_ID = 'u_e2e_test_abc';

/**
 * In-memory `AppwriteService` stand-in for the e2e-lite test.
 *
 * `UsersRepo` only consumes a narrow slice of `appwrite.databases`
 * (`getDocument`, `updateDocument`, `listDocuments`, `createDocument`).
 * Reusing the existing `app.module.test.ts` override pattern lets us
 * exercise the full HTTP → controller → service → repo → fake-db
 * round-trip without standing up Appwrite or BullMQ.
 *
 * The fake also pre-seeds one user row keyed by `TEST_USER_ID` so
 * `GET /me` has something to return. The session cookie minted in the
 * test below claims that same id, so the round-trip ties together.
 */
function makeStubAppwrite(): {
  databaseId: string;
  ping(): Promise<{ status: 'ok' }>;
  databases: {
    getDocument(p: {
      databaseId: string;
      collectionId: string;
      documentId: string;
    }): Promise<Record<string, unknown> & { $id: string }>;
    updateDocument(p: {
      databaseId: string;
      collectionId: string;
      documentId: string;
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown> & { $id: string }>;
    listDocuments(p: {
      databaseId: string;
      collectionId: string;
      queries?: string[];
    }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }>;
    createDocument(p: {
      databaseId: string;
      collectionId: string;
      documentId: string;
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown> & { $id: string }>;
  };
} {
  const docs = new Map<string, Record<string, unknown> & { $id: string }>();
  // Pre-seed the test user so /me has something to read.
  docs.set(TEST_USER_ID, {
    $id: TEST_USER_ID,
    xUserId: '999999',
    handle: 'e2e_user',
    status: 'active',
    createdAt: '2026-04-06T12:00:00Z',
  });
  return {
    databaseId: 'xreporter_test',
    async ping() {
      return { status: 'ok' as const };
    },
    databases: {
      async getDocument(p) {
        const doc = docs.get(p.documentId);
        if (!doc) {
          const err = new Error('not found') as Error & { code: number };
          err.code = 404;
          throw err;
        }
        return doc;
      },
      async updateDocument(p) {
        const existing = docs.get(p.documentId);
        if (!existing) {
          const err = new Error('not found') as Error & { code: number };
          err.code = 404;
          throw err;
        }
        const updated = { ...existing, ...p.data };
        docs.set(p.documentId, updated);
        return updated;
      },
      async listDocuments() {
        return { total: 0, documents: [] };
      },
      async createDocument(p) {
        const doc = { $id: p.documentId, ...p.data };
        docs.set(p.documentId, doc);
        return doc;
      },
    },
  };
}

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
    // Redis URL is required as of milestone #5. The e2e-lite test does NOT
    // require a reachable Redis — `createRedisClient` uses `lazyConnect`
    // so construction opens no TCP socket, and the test does not enqueue
    // any jobs. A real connect attempt would only happen if a test hit
    // `/health` (which pings Redis) — that test's assertion is written
    // to allow the `down` branch too, so a missing Redis never flakes CI.
    process.env.REDIS_URL = 'redis://localhost:6379';
    // X OAuth + crypto + session vars are required as of milestone #3. The
    // values don't have to be real — AppwriteService is stubbed and
    // AuthService never calls X in this lite e2e run.
    process.env.X_CLIENT_ID = 'test_x_client_id';
    process.env.X_CLIENT_SECRET = 'test_x_client_secret';
    process.env.X_REDIRECT_URI = 'http://localhost:3000/auth/x/callback';
    process.env.X_SCOPES = 'tweet.read users.read offline.access';
    process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 0).toString('base64');
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;

    const { AppwriteService } = await import('./appwrite/appwrite.service');

    // Stub the BullMQ-backed schedule + Redis ping so the test never
    // needs a reachable Redis. The real `QueueModule.forRoot` still
    // builds an ioredis client (lazyConnect, no socket opens at boot),
    // but ScheduleService is the only path that would actually run a
    // command, and the Redis health probe is the only path the
    // controller uses — both are replaced here.
    const fakeSchedule = {
      async upsertJobsForUser(_userId: string) {
        // no-op: a real BullMQ schedule write would require a live
        // Redis. The acceptance criterion (PATCH → schedule sync) is
        // covered by the unit-level UsersService.updateCadence test
        // and ScheduleService unit tests; the e2e-lite test only
        // needs the wiring to not explode.
      },
      async removeJobsForUser(_userId: string) {
        // no-op
      },
    } as unknown as ScheduleService;

    const fakeRedisHealth: RedisHealthPort = {
      // The /health test below already accepts both `ok` and `down`,
      // so returning a deterministic `ok` here is the simpler choice
      // — it pins the body shape without coupling the test to whether
      // a real Redis is running on the box.
      async ping() {
        return { status: 'ok' };
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot()],
    })
      .overrideProvider(AppwriteService)
      .useValue(makeStubAppwrite())
      .overrideProvider(ScheduleService)
      .useValue(fakeSchedule)
      .overrideProvider(REDIS_HEALTH)
      .useValue(fakeRedisHealth)
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

  it('GET /health responds 200 with status + appwrite + redis subsystems', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      appwrite: { status: string };
      redis: { status: string; error?: string };
    };
    expect(body.status).toBe('ok');
    expect(body.appwrite).toEqual({ status: 'ok' });
    // Redis is expected to be `ok` in the normal CI path (where a local
    // redis is running) OR `down` with an error string on a dev box with
    // no redis. Either way the controller MUST return 200 with a
    // structurally correct discriminated union; that's the health-policy
    // contract the e2e-lite test is locking in.
    expect(['ok', 'down']).toContain(body.redis.status);
    if (body.redis.status === 'down') {
      expect(typeof body.redis.error).toBe('string');
    }
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown-route-does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('GET /me without a session cookie returns 401 with the documented error envelope', async () => {
    // Validates the full HTTP wire format, not just the controller-level
    // exception body — confirms `SessionGuard` actually emits the
    // documented `{ error: { code: 'unauthorized', ... } }` envelope to
    // real clients (not Nest's default 401 shape).
    const res = await fetch(`${baseUrl}/me`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string; details?: unknown } };
    expect(body.error?.code).toBe('unauthorized');
    expect(body.error?.details).toEqual({});
  });

  it('PATCH /me without a session cookie returns 401', async () => {
    const res = await fetch(`${baseUrl}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pollIntervalMin: 30 }),
    });
    expect(res.status).toBe(401);
  });

  it('GET → PATCH → GET round-trip with a stub session cookie reflects the patch', async () => {
    // Mint a session cookie via the same primitive AuthService uses on
    // /auth/x/callback. We deliberately do NOT round-trip through the
    // OAuth start/callback endpoints — those would require a live X
    // upstream, which is out of scope for #4. Re-using `signCookieValue`
    // here is the same shape #11 will use for /digests e2e tests.
    const sessionValue = signCookieValue(
      { userId: TEST_USER_ID, issuedAt: Date.now() },
      TEST_SESSION_SECRET,
    );
    const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`;

    // 1. GET /me — should return the seeded profile with documented
    //    cadence defaults (60 / 1440) since the row has never been patched.
    const get1 = await fetch(`${baseUrl}/me`, { headers: { cookie: cookieHeader } });
    expect(get1.status).toBe(200);
    const body1 = await get1.json();
    expect(body1).toEqual({
      id: TEST_USER_ID,
      xUserId: '999999',
      handle: 'e2e_user',
      pollIntervalMin: 60,
      digestIntervalMin: 1440,
      status: 'active',
      createdAt: '2026-04-06T12:00:00Z',
    });

    // 2. PATCH /me — change both fields. The stub ScheduleService logs
    //    + resolves; that's the side effect #5 will replace.
    const patch = await fetch(`${baseUrl}/me`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({ pollIntervalMin: 15, digestIntervalMin: 720 }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as Record<string, unknown>;
    expect(patchBody.pollIntervalMin).toBe(15);
    expect(patchBody.digestIntervalMin).toBe(720);

    // 3. GET /me again — confirm persistence. This is the round-trip
    //    acceptance criterion: the second GET reflects the patch
    //    rather than reading a stale value out of the in-process repo.
    const get2 = await fetch(`${baseUrl}/me`, { headers: { cookie: cookieHeader } });
    expect(get2.status).toBe(200);
    const body2 = (await get2.json()) as Record<string, unknown>;
    expect(body2.pollIntervalMin).toBe(15);
    expect(body2.digestIntervalMin).toBe(720);
    // Other fields untouched.
    expect(body2.handle).toBe('e2e_user');
    expect(body2.xUserId).toBe('999999');
    expect(body2.status).toBe('active');
  });

  it('PATCH /me with an empty body returns 400 validation_failed', async () => {
    const sessionValue = signCookieValue(
      { userId: TEST_USER_ID, issuedAt: Date.now() },
      TEST_SESSION_SECRET,
    );
    const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`;
    const res = await fetch(`${baseUrl}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('PATCH /me with pollIntervalMin below 5 returns 400', async () => {
    const sessionValue = signCookieValue(
      { userId: TEST_USER_ID, issuedAt: Date.now() },
      TEST_SESSION_SECRET,
    );
    const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`;
    const res = await fetch(`${baseUrl}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ pollIntervalMin: 4 }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /me with a tampered session cookie returns 401', async () => {
    const sessionValue = signCookieValue(
      { userId: TEST_USER_ID, issuedAt: Date.now() },
      'a-completely-different-secret-32-chars',
    );
    const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`;
    const res = await fetch(`${baseUrl}/me`, { headers: { cookie: cookieHeader } });
    expect(res.status).toBe(401);
  });
});
