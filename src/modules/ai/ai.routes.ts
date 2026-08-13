// ─── modules/ai/ai.routes.ts — Feature / AI generation routes ────────────────
//
// Route map (mounted at /api/features):
//   POST /generate/start  — stream generation (ai domain)
//   POST /generate/check  — legacy credit pre-deduct (credit domain)
//   POST /generate/refund — credit refund (credit domain)
//
// Middleware chain for /generate/start (Pillar 3):
//   authMiddleware → aiRateLimitMiddleware → aiQuotaMiddleware → aiBudgetMiddleware → handler

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { startGenerationHandler } from './ai.controller';
import { checkGenerationHandler, refundGenerationHandler } from '../credits/credit.controller';
import { aiRateLimitMiddleware } from './middleware/ai.rate-limit.middleware';
import { aiQuotaMiddleware } from './middleware/ai.quota.middleware';
import { aiBudgetMiddleware } from './middleware/ai.budget.middleware';

const router = Router();

// ── POST /generate/start ──────────────────────────────────────────────────────
// Full protection middleware stack (rate limit + quota + cost cap)

router.post(
  '/generate/start',
  authMiddleware,
  aiRateLimitMiddleware,
  aiQuotaMiddleware,
  aiBudgetMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    startGenerationHandler(req, res).catch(next);
  }
);

// ── POST /generate/check ──────────────────────────────────────────────────────
// Rate limit only — quota checked via credit deduction logic

router.post(
  '/generate/check',
  authMiddleware,
  aiRateLimitMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    checkGenerationHandler(req, res).catch(next);
  }
);

// ── POST /generate/refund ─────────────────────────────────────────────────────
// No rate limit — this is a recovery operation, not an AI call

router.post(
  '/generate/refund',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    refundGenerationHandler(req, res).catch(next);
  }
);

export default router;
