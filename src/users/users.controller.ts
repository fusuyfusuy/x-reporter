import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../common/session.guard';
import {
  ScheduleSyncError,
  UserNotFoundError,
  UsersService,
  type MeProfile,
} from './users.service';

/**
 * HTTP surface for `GET /me` and `PATCH /me`. Both endpoints are
 * gated by `SessionGuard`, which:
 *
 *   - Reads `xr_session` from the `Cookie` header.
 *   - Verifies the HMAC signature with `SESSION_SECRET`.
 *   - Attaches `req.user = { id }` on success or throws `401`.
 *
 * The controller is intentionally thin. All business logic lives in
 * `UsersService`. The controller's job is purely:
 *
 *   1. Read `req.user.id` (set by the guard).
 *   2. Validate inbound bodies with the strict zod schema declared
 *      below — invalid input becomes `400 validation_failed` under
 *      the standard error envelope from `docs/api.md#errors`. This
 *      means a malformed PATCH never reaches the repo or the
 *      scheduler.
 *   3. Call `UsersService` and forward the result.
 *   4. Map the typed errors `UsersService` raises onto HTTP status
 *      codes:
 *        - `UserNotFoundError`  → `404 not_found`
 *        - `ScheduleSyncError`  → `502 internal`
 *      Anything else bubbles to Nest's default exception filter
 *      (`500 internal`).
 *
 * The 502 mapping for schedule failures matches the pattern
 * `AuthController.callback` already uses for upstream X / Appwrite
 * outages: monitoring needs to tell "the user gave us bad input"
 * (4xx) apart from "an upstream we depend on is down" (5xx with the
 * `internal` code).
 */

/**
 * zod schema for `PATCH /me`. Both fields are independently optional
 * but at least one MUST be present (enforced by `.refine`). Unknown
 * keys are rejected (`.strict()`) so a future contract addition is a
 * deliberate, observable change rather than a silent ignore. Numbers
 * must be integers (the `users` collection field type is integer per
 * `data-model.md`).
 */
const PatchMeBodySchema = z
  .object({
    pollIntervalMin: z.number().int().min(5).optional(),
    digestIntervalMin: z.number().int().min(15).optional(),
  })
  .strict()
  .refine(
    (v) => v.pollIntervalMin !== undefined || v.digestIntervalMin !== undefined,
    {
      message: 'at least one of pollIntervalMin or digestIntervalMin is required',
    },
  );

/**
 * Standard error envelope from `docs/api.md#errors`. Defined inline
 * here (rather than imported from a future shared module) because
 * this is the first controller in the codebase that emits a structured
 * error body. Issue #11 (`/digests`) will hoist this to a shared
 * helper once there are two call sites.
 */
function validationFailedBody(details: unknown): { error: { code: string; message: string; details: unknown } } {
  return {
    error: {
      code: 'validation_failed',
      message: 'request body failed validation',
      details,
    },
  };
}

function notFoundBody(message: string): { error: { code: string; message: string } } {
  return {
    error: {
      code: 'not_found',
      message,
    },
  };
}

function internalBody(message: string): { error: { code: string; message: string } } {
  return {
    error: {
      code: 'internal',
      message,
    },
  };
}

/**
 * Minimal structural type for the express-style request the controller
 * actually touches. The `user` field is set by `SessionGuard` and is
 * the only thing the controller reads off `req`.
 */
interface RequestWithUser {
  user?: { id: string };
}

@Controller('me')
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async getMe(@Req() req: RequestWithUser): Promise<MeProfile> {
    const userId = requireUserId(req);
    try {
      return await this.users.getProfile(userId);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        throw new NotFoundException(notFoundBody(err.message));
      }
      throw err;
    }
  }

  @Patch()
  async patchMe(
    @Req() req: RequestWithUser,
    @Body() body: unknown,
  ): Promise<MeProfile> {
    const userId = requireUserId(req);
    const parsed = PatchMeBodySchema.safeParse(body);
    if (!parsed.success) {
      // The zod issue tree is the most useful payload for clients —
      // they get field-level reasons without us having to invent a
      // bespoke error format. Stripping it would leave callers
      // guessing which field was wrong.
      throw new BadRequestException(validationFailedBody(parsed.error.issues));
    }
    try {
      return await this.users.updateCadence(userId, parsed.data);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        throw new NotFoundException(notFoundBody(err.message));
      }
      if (err instanceof ScheduleSyncError) {
        // 502 with the `internal` error code mirrors the upstream-
        // failure shape `AuthController` uses for X / Appwrite
        // outages. The detailed reason stays in the server logs via
        // nestjs-pino — only a short string surfaces in the body so
        // we don't accidentally leak adapter internals.
        throw new BadGatewayException(internalBody('schedule sync failed'));
      }
      throw err;
    }
  }
}

/**
 * `SessionGuard` always sets `req.user.id` on success — if it didn't,
 * `canActivate` would have thrown 401 long before this controller
 * runs. The check here is belt-and-braces so a future refactor that
 * removes the guard from one of the routes can't silently produce a
 * `userId = undefined` request that hits the repo.
 */
function requireUserId(req: RequestWithUser): string {
  const id = req.user?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new NotFoundException(notFoundBody('no authenticated user'));
  }
  return id;
}
