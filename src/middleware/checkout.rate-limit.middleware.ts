// ─── middleware/checkout.rate-limit.middleware.ts ────────────────────────────
//
// Fix API-M-02: Rate limit checkout creation to prevent spamming Dodo checkout sessions.
// Max 3 checkout session requests per user per 60 seconds.

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

const WINDOW_MS    = 60 * 1000;
const MAX_REQUESTS = 3;

interface CheckoutAttempt {
  timestamps: number[];
}

const attemptsMap = new Map<string, CheckoutAttempt>();

// Periodic cleanup of stale records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of attemptsMap.entries()) {
    attempt.timestamps = attempt.timestamps.filter((t) => now - t < WINDOW_MS);
    if (attempt.timestamps.length === 0) {
      attemptsMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

export function checkoutRateLimitMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const figmaUserId = req.figmaUserId || 'anonymous';
  const now = Date.now();

  let attempt = attemptsMap.get(figmaUserId);
  if (!attempt) {
    attempt = { timestamps: [] };
    attemptsMap.set(figmaUserId, attempt);
  }

  // Filter timestamps within current sliding window
  attempt.timestamps = attempt.timestamps.filter((t) => now - t < WINDOW_MS);

  if (attempt.timestamps.length >= MAX_REQUESTS) {
    logger.warn(`[checkout.rate-limit] Too many checkout attempts for user ${figmaUserId}`);
    throw new AppError(
      'Too many checkout attempts. Please wait a minute before trying again.',
      429,
      'rate_limit_exceeded'
    );
  }

  attempt.timestamps.push(now);
  next();
}
