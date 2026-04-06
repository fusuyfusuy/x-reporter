import { type DynamicModule, Module } from '@nestjs/common';
import { loadEncryptionKey } from '../common/crypto';
import type { Env } from '../config/env';
import { TokensRepo } from '../tokens/tokens.repo';
import { UsersRepo } from '../users/users.repo';
import {
  AUTH_CONTROLLER_CONFIG,
  AuthController,
  type AuthControllerConfig,
} from './auth.controller';
import { AuthService, type AuthServiceConfig } from './auth.service';
import {
  HttpXOAuthClient,
  type XOAuthClient,
  type XOAuthClientConfig,
} from './x-oauth-client';

/**
 * Wires the auth module's concrete providers from the validated `Env`.
 *
 * Use `AuthModule.forRoot(env)` from `AppModule` so the encryption key is
 * decoded once at boot (instead of per-request) and the same
 * `HttpXOAuthClient` instance backs the whole process.
 *
 * Providers registered:
 *
 *   - `UsersRepo`     — thin adapter over AppwriteService.databases.
 *   - `TokensRepo`    — thin adapter over AppwriteService.databases.
 *   - `XOAuthClient`  — token `'XOAuthClient'`, bound to `HttpXOAuthClient`.
 *                       AuthService injects it via the symbolic token so the
 *                       interface / adapter boundary stays explicit.
 *   - `AuthService`   — orchestrator; receives the config + XOAuthClient +
 *                       repos.
 *   - `AuthController` — receives the service + cookie config.
 *
 * The `XOAuthClient` token is a string rather than the interface itself
 * because TypeScript interfaces don't exist at runtime. Consumers outside
 * this module should not inject it directly; they go through `AuthService`.
 */

/**
 * DI token for the `XOAuthClient` port. Exported so test harnesses that
 * build a testing module can override it via
 * `.overrideProvider(X_OAUTH_CLIENT)`.
 */
export const X_OAUTH_CLIENT = 'XOAuthClient';

/** X authorize/token/userinfo endpoint URLs. Centralised so tests can see them. */
const X_AUTHORIZE_ENDPOINT = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN_ENDPOINT = 'https://api.twitter.com/2/oauth2/token';
const X_USER_INFO_ENDPOINT = 'https://api.twitter.com/2/users/me';

/** State cookie lifetime — 10 minutes is plenty for a user to bounce through X. */
const STATE_COOKIE_MAX_AGE_SEC = 600;
/** Session cookie lifetime — 30 days (matches spec). */
const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

@Module({})
export class AuthModule {
  static forRoot(env: Env): DynamicModule {
    // Decode the AES key once at boot. loadEncryptionKey throws if the
    // decoded length is not exactly 32 bytes — the env schema already
    // validates this, but keeping the assertion here is cheap insurance.
    const encryptionKey = loadEncryptionKey(env.TOKEN_ENC_KEY);
    const cookieSecure = env.NODE_ENV === 'production';

    const xClientConfig: XOAuthClientConfig = {
      clientId: env.X_CLIENT_ID,
      clientSecret: env.X_CLIENT_SECRET,
      redirectUri: env.X_REDIRECT_URI,
      scopes: env.X_SCOPES,
      authorizeEndpoint: X_AUTHORIZE_ENDPOINT,
      tokenEndpoint: X_TOKEN_ENDPOINT,
      userInfoEndpoint: X_USER_INFO_ENDPOINT,
    };

    const authServiceConfig: AuthServiceConfig = {
      encryptionKey,
      sessionSecret: env.SESSION_SECRET,
      cookieSecure,
      stateCookieMaxAgeSec: STATE_COOKIE_MAX_AGE_SEC,
      sessionCookieMaxAgeSec: SESSION_COOKIE_MAX_AGE_SEC,
    };

    const authControllerConfig: AuthControllerConfig = {
      cookieSecure,
      stateCookieMaxAgeSec: STATE_COOKIE_MAX_AGE_SEC,
      sessionCookieMaxAgeSec: SESSION_COOKIE_MAX_AGE_SEC,
    };

    const xClientProvider = {
      provide: X_OAUTH_CLIENT,
      useFactory: (): XOAuthClient => new HttpXOAuthClient(xClientConfig),
    };

    const authServiceProvider = {
      provide: AuthService,
      useFactory: (xClient: XOAuthClient, users: UsersRepo, tokens: TokensRepo) =>
        new AuthService(authServiceConfig, xClient, users, tokens),
      inject: [X_OAUTH_CLIENT, UsersRepo, TokensRepo],
    };

    const authControllerConfigProvider = {
      provide: AUTH_CONTROLLER_CONFIG,
      useValue: authControllerConfig,
    };

    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        UsersRepo,
        TokensRepo,
        xClientProvider,
        authServiceProvider,
        authControllerConfigProvider,
      ],
      exports: [AuthService, UsersRepo, TokensRepo],
    };
  }
}
