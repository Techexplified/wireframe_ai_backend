// ─── modules/payments/payment.routes.ts — Checkout routes ────────────────────
//
// Route map (mounted at /api/checkout):
//   POST /init  — initiate plan purchase
//   POST /topup — initiate credit top-up purchase

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { initCheckoutHandler, topupCheckoutHandler } from './payment.controller';

const router = Router();

router.post(
  '/init',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    initCheckoutHandler(req, res).catch(next);
  }
);

router.post(
  '/topup',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    topupCheckoutHandler(req, res).catch(next);
  }
);

export default router;
