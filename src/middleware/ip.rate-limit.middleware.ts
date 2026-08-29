
// ─── middleware/ip.rate-limit.middleware.ts — IP-Level Sliding Window Rate Limiting


import { Request, Response, NextFunction } from 'express';
import { getIpRateLimitsCollection } from '../config/database';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

const FREE_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const FREE_IP_MAX_REQUESTS = 20;

export async function ipRateLimitMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const plan = req.planState?.plan || 'free';

  // Pro users have their own strict per-user quotas & rate limits
  if (plan === 'pro') {
    return next();
  }

  const clientIp = req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
  const now = new Date();
  const windowStart = new Date(now.getTime() - FREE_IP_WINDOW_MS);

  try {
    const col = await getIpRateLimitsCollection();

    const recentCount = await col.countDocuments({
      clientIp,
      action: 'free_gen',
      timestamp: { $gte: windowStart },
    });

    if (recentCount >= FREE_IP_MAX_REQUESTS) {
      logger.warn(`[ip.rate-limit] IP ${clientIp} exceeded free generation limit (${recentCount}/${FREE_IP_MAX_REQUESTS})`);
      throw new AppError(
        'Too many generation requests from this network. Please wait a few minutes or upgrade to Pro.',
        429,
        'rate_limit_exceeded'
      );
    }

    // Record attempt
    await col.insertOne({
      clientIp,
      action: 'free_gen',
      timestamp: now,
      metadata: { figmaUserId: req.figmaUserId },
    });

    next();
  } catch (err) {
    next(err);
  }
}
