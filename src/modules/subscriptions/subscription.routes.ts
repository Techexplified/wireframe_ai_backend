// ─── modules/subscriptions/subscription.routes.ts — Subscription routes ───────
//
// Route map (mounted at /api/subscription):
//   GET /status — returns user plan state

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { getSubscriptionStatusHandler } from './subscription.controller';

const router = Router();

router.get(
  '/status',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    getSubscriptionStatusHandler(req, res).catch(next);
  }
);

export default router;
