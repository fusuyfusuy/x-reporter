import { describe, expect, it } from 'bun:test';
import { decrypt, encrypt, loadEncryptionKey } from '../common/crypto';
import type { TokenRecord, TokensRepo } from '../tokens/tokens.repo';
import type { UserRecord, UsersRepo, UserStatus } from '../users/users.repo';
import { AuthExpiredError, AuthService } from './auth.service';
import { verifyCookieValue } from './cookies';
import type { XOAuthClient, XTokenResponse, XUserInfo } from './x-oauth-client';

const KEY_B64 = Buffer.alloc(32, 13).toString('base64');
const SESSION_SECRET = 'a-test-session-secret-that-is-at-least-32-chars';

/**
 * Flip the first byte of the ciphertext+tag portion of an encrypted blob.
 * Leaves the IV portion (before `:`) intact so `decrypt` reaches the GCM
 * auth-tag check and rejects with a tamper failure rather than a parse
 * error. Used to simulate corrupted-at-rest tokens.
 */
function tamperCiphertext(encrypted: string): string {
  const [iv, ct] = encrypted.split(':');
  if (!iv || !ct) throw new Error('unexpected encrypted format');
  const buf = Buffer.from(ct, 'base64');
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return `${iv}:${buf.toString('base64')}`;
}

/**
 * Build the dependency bundle that `AuthService` needs. Each test
 * customizes only the slice it cares about — the helper provides sensible
 * defaults for the rest.
 */
function makeDeps(overrides: {
  xClient?: Partial<XOAuthClient>;
  users?: Partial<FakeUsersRepo>;
  tokens?: Partial<FakeTokensRepo>;
}): {
  service: AuthService;
  xClient: FakeXOAuthClient;
  users: FakeUsersRepo;
  tokens: FakeTokensRepo;
} {
  const xClient = new FakeXOAuthClient();
  Object.assign(xClient, overrides.xClient ?? {});
  const users = new FakeUsersRepo();
  Object.assign(users, overrides.users ?? {});
  const tokens = new FakeTokensRepo();
  Object.assign(tokens, overrides.tokens ?? {});

  const service = new AuthService(
    {
      encryptionKey: loadEncryptionKey(KEY_B64),
      sessionSecret: SESSION_SECRET,
      cookieSecure: false,
      stateCookieMaxAgeSec: 600,
      sessionCookieMaxAgeSec: 2_592_000,
    },
    xClient,
    users as unknown as UsersRepo,
    tokens as unknown as TokensRepo,
  );
  return { service, xClient, users, tokens };
}

/** Counts authorize-url builds and exchange/refresh calls. */
class FakeXOAuthClient implements XOAuthClient {
  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string {
    return `https://twitter.test/authorize?state=${input.state}&code_challenge=${input.codeChallenge}`;
  }
  exchangeCodeImpl: (input: { code: string; codeVerifier: string }) => Promise<XTokenResponse> =
    async () => ({
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      expiresIn: 7200,
      scope: 'tweet.read users.read offline.access',
    });
  refreshImpl: (refreshToken: string) => Promise<XTokenResponse> = async () => ({
    accessToken: 'plain-access-refreshed',
    refreshToken: 'plain-refresh-refreshed',
    expiresIn: 7200,
    scope: 'tweet.read users.read offline.access',
  });
  getMeImpl: (accessToken: string) => Promise<XUserInfo> = async () => ({
    xUserId: '12345',
    handle: 'fusuyfusuy',
  });
  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<XTokenResponse> {
    return this.exchangeCodeImpl(input);
  }
  async refresh(refreshToken: string): Promise<XTokenResponse> {
    return this.refreshImpl(refreshToken);
  }
  async getMe(accessToken: string): Promise<XUserInfo> {
    return this.getMeImpl(accessToken);
  }
}

class FakeUsersRepo {
  byId = new Map<string, UserRecord>();
  byXUserId = new Map<string, UserRecord>();
  upsertCalls = 0;
  setStatusCalls: Array<{ userId: string; status: UserStatus }> = [];

  async upsertByXUserId(input: { xUserId: string; handle: string }): Promise<UserRecord> {
    this.upsertCalls++;
    const existing = this.byXUserId.get(input.xUserId);
    if (existing) {
      // Mirror production semantics from `UsersRepo.upsertByXUserId`:
      // only revive an `auth_expired` row back to `active`. A `paused`
      // row stays paused, otherwise this fake would silently let
      // AuthService bugs that wrongly unpause users sneak through.
      const newStatus: UserStatus =
        existing.status === 'auth_expired' ? 'active' : existing.status;
      const updated: UserRecord = { ...existing, handle: input.handle, status: newStatus };
      this.byXUserId.set(input.xUserId, updated);
      this.byId.set(updated.id, updated);
      return updated;
    }
    const u: UserRecord = {
      id: `u_${this.byId.size + 1}`,
      xUserId: input.xUserId,
      handle: input.handle,
      status: 'active',
      createdAt: new Date(0).toISOString(),
    };
    this.byId.set(u.id, u);
    this.byXUserId.set(u.xUserId, u);
    return u;
  }

  async setStatus(userId: string, status: UserStatus): Promise<UserRecord> {
    this.setStatusCalls.push({ userId, status });
    const u = this.byId.get(userId);
    if (!u) throw new Error('user not found');
    const updated: UserRecord = { ...u, status };
    this.byId.set(userId, updated);
    this.byXUserId.set(u.xUserId, updated);
    return updated;
  }

  async findById(userId: string): Promise<UserRecord | null> {
    return this.byId.get(userId) ?? null;
  }

  async findByXUserId(xUserId: string): Promise<UserRecord | null> {
    return this.byXUserId.get(xUserId) ?? null;
  }
}

class FakeTokensRepo {
  byUserId = new Map<string, TokenRecord>();
  upsertCalls = 0;

  async upsertForUser(input: TokenRecord): Promise<TokenRecord> {
    this.upsertCalls++;
    this.byUserId.set(input.userId, { ...input });
    return { ...input };
  }

  async findByUserId(userId: string): Promise<TokenRecord | null> {
    const v = this.byUserId.get(userId);
    return v ? { ...v } : null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// startAuthorization
// ────────────────────────────────────────────────────────────────────────────

describe('AuthService.startAuthorization', () => {
  it('returns an authorize URL containing the state and code_challenge from the cookie payload', () => {
    const { service } = makeDeps({});
    const out = service.startAuthorization();
    expect(out.authorizeUrl).toContain('state=');
    expect(out.authorizeUrl).toContain('code_challenge=');

    // The state cookie value must verify and contain a state + verifier.
    const payload = verifyCookieValue<{
      state: string;
      codeVerifier: string;
      createdAt: number;
    }>(out.stateCookieValue, SESSION_SECRET);
    expect(payload).not.toBeNull();
    if (!payload) throw new Error('unreachable');
    expect(typeof payload.state).toBe('string');
    expect(typeof payload.codeVerifier).toBe('string');
    expect(payload.state.length).toBeGreaterThan(0);
    expect(payload.codeVerifier.length).toBeGreaterThanOrEqual(43);

    // The state in the cookie matches the one in the URL.
    const url = new URL(out.authorizeUrl);
    expect(url.searchParams.get('state')).toBe(payload.state);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleCallback
// ────────────────────────────────────────────────────────────────────────────

describe('AuthService.handleCallback', () => {
  async function withFreshSignedState(svc: AuthService): Promise<{
    stateCookieValue: string;
    state: string;
  }> {
    const out = svc.startAuthorization();
    const payload = verifyCookieValue<{ state: string }>(out.stateCookieValue, SESSION_SECRET);
    if (!payload) throw new Error('unreachable');
    return { stateCookieValue: out.stateCookieValue, state: payload.state };
  }

  it('on the happy path: exchanges the code, upserts the user, persists encrypted tokens, returns a session cookie', async () => {
    const { service, users, tokens, xClient } = makeDeps({});
    xClient.exchangeCodeImpl = async () => ({
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      expiresIn: 3600,
      scope: 'tweet.read offline.access',
    });
    xClient.getMeImpl = async (accessToken) => {
      // AuthService must resolve the X user with the freshly-minted access
      // token, not with any leftover value.
      expect(accessToken).toBe('plain-access');
      return { xUserId: '12345', handle: 'fusuyfusuy' };
    };
    const { stateCookieValue, state } = await withFreshSignedState(service);

    const result = await service.handleCallback({
      code: 'authcode',
      state,
      stateCookieValue,
    });

    expect(result.userId).toBeDefined();
    expect(users.upsertCalls).toBe(1);
    expect(tokens.upsertCalls).toBe(1);

    // The persisted access/refresh tokens are ENCRYPTED — never plaintext.
    const persisted = tokens.byUserId.get(result.userId)!;
    expect(persisted.accessToken).not.toBe('plain-access');
    expect(persisted.refreshToken).not.toBe('plain-refresh');
    const key = loadEncryptionKey(KEY_B64);
    expect(decrypt(persisted.accessToken, key)).toBe('plain-access');
    expect(decrypt(persisted.refreshToken, key)).toBe('plain-refresh');

    // The session cookie verifies and points at the new user id.
    const sessionPayload = verifyCookieValue<{ userId: string }>(
      result.sessionCookieValue,
      SESSION_SECRET,
    );
    expect(sessionPayload).not.toBeNull();
    expect(sessionPayload?.userId).toBe(result.userId);
  });

  it('rejects when the query state does not match the cookie state', async () => {
    const { service } = makeDeps({});
    const { stateCookieValue } = await withFreshSignedState(service);
    await expect(
      service.handleCallback({
        code: 'authcode',
        state: 'a-different-state',
        stateCookieValue,
      }),
    ).rejects.toThrow(/state mismatch|invalid state/i);
  });

  it('rejects when the state cookie is missing or empty', async () => {
    const { service } = makeDeps({});
    await expect(
      service.handleCallback({
        code: 'c',
        state: 's',
        stateCookieValue: '',
      }),
    ).rejects.toThrow(/state cookie/i);
  });

  it('rejects when the state cookie is older than the configured max age', async () => {
    const { service } = makeDeps({});
    // Build a cookie with createdAt far in the past.
    const { signCookieValue } = await import('./cookies');
    const stale = signCookieValue(
      { state: 'old', codeVerifier: 'v', createdAt: Date.now() - 30 * 60 * 1000 },
      SESSION_SECRET,
    );
    await expect(
      service.handleCallback({
        code: 'c',
        state: 'old',
        stateCookieValue: stale,
      }),
    ).rejects.toThrow(/expired|stale/i);
  });

  it('rejects when the state cookie signature is invalid', async () => {
    const { service } = makeDeps({});
    const { signCookieValue } = await import('./cookies');
    const wronglySigned = signCookieValue(
      { state: 'x', codeVerifier: 'v', createdAt: Date.now() },
      'a-completely-different-secret-that-is-also-32',
    );
    await expect(
      service.handleCallback({
        code: 'c',
        state: 'x',
        stateCookieValue: wronglySigned,
      }),
    ).rejects.toThrow(/state cookie/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getValidAccessToken
// ────────────────────────────────────────────────────────────────────────────

describe('AuthService.getValidAccessToken', () => {
  it('returns the existing decrypted access token when it is not near expiry', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const { service, users, tokens, xClient } = makeDeps({});
    // Seed a user + tokens row.
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('still-valid-access', key),
      refreshToken: encrypt('still-valid-refresh', key),
      expiresAt: future,
      scope: 'tweet.read',
    });
    // Wire the xClient.refresh to throw — should NOT be called.
    let refreshCalled = false;
    xClient.refreshImpl = async () => {
      refreshCalled = true;
      throw new Error('should not be called');
    };

    const access = await service.getValidAccessToken(u.id);
    expect(access).toBe('still-valid-access');
    expect(refreshCalled).toBe(false);
  });

  it('refreshes the access token when within the 60s skew window, persists the new pair, and returns it', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const expiringSoon = new Date(Date.now() + 30 * 1000).toISOString(); // < 60s skew
    const { service, users, tokens, xClient } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('old-access', key),
      refreshToken: encrypt('old-refresh', key),
      expiresAt: expiringSoon,
      scope: 'tweet.read',
    });
    const refreshArgs: string[] = [];
    xClient.refreshImpl = async (rt) => {
      refreshArgs.push(rt);
      return {
        accessToken: 'brand-new-access',
        refreshToken: 'brand-new-refresh',
        expiresIn: 7200,
        scope: 'tweet.read users.read',
      };
    };

    const access = await service.getValidAccessToken(u.id);
    expect(access).toBe('brand-new-access');
    expect(refreshArgs).toEqual(['old-refresh']);

    // The persisted row was updated and the new tokens are encrypted.
    const persisted = tokens.byUserId.get(u.id)!;
    expect(persisted.accessToken).not.toBe('brand-new-access');
    expect(decrypt(persisted.accessToken, key)).toBe('brand-new-access');
    expect(decrypt(persisted.refreshToken, key)).toBe('brand-new-refresh');
    // expiresAt advanced.
    expect(new Date(persisted.expiresAt).getTime()).toBeGreaterThan(
      new Date(expiringSoon).getTime(),
    );
  });

  it('refreshes when the access token is already expired', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { service, users, tokens, xClient } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('expired-access', key),
      refreshToken: encrypt('still-good-refresh', key),
      expiresAt: past,
      scope: 'tweet.read',
    });
    let called = false;
    xClient.refreshImpl = async () => {
      called = true;
      return {
        accessToken: 'newly-minted',
        refreshToken: 'still-good-refresh',
        expiresIn: 7200,
        scope: 'tweet.read',
      };
    };
    const access = await service.getValidAccessToken(u.id);
    expect(called).toBe(true);
    expect(access).toBe('newly-minted');
  });

  it('marks the user auth_expired and throws AuthExpiredError when refresh fails', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { service, users, tokens, xClient } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('expired-access', key),
      refreshToken: encrypt('expired-refresh', key),
      expiresAt: past,
      scope: 'tweet.read',
    });
    xClient.refreshImpl = async () => {
      throw new Error('invalid_grant');
    };

    await expect(service.getValidAccessToken(u.id)).rejects.toBeInstanceOf(AuthExpiredError);
    // The user was transitioned to auth_expired.
    expect(users.setStatusCalls).toEqual([{ userId: u.id, status: 'auth_expired' }]);
  });

  it('recovers from a stale-refresh race instead of expiring the user', async () => {
    // STALE-REFRESH RACE: with multiple workers, worker A can refresh +
    // persist a rotated token while worker B is still mid-flight against
    // the previous refresh token. X correctly returns invalid_grant for
    // worker B — but the user's credentials are NOT actually expired,
    // fresh ones already exist. The service must detect that the row
    // changed under its feet and retry with the new row instead of
    // flipping the user to auth_expired.
    const key = loadEncryptionKey(KEY_B64);
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const { service, users, tokens, xClient } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    // Seed worker B's view: a near-expired row with a stale refresh token.
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('stale-access', key),
      refreshToken: encrypt('stale-refresh', key),
      expiresAt: past,
      scope: 'tweet.read',
    });
    // When B's xClient.refresh fires, simulate that worker A already
    // rotated the row by overwriting tokens with a fresh, valid pair
    // BEFORE rejecting B with invalid_grant.
    xClient.refreshImpl = async () => {
      await tokens.upsertForUser({
        userId: u.id,
        accessToken: encrypt('fresh-access-from-A', key),
        refreshToken: encrypt('fresh-refresh-from-A', key),
        expiresAt: future,
        scope: 'tweet.read',
      });
      throw new Error('invalid_grant');
    };

    // B should re-read, see the new row, and return A's fresh access
    // token instead of marking the user expired.
    const access = await service.getValidAccessToken(u.id);
    expect(access).toBe('fresh-access-from-A');
    // No auth_expired transition was attempted.
    expect(users.setStatusCalls).toEqual([]);
  });

  it('marks the user auth_expired and throws AuthExpiredError when no tokens row exists', async () => {
    // A missing tokens row means partial callback persistence, manual
    // deletion, or a deleted user — re-auth is the only recovery, so the
    // user must transition to auth_expired so scheduled callers stop
    // retrying a permanently broken account.
    const { service, users } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    await expect(service.getValidAccessToken(u.id)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(users.setStatusCalls).toEqual([{ userId: u.id, status: 'auth_expired' }]);
  });

  it('marks the user auth_expired and throws AuthExpiredError when the access-token ciphertext is corrupt', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const { service, users, tokens } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    // Encrypt a real value, then mutate the ciphertext to force a tamper
    // failure in decrypt(). Avoid touching the IV portion (before ':') so
    // the format check passes and we exercise the GCM auth-tag failure
    // rather than a parse-time error.
    const tampered = tamperCiphertext(encrypt('still-valid-access', key));
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: tampered,
      refreshToken: encrypt('still-valid-refresh', key),
      expiresAt: future,
      scope: 'tweet.read',
    });

    await expect(service.getValidAccessToken(u.id)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(users.setStatusCalls).toEqual([{ userId: u.id, status: 'auth_expired' }]);
  });

  it('marks the user auth_expired and throws AuthExpiredError when the refresh-token ciphertext is corrupt', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { service, users, tokens, xClient } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    const tampered = tamperCiphertext(encrypt('plain-refresh', key));
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('expired-access', key),
      refreshToken: tampered,
      expiresAt: past,
      scope: 'tweet.read',
    });
    let refreshCalled = false;
    xClient.refreshImpl = async () => {
      refreshCalled = true;
      throw new Error('should not be reached');
    };

    await expect(service.getValidAccessToken(u.id)).rejects.toBeInstanceOf(AuthExpiredError);
    // Decrypt fails before refresh is even attempted.
    expect(refreshCalled).toBe(false);
    expect(users.setStatusCalls).toEqual([{ userId: u.id, status: 'auth_expired' }]);
  });

  it('marks the user auth_expired and throws AuthExpiredError when expiresAt is malformed', async () => {
    const key = loadEncryptionKey(KEY_B64);
    const { service, users, tokens } = makeDeps({});
    const u = await users.upsertByXUserId({ xUserId: '1', handle: 'h' });
    await tokens.upsertForUser({
      userId: u.id,
      accessToken: encrypt('access', key),
      refreshToken: encrypt('refresh', key),
      expiresAt: 'not-an-iso-date',
      scope: 'tweet.read',
    });

    await expect(service.getValidAccessToken(u.id)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(users.setStatusCalls).toEqual([{ userId: u.id, status: 'auth_expired' }]);
  });
});
