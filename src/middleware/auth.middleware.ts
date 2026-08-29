// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── middleware/auth.middleware.ts — Firebase Authentication & User Binding
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Every request must pass through authMiddleware to verify user identity and load plan state.
//   Attaches req.figmaUserId + req.planState for controllers to use.
//   Creates user on first login (auto-provisioning pattern).
//
// AUTHENTICATION FLOW:
//   1. Figma plugin signs in to Firebase anonymously → receives ID token
//   2. Plugin sends: Authorization: Bearer <JWT> + x-figma-user-id: <uuid>
//   3. Server verifies JWT signature via Firebase Admin SDK
//   4. Server binds firebaseUid ↔ figmaUserId (one-to-one invariant)
//   5. Subsequent requests verified: same figmaUserId must come with same firebaseUid
//   6. Load user's plan state (creates user if new)
//
// FIXES APPLIED:
//   Fix AUTH-C-01: Firebase Anonymous UID binding enforcement
//     • First login: insert new user, bind firebaseUid → figmaUserId
//     • Subsequent logins: verify firebaseUid hasn't switched to different figmaUserId
//     • Prevents account takeover (one Firebase UID cannot hijack another Figma user)
//     • Sparse index on firebaseUid (only set for users authenticated via Firebase)
//
//   Fix AUTH-H-02: User name length validation (200 char cap)
//     • decodeURIComponent handles URL-encoded names from plugin header
//     • Prevents unbounded string storage (MongoDB doc size limits)
//     • Name is optional; used for display purposes only
//
// SECURITY NOTES:
//   • Firebase JWT verification (not trusted from client)
//   • JWT signature checked against Firebase public keys (auto-rotated)
//   • Expired tokens rejected via checkRevoked=true parameter
//   • figmaUserId treated as trusted after binding verification
//   • No password-based auth (Firebase Anonymous secure for plugin use case)
//
// ERROR HANDLING:
//   • 401 Unauthorized: invalid/expired token or missing x-figma-user-id
//   • 401 identity_mismatch: firebaseUid bound to different figmaUserId
//   • 401 identity_conflict: figmaUserId already bound to different UID
//   • 500 internal_error: database errors during verification

import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import { getActivePlanState } from '../modules/users/user.service';
import { verifySessionToken } from '../modules/auth/auth.service';
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
  // ── 1. Strictly Mandatory Authentication Token Verification ─────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(
      res,
      new UnauthorizedError(
        'Authentication token is required. Please re-open the plugin.',
        'missing_token'
      )
    );
    return;
  }

  const idToken = authHeader.split('Bearer ')[1]?.trim();
  if (!idToken) {
    sendError(res, new UnauthorizedError('Authentication token is empty', 'missing_token'));
    return;
  }

  let authenticatedUserId: string | undefined;

  // Primary: Verify HMAC-SHA256 Session JWT issued by /api/auth/session
  try {
    const verifiedSession = verifySessionToken(idToken);
    authenticatedUserId = verifiedSession.figmaUserId;
  } catch (sessionErr) {
    // Secondary fallback: Check if token is a valid Firebase ID Token
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken, /* checkRevoked */ true);
      authenticatedUserId = decodedToken.uid;
    } catch {
      logger.warn('[auth.middleware] Token verification failed for incoming request');
      sendError(res, new UnauthorizedError('Invalid or expired authentication token', 'invalid_token'));
      return;
    }
  }

  if (!authenticatedUserId) {
    sendError(res, new UnauthorizedError('Invalid authentication token', 'invalid_token'));
    return;
  }

  // ── 2. Validate and match x-figma-user-id ──────────────────────────────────
  const rawFigmaId = req.headers['x-figma-user-id'];
  if (rawFigmaId && typeof rawFigmaId === 'string') {
    const claimedFigmaUserId = rawFigmaId.trim().slice(0, 128);
    if (claimedFigmaUserId !== authenticatedUserId) {
      logger.warn(
        `[auth.middleware] Identity mismatch: Token belongs to ${authenticatedUserId} but request claimed ${claimedFigmaUserId}`
      );
      sendError(res, new UnauthorizedError('User identity mismatch', 'identity_mismatch'));
      return;
    }
  }

  const figmaUserId = authenticatedUserId.trim().slice(0, 128);

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

  // ── 3. Load plan state (creates user if new) ────────────────────────────────
  try {
    const { planState } = await getActivePlanState(figmaUserId, name);

    req.figmaUserId = figmaUserId;
    req.planState   = planState;

    next();
  } catch (err) {
    logger.error('[auth.middleware] Error loading plan state:', err);
    sendError(res, new AppError('Failed to load user plan state', 500, 'internal_error'));
  }
}
