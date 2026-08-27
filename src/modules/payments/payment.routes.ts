// ─── modules/payments/payment.routes.ts — Checkout routes ────────────────────
//
// Route map (mounted at /api/checkout):
//   POST /init  — initiate plan purchase (auth + checkout rate limit)
//   POST /topup — initiate credit top-up purchase (auth + requirePro + checkout rate limit)

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { checkoutRateLimitMiddleware } from '../../middleware/checkout.rate-limit.middleware';
import { requireProMiddleware } from '../../middleware/require-pro.middleware';
import { initCheckoutHandler, topupCheckoutHandler } from './payment.controller';

const router = Router();

router.post(
  '/init',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    checkoutRateLimitMiddleware(req, res, next).catch(next);
  },
  (req: Request, res: Response, next: NextFunction) => {
    initCheckoutHandler(req, res).catch(next);
  }
);

router.post(
  '/topup',
  authMiddleware,
  requireProMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    checkoutRateLimitMiddleware(req, res, next).catch(next);
  },
  (req: Request, res: Response, next: NextFunction) => {
    topupCheckoutHandler(req, res).catch(next);
  }
);

export default router;
