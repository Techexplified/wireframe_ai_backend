// ─── modules/webhooks/webhook.routes.ts — Webhook routes ─────────────────────
//
// Route map (mounted at /webhooks):
//   POST /dodo — Dodo Payments webhook (no auth middleware, signature verified inside handler)

import { Router, Request, Response, NextFunction } from 'express';
import { dodoWebhookHandler } from './webhook.controller';

const router = Router();

router.post(
  '/dodo',
  (req: Request & { rawBody?: Buffer }, res: Response, next: NextFunction) => {
    dodoWebhookHandler(req, res).catch(next);
  }
);

export default router;
