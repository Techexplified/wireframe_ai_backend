// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/auth/auth.routes.ts — Authentication Express Routes
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

import { Router, Request, Response, NextFunction } from 'express';
import { sessionHandshakeHandler } from './auth.controller';

const router = Router();

// POST /api/auth/session — Handshake to register/verify device secret and issue session JWT
router.post('/session', (req: Request, res: Response, next: NextFunction) => {
  sessionHandshakeHandler(req, res).catch(next);
});

export default router;
