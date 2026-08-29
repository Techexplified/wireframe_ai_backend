// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── middleware/error.middleware.ts — Global Express Error Handler
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Catches all errors thrown by controllers and middleware.
//   Returns uniform JSON error response format.
//   Logs errors for debugging (details hidden in production).
//
// ERROR HANDLING FLOW:
//   1. Controller/middleware throws error (e.g., new ForbiddenError('...'))
//   2. Error bubbles up through middleware stack
//   3. If async handler: catch(err) → next(err)
//   4. Express routes to this error handler middleware (4 params)
//   5. sendError() formats response based on error type
//   6. HTTP response sent with appropriate status code + error code
//
// RESPONSE FORMATS:
//   AppError (custom error class):
//     { error: "errorCode", message: "User message", status_code: 400 }
//   
//   Generic Error (unexpected exception):
//     { error: "internal_server_error", message: "An unexpected error occurred." }
//     (details hidden in production, exposed only if NODE_ENV=development)
//
// LOGGING:
//   • All errors logged via logger.error() with full stack trace
//   • Helps diagnose bugs in production (logs stored in Firebase Cloud Logs)
//   • Sensitive errors (auth/payment) logged with details hidden from client
//
// DESIGN:
//   • Must have 4 parameters for Express to recognize as error handler
//   • Must be registered AFTER all other middleware/routes
//   • Only receives errors passed via next(err) or thrown in async handlers

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
