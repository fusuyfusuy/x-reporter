import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../common/session.guard';
import {
  DIGEST_LIST_DEFAULT_LIMIT,
  DIGEST_LIST_MAX_LIMIT,
  type DigestDetail,
  type DigestListResponse,
  DigestsService,
  type RunNowResult,
} from './digests.service';

/**
 * HTTP surface for `/digests` (issue #11).
 *
 *   - `GET /digests?limit&cursor` — paginated list, newest first.
 *     Query params are validated with zod. Each row returns a
 *     `preview` (first ~200 chars of markdown) — full markdown stays
 *     on the detail endpoint so the list response doesn't balloon.
 *
 *   - `GET /digests/:id` — full digest payload. Returns `404` when
 *     the id either doesn't exist or doesn't belong to the caller;
 *     collapsing both cases to the same status prevents a malicious
 *     client from probing ids owned by other users.
 *
 *   - `POST /digests/run-now` — enqueue a one-shot `build-digest`
 *     job for the caller. Responds `202 Accepted` with the job id
 *     assigned by BullMQ.
 *
 * All three routes are gated by `SessionGuard`, which attaches
 * `req.user.id`. The controller is a thin HTTP translator over
 * `DigestsService` — no repo or queue calls here.
 */

/**
 * zod schema for the `GET /digests` query string. Both params are
 * optional with documented defaults. `limit` is clamped by the
 * schema; callers that exceed the maximum get `400 validation_failed`
 * rather than a silent clamp so they notice the ceiling.
 */
const ListDigestsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(DIGEST_LIST_MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Error-envelope helpers — same shape documented in `docs/api.md#errors`. */
function validationFailedBody(details: unknown): {
  error: { code: string; message: string; details: unknown };
} {
  return {
    error: {
      code: 'validation_failed',
      message: 'request failed validation',
      details,
    },
  };
}

function notFoundBody(message: string): {
  error: { code: string; message: string; details: Record<string, never> };
} {
  return {
    error: { code: 'not_found', message, details: {} },
  };
}

function unauthorizedBody(message: string): {
  error: { code: string; message: string; details: Record<string, never> };
} {
  return {
    error: { code: 'unauthorized', message, details: {} },
  };
}

/**
 * Minimal structural type for the request the controller touches.
 * `SessionGuard` sets `req.user.id`; nothing else is read off `req`.
 */
interface RequestWithUser {
  user?: { id: string };
}

@Controller('digests')
@UseGuards(SessionGuard)
export class DigestsController {
  constructor(private readonly digests: DigestsService) {}

  @Get()
  async list(
    @Req() req: RequestWithUser,
    @Query() query: unknown,
  ): Promise<DigestListResponse> {
    const userId = requireUserId(req);
    const parsed = ListDigestsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(validationFailedBody(parsed.error.issues));
    }
    const limit = parsed.data.limit ?? DIGEST_LIST_DEFAULT_LIMIT;
    return this.digests.list(userId, limit, parsed.data.cursor);
  }

  @Get(':id')
  async getById(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
  ): Promise<DigestDetail> {
    const userId = requireUserId(req);
    const digest = await this.digests.getById(userId, id);
    if (!digest) {
      throw new NotFoundException(notFoundBody('digest not found'));
    }
    return digest;
  }

  @Post('run-now')
  @HttpCode(202)
  async runNow(@Req() req: RequestWithUser): Promise<RunNowResult> {
    const userId = requireUserId(req);
    return this.digests.enqueueRunNow(userId);
  }
}

/**
 * Belt-and-braces check that mirrors `UsersController.requireUserId`.
 * `SessionGuard` always sets `req.user.id` before the controller
 * runs, but a future refactor that drops the guard from one of these
 * routes must not silently pass an undefined id into the service. We
 * surface this as `401 unauthorized` rather than `404` because the
 * underlying problem is "no authenticated user", not "resource
 * missing".
 */
function requireUserId(req: RequestWithUser): string {
  const id = req.user?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new UnauthorizedException(unauthorizedBody('no authenticated user'));
  }
  return id;
}
