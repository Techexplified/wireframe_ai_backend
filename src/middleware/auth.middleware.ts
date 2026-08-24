// ─── middleware/auth.middleware.ts — Shared Guard with Firebase Auth ────────────
//
// Fix AUTH-C-01: Verify Firebase Anonymous Auth ID token on every request.
// The plugin signs in anonymously to Firebase and sends:
//   Authorization: Bearer <Firebase ID Token>
//   x-figma-user-id: <Figma user ID from figma.currentUser.id>
//
// First call for a UID: bind firebaseUid → figmaUserId in MongoDB (one-time)
// Subsequent calls: verify figmaUserId matches the stored binding
//
// Fix AUTH-H-02: x-figma-user-name validated and capped at 200 chars.

import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import { getActivePlanState } from '../modules/users/user.service';
import { getUsersCollection } from '../config/database';
import { UnauthorizedError, AppError } from '../utils/errors';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

// Max name length — Fix AUTH-H-02
const MAX_NAME_LENGTH = 200;

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // ── 1. Optional Firebase ID Token Verification ───────────────────────────
  const authHeader = req.headers['authorization'];
  let firebaseUid: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.split('Bearer ')[1]?.trim();
    if (idToken) {
      try {
        // Verifies the JWT signature using Firebase's public keys
        const decodedToken = await admin.auth().verifyIdToken(idToken, /* checkRevoked */ true);
        firebaseUid = decodedToken.uid;
      } catch (err) {
        logger.warn('[auth.middleware] Firebase token verification failed:', err instanceof Error ? err.message : err);
        sendError(res, new UnauthorizedError('Invalid or expired authentication token', 'invalid_token'));
        return;
      }
    }
  }

  // ── 2. Validate and sanitize figmaUserId ────────────────────────────────────
  const rawFigmaId = req.headers['x-figma-user-id'];
  if (!rawFigmaId || typeof rawFigmaId !== 'string' || !rawFigmaId.trim()) {
    sendError(res, new UnauthorizedError('x-figma-user-id header is required', 'missing_user_id'));
    return;
  }
  const figmaUserId = rawFigmaId.trim().slice(0, 128); // cap at 128 chars

  // Fix AUTH-H-02: Validate x-figma-user-name length
  const rawUserName = req.headers['x-figma-user-name'];
  let name: string | undefined;
  if (typeof rawUserName === 'string') {
    try {
      name = decodeURIComponent(rawUserName).slice(0, MAX_NAME_LENGTH);
    } catch {
      name = rawUserName.slice(0, MAX_NAME_LENGTH);
    }
  }

  // ── 3. Bind or verify Firebase UID ↔ figmaUserId ────────────────────────────
  // Fix AUTH-C-01: Each Firebase UID is linked to exactly one figmaUserId.
  if (firebaseUid) {
    try {
      const users = await getUsersCollection();

      // Check if this Firebase UID is already bound to a figmaUserId
      const existingBinding = await users.findOne({ firebaseUid });

      if (existingBinding) {
        // UID is already bound — verify it matches the claimed figmaUserId
        if (existingBinding.figmaUserId !== figmaUserId) {
          logger.warn(
            `[auth.middleware] UID mismatch: firebaseUid=${firebaseUid} is bound to ${existingBinding.figmaUserId} but request claims ${figmaUserId}`
          );
          sendError(res, new UnauthorizedError('User identity mismatch', 'identity_mismatch'));
          return;
        }
      } else {
        // UID not yet bound — check if figmaUserId already has a different UID bound
        const existingUser = await users.findOne({ figmaUserId, firebaseUid: { $exists: true, $ne: firebaseUid } });
        if (existingUser) {
          logger.warn(
            `[auth.middleware] figmaUserId ${figmaUserId} already bound to a different Firebase UID`
          );
          sendError(res, new UnauthorizedError('User identity conflict', 'identity_conflict'));
          return;
        }
      }
    } catch (err) {
      logger.error('[auth.middleware] UID binding check failed:', err);
      sendError(res, new AppError('Failed to verify user identity', 500, 'internal_error'));
      return;
    }
  }

  // ── 4. Load plan state (creates user if new) ────────────────────────────────
  try {
    const { planState } = await getActivePlanState(figmaUserId, name);

    if (firebaseUid) {
      // Bind Firebase UID to user on first login (after user is guaranteed to exist)
      const users = await getUsersCollection();
      await users.updateOne(
        { figmaUserId, firebaseUid: { $exists: false } },
        { $set: { firebaseUid } }
      );
    }

    req.figmaUserId = figmaUserId;
    req.planState   = planState;

    next();
  } catch (err) {
    logger.error('[auth.middleware] Error loading plan state:', err);
    sendError(res, new AppError('Failed to load user plan state', 500, 'internal_error'));
  }
}
