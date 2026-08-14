// ─── middleware/require-pro.middleware.ts ───────────────────────────────────
//
// Fix AUTH-M-01: Reusable route-level middleware to enforce active Pro plan.

import { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/errors';

export function requireProMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.planState?.isActive || req.planState.plan !== 'pro') {
    throw new ForbiddenError(
      'An active Pro plan is required to access this resource. Please upgrade.',
      'pro_plan_required'
    );
  }
  next();
}
