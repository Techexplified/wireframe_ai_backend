// ─── modules/feedback/feedback.routes.ts — Feedback routes ───────────────────
//
// Route map (mounted at /api/feedback):
//   POST /submit  — Submit user feedback (auth required)
//   GET  /summary — Admin / analytics summary

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware';
import { submitFeedbackHandler, getFeedbackSummaryHandler } from './feedback.controller';

const router = Router();

router.post(
  '/submit',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    submitFeedbackHandler(req, res).catch(next);
  }
);

router.get(
  '/summary',
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    getFeedbackSummaryHandler(req, res).catch(next);
  }
);

export default router;
