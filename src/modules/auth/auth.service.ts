// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/auth/auth.service.ts — Cryptographic Device Secret & Session JWT Service
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

import * as crypto from 'crypto';
import { getUsersCollection, getIpRateLimitsCollection } from '../../config/database';
import { findOrCreate, getActivePlanState } from '../users/user.service';
import { PlanState } from '../users/user.types';
import { UnauthorizedError, AppError, BadRequestError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const SESSION_SECRET =
  process.env.SESSION_JWT_SECRET ||
  process.env.DODO_WEBHOOK_SECRET ||
  'wireframe_ai_super_secret_jwt_key_2026';

const SESSION_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_ACCOUNTS_PER_IP_24H = 10;

export function hashClientSecret(clientSecret: string): string {
  return crypto.createHash('sha256').update(clientSecret).digest('hex');
}

export function createSessionToken(figmaUserId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    figmaUserId,
    iat: now,
    exp: now + SESSION_EXPIRY_SECONDS,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(dataToSign)
    .digest('base64url');

  return `${dataToSign}.${signature}`;
}

export function verifySessionToken(token: string): { figmaUserId: string } {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Authentication token is required', 'missing_token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Malformed authentication token', 'invalid_token');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(dataToSign)
    .digest('base64url');

  const actualBuf = Buffer.from(encodedSignature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');

  // Verify HMAC signature in constant time
  if (
    actualBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actualBuf, expectedBuf)
  ) {
    throw new UnauthorizedError('Invalid authentication token signature', 'invalid_token');
  }

  try {
    const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      throw new UnauthorizedError('Authentication token has expired', 'token_expired');
    }

    if (!payload.figmaUserId || typeof payload.figmaUserId !== 'string') {
      throw new UnauthorizedError('Invalid authentication token payload', 'invalid_token');
    }

    return { figmaUserId: payload.figmaUserId };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Invalid token payload', 'invalid_token');
  }
}

export async function registerOrVerifyDeviceSession(
  figmaUserId: string,
  clientSecret: string,
  clientIp: string,
  name?: string
): Promise<{ token: string; planState: PlanState }> {
  if (!figmaUserId || typeof figmaUserId !== 'string' || !figmaUserId.trim()) {
    throw new BadRequestError('figmaUserId is required', 'invalid_request');
  }
  if (!clientSecret || typeof clientSecret !== 'string' || clientSecret.length < 8) {
    throw new BadRequestError('clientSecret must be at least 8 characters', 'invalid_request');
  }

  const cleanUserId = figmaUserId.trim().slice(0, 128);
  const secretHash = hashClientSecret(clientSecret);
  const users = await getUsersCollection();
  const existingUser = await users.findOne({ figmaUserId: cleanUserId });

  if (!existingUser) {
    // ── Anti-Sybil check on new trial user creation ─────────────────────────
    const ipLimits = await getIpRateLimitsCollection();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentAccountsCount = await ipLimits.countDocuments({
      clientIp,
      action: 'account_create',
      timestamp: { $gte: oneDayAgo },
    });

    if (recentAccountsCount >= MAX_ACCOUNTS_PER_IP_24H) {
      logger.warn(`[auth.service] IP ${clientIp} exceeded max account creations (${recentAccountsCount}/${MAX_ACCOUNTS_PER_IP_24H})`);
      throw new AppError(
        'Too many new accounts created from this IP address. Please try again later.',
        429,
        'rate_limit_exceeded'
      );
    }

    // Create user and bind client secret
    await findOrCreate(cleanUserId, name);
    await users.updateOne(
      { figmaUserId: cleanUserId },
      { $set: { client_secret_hash: secretHash, updatedAt: new Date() } }
    );

    // Record IP audit log for rate limiting
    await ipLimits.insertOne({
      clientIp,
      action: 'account_create',
      timestamp: new Date(),
      metadata: { figmaUserId: cleanUserId },
    });

    logger.info(`[auth.service] Registered new user ${cleanUserId} with device secret from IP ${clientIp}`);
  } else {
    // Existing user
    if (!existingUser.client_secret_hash) {
      // First time device secret migration for existing user
      await users.updateOne(
        { figmaUserId: cleanUserId },
        { $set: { client_secret_hash: secretHash, updatedAt: new Date() } }
      );
      logger.info(`[auth.service] Bound initial device secret for existing user ${cleanUserId}`);
    } else if (existingUser.client_secret_hash !== secretHash) {
      // Device secret mismatch
      logger.warn(`[auth.service] Device secret updated/re-paired for ${cleanUserId}`);
      await users.updateOne(
        { figmaUserId: cleanUserId },
        { $set: { client_secret_hash: secretHash, updatedAt: new Date() } }
      );
    }
  }

  // Issue session JWT
  const token = createSessionToken(cleanUserId);
  const { planState } = await getActivePlanState(cleanUserId, name);

  return { token, planState };
}
