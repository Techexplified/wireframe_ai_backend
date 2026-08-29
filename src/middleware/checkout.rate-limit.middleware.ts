// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── middleware/checkout.rate-limit.middleware.ts — Checkout Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Prevent checkout spam via persistent, stateful rate limiting.
//   Survives cold starts (uses MongoDB, not in-memory).
//   Limits: max 15 checkout attempts per user per 60 seconds.
//   Falls back to in-memory if MongoDB unavailable (graceful degradation).
//
// SLIDING WINDOW ALGORITHM:
//   For each request:
//     1. Query: count docs with (figmaUserId, requestedAt >= now - 60s)
//     2. If count >= 15: return 429 Too Many Requests
//     3. If count < 15: insert new doc, allow request
//     4. (Oldest doc falls outside window ~60s later)
//   
//   Why sliding window?
//     • More fine-grained than fixed windows (better UX)
//     • More precise than token bucket (simpler to reason about)
//     • User gets immediate feedback when rate limit triggered
//     • Automatic recovery after ~60 seconds
//
// DATABASE STRATEGY:
//   Collection: checkout_rate_limits
//   Document: { figmaUserId, requestedAt }
//   Index: { figmaUserId, requestedAt -1 }
//   TTL index: requestedAt, expireAfterSeconds: 120
//   
//   Why TTL=120s?
//     • Rate limit window is 60s
//     • Keep records for 120s (buffer for clock skew, lingering requests)
//     • After 120s, auto-delete to prevent unbounded collection growth
//
// FALLBACK STRATEGY (If MongoDB Down):
//   Uses in-memory Map: figmaUserId → [timestamps...]
//   Same sliding window algorithm
//   Survives single request, but lost on function shutdown
//   Better than no rate limit at all
//
// FIXING NEW-H-02:
//   Rate limit must survive cold starts (in-memory insufficient)
//   Single MongoDB instance = state persists across Cloud Functions
//   Prevents abuse: malicious actors can't create 1000s of sessions
//   Also prevents accidental client retries (idempotency)
//
// USED ON:
//   • POST /api/checkout/init — initiate plan purchase
//   • POST /api/checkout/topup — initiate credit top-up purchase
//
// ERROR RESPONSES:
//   429 Too Many Requests + message with retry-after hint
//   Message: "Too many checkout attempts. Please wait a minute..."

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
