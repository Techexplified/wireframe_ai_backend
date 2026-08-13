// ─── utils/response.ts — Standardized HTTP Response Utilities ─────────────────

import { Response } from 'express';
import { AppError } from './errors';

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json(data);
}

export function sendError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    const payload: Record<string, unknown> = {
      error: error.errorCode,
      message: error.message,
    };
    if (error.showTopup !== undefined) payload.show_topup = error.showTopup;
    if (error.details !== undefined) payload.details = error.details;

    res.status(error.statusCode).json(payload);
    return;
  }

  const errMsg = error instanceof Error ? error.message : String(error);
  res.status(500).json({
    error: 'internal_server_error',
    message: 'An unexpected error occurred.',
    details: process.env.NODE_ENV !== 'production' ? errMsg : undefined,
  });
}
