// ─── middleware/auth.middleware.ts — Shared Guard ──────────────────────────────
//
// Called on every authenticated route. Reads x-figma-user-id from headers,
// loads the user's plan state, and attaches both to req.

import { Request, Response, NextFunction } from 'express';
import { getActivePlanState } from '../modules/users/user.service';
import { UnauthorizedError, AppError } from '../utils/errors';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const figmaUserId  = req.headers['x-figma-user-id'];
  const rawUserName  = req.headers['x-figma-user-name'];
  const name = typeof rawUserName === 'string' ? decodeURIComponent(rawUserName) : undefined;

  if (!figmaUserId || typeof figmaUserId !== 'string' || !figmaUserId.trim()) {
    sendError(res, new UnauthorizedError('x-figma-user-id header is required', 'missing_user_id'));
    return;
  }

  try {
    const { planState } = await getActivePlanState(figmaUserId.trim(), name);

    req.figmaUserId = figmaUserId.trim();
    req.planState   = planState;

    next();
  } catch (err: unknown) {
    logger.error('[auth.middleware] Error:', err);
    sendError(
      res,
      new AppError(
        'Failed to load user plan state',
        500,
        'internal_error',
        undefined,
        err instanceof Error ? err.message : String(err)
      )
    );
  }
}
