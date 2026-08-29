// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── middleware/require-pro.middleware.ts — Pro Plan Access Guard
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Route-level middleware that enforces active Pro subscription.
//   Blocks free users from accessing certain features (e.g., credit top-ups).
//   Depends on authMiddleware running first (populates req.planState).
//
// PLAN STATE CHECKS:
//   Must satisfy BOTH conditions:
//   1. req.planState.plan === 'pro'  (not 'free')
//   2. req.planState.isActive === true  (not expired or cancelled)
//   
//   If either fails → throw 403 Forbidden
//
// USAGE PATTERN:
//   router.post('/topup', authMiddleware, requireProMiddleware, handler);
//   
//   Middleware chain:
//     1. authMiddleware: verify identity, load planState
//     2. requireProMiddleware: verify plan is 'pro' and active
//     3. handler: process request (only runs if both pass)
//
// DESIGN MOTIVATION (Fixing AUTH-M-01):
//   • Single reusable middleware vs. duplicating checks in every controller
//   • DRY principle: change Pro requirement in one place
//   • Declarative: router code shows which routes need Pro
//   • Extensible: easy to add requireAdmin, requireBeta, etc. in future
//
// USED ON:
//   • POST /api/checkout/topup — only Pro users can buy credit packs
//   • Could be added to other premium features in future
//
// ERROR HANDLING:
//   Throws ForbiddenError with user-facing message:
//   "An active Pro plan is required to access this resource. Please upgrade."

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
