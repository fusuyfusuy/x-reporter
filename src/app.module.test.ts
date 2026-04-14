import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { SESSION_COOKIE_NAME } from './auth/auth.controller';
import { signCookieValue } from './auth/cookies';
import { LLM_PROVIDER } from './digest/llm/llm.tokens';
import type {
  ChatOptions,
  ChatResult,
  LlmProvider,
} from './digest/llm/llm-provider.interface';
import { ARTICLE_EXTRACTOR } from './extraction/extraction.module';
import type {
  ArticleExtractor,
  ExtractedArticle,
} from './extraction/article-extractor.port';
import { X_SOURCE } from './ingestion/ingestion.module';
import type { FetchPage, XSource } from './ingestion/x-source.port';
import {
  BUILD_DIGEST_QUEUE,
  REDIS_HEALTH,
  type RedisHealthPort,
} from './queue/queue.tokens';
import { ScheduleService } from './schedule/schedule.service';
import { WorkersLifecycle } from './workers/workers.module';

const TEST_SESSION_SECRET = 'a-test-session-secret-at-least-32-chars-long';
const TEST_USER_ID = 'u_e2e_test_abc';
const OTHER_USER_ID = 'u_e2e_test_other';
const OTHER_USER_DIGEST_ID = 'd_cross_user';

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
  // Per-collection document store so /me and /digests don't share a
  // single flat id namespace. Appwrite's SDK keys by (collection, id)
  // and we need the same isolation here so the user-profile row and a
  // digests row can coexist without the collection-scoped reads mixing
  // them up.
  const collections = new Map<string, Map<string, Record<string, unknown> & { $id: string }>>();
  function getCollection(
    id: string,
  ): Map<string, Record<string, unknown> & { $id: string }> {
    let coll = collections.get(id);
    if (!coll) {
      coll = new Map();
      collections.set(id, coll);
    }
    return coll;
  }
  // Pre-seed the test user so /me has something to read.
  getCollection('users').set(TEST_USER_ID, {
    $id: TEST_USER_ID,
    xUserId: '999999',
    handle: 'e2e_user',
    status: 'active',
    createdAt: '2026-04-06T12:00:00Z',
  });
  // Pre-seed a digest row owned by a DIFFERENT user so the cross-user
  // 404 test can try to fetch it with TEST_USER_ID's cookie and
  // confirm the service/repo collapses "not yours" to a 404.
  getCollection('digests').set(OTHER_USER_DIGEST_ID, {
    $id: OTHER_USER_DIGEST_ID,
    userId: OTHER_USER_ID,
    windowStart: '2026-04-05T00:00:00.000Z',
    windowEnd: '2026-04-06T00:00:00.000Z',
    markdown: '## private\n',
    itemIds: ['i_other'],
    model: 'anthropic/claude-sonnet-4.5',
    tokensIn: 1,
    tokensOut: 2,
    createdAt: '2026-04-06T00:05:00.000Z',
  });
  return {
    databaseId: 'xreporter_test',
    async ping() {
      return { status: 'ok' as const };
    },
    databases: {
      async getDocument(p) {
        const doc = getCollection(p.collectionId).get(p.documentId);
        if (!doc) {
          const err = new Error('not found') as Error & { code: number };
          err.code = 404;
          throw err;
        }
        return doc;
      },
      async updateDocument(p) {
        const coll = getCollection(p.collectionId);
        const existing = coll.get(p.documentId);
        if (!existing) {
          const err = new Error('not found') as Error & { code: number };
          err.code = 404;
          throw err;
        }
        const updated = { ...existing, ...p.data };
        coll.set(p.documentId, updated);
        return updated;
      },
      async listDocuments(p) {
        // Lightweight `Query.equal("userId", ...)` support —
        // DigestsRepo.listByUser uses that filter to scope results. If
        // we don't honor it here the cross-user digest would surface in
        // TEST_USER_ID's list response. Appwrite's `Query.equal()`
        // serializes to a JSON string of the form
        // `{"method":"equal","attribute":"userId","values":["<id>"]}`
        // — see `src/workers/digests.repo.test.ts` for the same
        // parser shape.
        const coll = getCollection(p.collectionId);
        const queries = p.queries ?? [];
        const filters: Array<[string, string]> = [];
        for (const q of queries) {
          try {
            const parsed = JSON.parse(q) as {
              method?: string;
              attribute?: string;
              values?: unknown[];
            };
            if (parsed.method === 'equal') {
              filters.push([
                String(parsed.attribute),
                String((parsed.values ?? [])[0]),
              ]);
            }
            // orderDesc / limit / cursorAfter are ignored: the e2e-lite
            // run only asserts list size and userId-scoping.
          } catch {
            // Non-JSON queries (legacy format) — fall back to ignoring.
          }
        }
        const all = [...coll.values()];
        const filtered = all.filter((d) =>
          filters.every(([field, value]) => String(d[field]) === value),
        );
        return { total: filtered.length, documents: filtered };
      },
      async createDocument(p) {
        const doc = { $id: p.documentId, ...p.data };
        getCollection(p.collectionId).set(p.documentId, doc);
        return doc;
      },
    },
  };
}

/**
 * In-memory `BUILD_DIGEST_QUEUE` producer. `DigestsService.enqueueRunNow`
 * only calls `.add(name, data, opts)` and reads `.id` off the result;
 * nothing in the e2e-lite run actually drains the queue. Recording each
 * add lets the `POST /digests/run-now` test assert the enqueue happened
 * without spinning up a real BullMQ worker.
 */
function makeStubBuildDigestQueue(): {
  add(
    name: string,
    data: unknown,
    opts?: Record<string, unknown>,
  ): Promise<{ id: string }>;
  adds: Array<{ name: string; data: unknown; opts?: Record<string, unknown> }>;
} {
  const adds: Array<{ name: string; data: unknown; opts?: Record<string, unknown> }> = [];
  let next = 1;
  return {
    adds,
    async add(name, data, opts) {
      const entry: { name: string; data: unknown; opts?: Record<string, unknown> } = {
        name,
        data,
      };
      if (opts !== undefined) entry.opts = opts;
      adds.push(entry);
      return { id: `job-${next++}` };
    },
  };
}

/**
 * Canned `XSource`. Returns a deterministic single-page response for
 * both endpoints so any worker path that happens to reach the port in
 * e2e-lite sees the same bytes, not an "undefined is not a function"
 * style crash. No worker is wired to actually run here — the stub
 * exists to satisfy DI for `WorkersModule.forRoot`.
 */
function makeStubXSource(): XSource {
  const page: FetchPage = {
    items: [
      {
        tweetId: 't_stub_1',
        text: 'hello https://example.com/stub',
        authorHandle: 'stub_author',
        urls: ['https://example.com/stub'],
        kind: 'like',
      },
    ],
  };
  return {
    async fetchLikes() {
      return page;
    },
    async fetchBookmarks() {
      return { items: [] };
    },
  };
}

/**
 * Canned `ArticleExtractor`. Mirrors the shape the real adapters return
 * so any DI resolution path during e2e-lite bootstrap sees a valid
 * `ExtractedArticle` instead of a test-double shaped object.
 */
function makeStubArticleExtractor(): ArticleExtractor {
  return {
    async extract(url: string): Promise<ExtractedArticle> {
      return {
        url,
        title: 'Stub Article',
        siteName: 'Stub Site',
        content: 'Stub markdown body.',
        extractor: 'stub',
      };
    },
  };
}

/**
 * Canned `LlmProvider`. Returns an empty JSON envelope for any prompt
 * so the DI graph resolves; no digest graph runs during e2e-lite.
 */
function makeStubLlmProvider(): LlmProvider {
  return {
    model: 'stub/e2e',
    async chat(_opts: ChatOptions): Promise<ChatResult> {
      return {
        content: '{"clusters":[]}',
        usage: { tokensIn: 0, tokensOut: 0 },
      };
    },
  };
}

describe('AppModule (e2e-lite)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let stubBuildDigestQueue: ReturnType<typeof makeStubBuildDigestQueue>;

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
    // LLM vars are required as of milestone #9. The values don't need to
    // be real — `LlmModule.forRoot` constructs the adapter lazily and no
    // test in this e2e-lite suite calls the LLM.
    process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
    // Firecrawl vars are required as of milestone #8. The FirecrawlExtractor
    // is constructed lazily and no HTTP call is made during e2e-lite.
    process.env.FIRECRAWL_API_KEY = 'test_firecrawl_key';

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

    stubBuildDigestQueue = makeStubBuildDigestQueue();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot()],
    })
      .overrideProvider(AppwriteService)
      .useValue(makeStubAppwrite())
      .overrideProvider(ScheduleService)
      .useValue(fakeSchedule)
      .overrideProvider(REDIS_HEALTH)
      .useValue(fakeRedisHealth)
      // WorkersLifecycle creates BullMQ Workers on init that connect to
      // Redis. Override with a no-op so the e2e-lite test works offline.
      .overrideProvider(WorkersLifecycle)
      .useValue({ onModuleInit() {}, async onModuleDestroy() {} })
      // Override the BullMQ producer so `POST /digests/run-now` can
      // enqueue without a live Redis. The structural type in
      // `DigestsService` only needs `.add(name, data, opts)`.
      .overrideProvider(BUILD_DIGEST_QUEUE)
      .useValue(stubBuildDigestQueue)
      // Stub the four swap-point adapters so the DI graph resolves
      // under `WorkersModule.forRoot` / `DigestGraphModule` without
      // reaching out to X, Firecrawl, or OpenRouter. None of these
      // run during e2e-lite; they exist solely to satisfy DI.
      .overrideProvider(X_SOURCE)
      .useValue(makeStubXSource())
      .overrideProvider(ARTICLE_EXTRACTOR)
      .useValue(makeStubArticleExtractor())
      .overrideProvider(LLM_PROVIDER)
      .useValue(makeStubLlmProvider())
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

  // ---------------------------------------------------------------------
  // /digests e2e coverage (issue #12).
  //
  // The acceptance criteria for this block is "full HTTP surface of
  // `/digests` goes through the real controller/service/repo with
  // stubbed ports". We use the same session-cookie + stub-Appwrite
  // pattern as /me so the full session guard → controller → service →
  // repo → (stub) DB round-trip is exercised.
  //
  // Intentional non-goals:
  //   - We do NOT drain the build-digest queue; the stub producer
  //     records adds and returns a jobId, that's enough to assert
  //     `POST /digests/run-now` is wired end-to-end.
  //   - We do NOT run the DigestGraph — the graph is covered by unit
  //     tests (see `src/digest/graph/digest.graph.test.ts`).
  // ---------------------------------------------------------------------

  function testCookie(): string {
    const sessionValue = signCookieValue(
      { userId: TEST_USER_ID, issuedAt: Date.now() },
      TEST_SESSION_SECRET,
    );
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}`;
  }

  it('GET /digests without a session cookie returns 401', async () => {
    const res = await fetch(`${baseUrl}/digests`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
  });

  it('GET /digests/:id without a session cookie returns 401', async () => {
    const res = await fetch(`${baseUrl}/digests/any-id`);
    expect(res.status).toBe(401);
  });

  it('POST /digests/run-now without a session cookie returns 401', async () => {
    const res = await fetch(`${baseUrl}/digests/run-now`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('GET /digests returns an empty list when the user has no digests', async () => {
    // The stub Appwrite pre-seeds a digest belonging to OTHER_USER_ID,
    // so a correctly-scoped list for TEST_USER_ID must exclude it and
    // return `{ items: [] }`. This doubles as a cross-user isolation
    // check on the list endpoint.
    const res = await fetch(`${baseUrl}/digests`, {
      headers: { cookie: testCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor?: string };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeUndefined();
  });

  it('GET /digests/:id returns 404 for a non-existent id', async () => {
    const res = await fetch(`${baseUrl}/digests/d_does_not_exist`, {
      headers: { cookie: testCookie() },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });

  it('GET /digests/:id returns 404 when the id belongs to another user', async () => {
    // Security check: the pre-seeded digest's userId is OTHER_USER_ID,
    // but we call with TEST_USER_ID's cookie. The repo collapses
    // "not yours" to the same "not found" signal the service returns
    // for missing ids, so a probing client cannot distinguish "owned
    // by someone else" from "doesn't exist".
    const res = await fetch(`${baseUrl}/digests/${OTHER_USER_DIGEST_ID}`, {
      headers: { cookie: testCookie() },
    });
    expect(res.status).toBe(404);
  });

  it('POST /digests/run-now returns 202 with a jobId and enqueues exactly one build-digest job', async () => {
    const before = stubBuildDigestQueue.adds.length;
    const res = await fetch(`${baseUrl}/digests/run-now`, {
      method: 'POST',
      headers: { cookie: testCookie() },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; queuedAt: string };
    expect(typeof body.jobId).toBe('string');
    expect(body.jobId.length).toBeGreaterThan(0);
    expect(typeof body.queuedAt).toBe('string');

    // The producer stub was invoked exactly once, with the expected
    // name + payload shape (see `DigestsService.enqueueRunNow`).
    expect(stubBuildDigestQueue.adds.length).toBe(before + 1);
    const lastAdd = stubBuildDigestQueue.adds[stubBuildDigestQueue.adds.length - 1];
    if (!lastAdd) throw new Error('expected an enqueued build-digest job');
    expect(lastAdd.name).toBe('build-digest');
    expect(lastAdd.data).toEqual({ userId: TEST_USER_ID });
    // Retry / removal policy is set by the service, not by BullMQ
    // defaults. Assert the documented policy so a silent change is
    // caught by this test.
    expect(lastAdd.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    });
  });

  it('GET /digests rejects an invalid limit with 400 validation_failed', async () => {
    const res = await fetch(`${baseUrl}/digests?limit=0`, {
      headers: { cookie: testCookie() },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('validation_failed');
  });
});
