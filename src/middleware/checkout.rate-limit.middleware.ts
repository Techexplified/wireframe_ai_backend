// ─── middleware/checkout.rate-limit.middleware.ts ────────────────────────────
//
// Fix NEW-H-02: Rate limit checkout creation via MongoDB sliding window.
// Persistent across Cloud Function cold starts and multiple instances.
// Max 15 checkout session requests per user per 60 seconds.

import { Request, Response, NextFunction } from 'express';
import { getCheckoutRateLimitsCollection } from '../config/database';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

const WINDOW_MS    = 60 * 1000;
const MAX_REQUESTS = 15;

const inMemoryFallback = new Map<string, number[]>();

export async function checkoutRateLimitMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const figmaUserId = req.figmaUserId || 'anonymous';
  const now         = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MS);

  try {
    const col = await getCheckoutRateLimitsCollection();

    const recentCount = await col.countDocuments({
      figmaUserId,
      requestedAt: { $gte: windowStart },
    });

    if (recentCount >= MAX_REQUESTS) {
      logger.warn(`[checkout.rate-limit] Too many checkout attempts for user ${figmaUserId} (${recentCount}/${MAX_REQUESTS})`);
      throw new AppError(
        'Too many checkout attempts. Please wait a minute before trying again.',
        429,
        'rate_limit_exceeded'
      );
    }

    // Record this attempt (TTL index automatically removes old records)
    await col.insertOne({ figmaUserId, requestedAt: now });

    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    logger.warn('[checkout.rate-limit] DB unavailable, using memory fallback:', (err as any)?.message || err);
    
    // In-memory sliding window fallback
    const nowMs = now.getTime();
    let timestamps = inMemoryFallback.get(figmaUserId) || [];
    timestamps = timestamps.filter((t) => nowMs - t < WINDOW_MS);

    if (timestamps.length >= MAX_REQUESTS) {
      next(new AppError(
        'Too many checkout attempts. Please wait a minute before trying again.',
        429,
        'rate_limit_exceeded'
      ));
      return;
    }

    timestamps.push(nowMs);
    inMemoryFallback.set(figmaUserId, timestamps);
    next();
  }
}
