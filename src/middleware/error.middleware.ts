// ─── middleware/error.middleware.ts — Express Global Error Handler ─────────────
//
// Catches all AppError / Error instances thrown by controllers.
// Returns a uniform JSON error response.

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { sendError } from '../utils/response';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('[Express] Global Unhandled Error caught:', err);
  sendError(res, err);
}
