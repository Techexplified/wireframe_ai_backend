// ─── modules/ai/middleware/ai.rate-limit.middleware.ts ────────────────────────
//
// Sliding-window rate limiter for AI generation requests.
// Stored in MongoDB `generation_rate_limits` with compound index + TTL.
//
// Limits per plan:
//   Free: 1 request / 30 seconds
//   Pro:  3 requests / 10 seconds

import { Request, Response, NextFunction } from 'express';
import { getRateLimitsCollection } from '../../../config/database';
import { RATE_LIMIT_CONFIG } from '../../../config/constants';
import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

export async function aiRateLimitMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const figmaUserId = req.figmaUserId;
  const plan        = req.planState.plan;
  const config      = RATE_LIMIT_CONFIG[plan];
  const now         = new Date();
  const windowStart = new Date(now.getTime() - config.windowMs);

  try {
    const col = await getRateLimitsCollection();

    // Count requests in window (uses compound index { figmaUserId: 1, requestedAt: -1 })
    const recentCount = await col.countDocuments({
      figmaUserId,
      requestedAt: { $gte: windowStart },
    });

    if (recentCount >= config.maxRequests) {
      const retryAfterSec = Math.ceil(config.windowMs / 1000);
      throw new AppError(
        `Rate limit exceeded. Please wait ${retryAfterSec} seconds before generating again.`,
        429,
        'rate_limit_exceeded'
      );
    }

    // Record this request attempt (TTL index cleans up old docs automatically)
    await col.insertOne({ figmaUserId, requestedAt: now });

    next();
  } catch (err) {
    logger.warn('[ai.rate-limit] Error:', err);
    next(err);
  }
}
