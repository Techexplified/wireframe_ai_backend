// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── modules/auth/auth.controller.ts — Authentication & Handshake Controller
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

import { Request, Response } from 'express';
import { registerOrVerifyDeviceSession } from './auth.service';
import { sendSuccess } from '../../utils/response';
import { BadRequestError } from '../../utils/errors';

export async function sessionHandshakeHandler(
  req: Request,
  res: Response
): Promise<void> {
  const figmaUserId = (req.body?.figmaUserId || req.headers['x-figma-user-id']) as string | undefined;
  const clientSecret = req.body?.clientSecret as string | undefined;
  const name = (req.body?.name || req.headers['x-figma-user-name']) as string | undefined;

  if (!figmaUserId || typeof figmaUserId !== 'string' || !figmaUserId.trim()) {
    throw new BadRequestError('figmaUserId is required', 'invalid_request');
  }

  if (!clientSecret || typeof clientSecret !== 'string' || clientSecret.length < 8) {
    throw new BadRequestError('clientSecret is required and must be at least 8 characters', 'invalid_request');
  }

  const clientIp = req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';

  const result = await registerOrVerifyDeviceSession(
    figmaUserId,
    clientSecret,
    clientIp,
    name
  );

  sendSuccess(res, result);
}
