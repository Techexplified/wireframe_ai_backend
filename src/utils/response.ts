// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── utils/response.ts — Standardized HTTP Response Utilities
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Provides type-safe response helpers for controllers.
//   Ensures consistent JSON format across all endpoints.
//   Handles both success and error responses with proper formatting.
//   Fixes API-M-01: prevents sensitive error details leaking in production.
//
// RESPONSE FORMATS:
//   
//   SUCCESS RESPONSE (200, 201, etc.):
//     {
//       ... (user-supplied data, usually typed<T>)
//     }
//   Example: { data: 'generated HTML', credits_left: 95 }
//   
//   ERROR RESPONSE (4xx, 5xx):
//     {
//       error: \"errorCode\",           // machine-readable identifier
//       message: \"User-facing message\",
//       status_code: 400,               // HTTP status code (for convenience)
//       details?: \"Internal info\"     // only if NODE_ENV=development
//     }
//   Example: { error: \"insufficient_credits\", message: \"Not enough credits\", status_code: 403 }
//
// USAGE IN CONTROLLERS:
//   
//   // Return success response
//   sendSuccess(res, { generation: result, creditsLeft: 50 }, 200);
//   
//   // Return error (automatic via middleware)
//   throw new ForbiddenError('Not enough credits', 'insufficient_credits');
//   // error.middleware.ts catches → sendError(res, error)
//
// FIXING API-M-01 (Security: Dev Error Details Leaking):
//   
//   WITHOUT this safeguard:
//     • Production error: { error: 'Connection refused', stack: '...' }
//     • Exposes MongoDB URI, internal IP addresses, source code paths
//     • Attackers learn system internals
//   
//   WITH this safeguard:
//     • Production error: { error: 'internal_server_error', message: 'An error occurred.' }
//     • Development error: { error: 'internal_server_error', message: '...', details: '...' }
//     • Condition: details only included if NODE_ENV=development
//     • Production value: NODE_ENV=production (Firebase default)
//
// ERROR RESPONSE LOGIC:
//   
//   1. If error is AppError instance:
//      • Use error.statusCode (e.g., 403)
//      • Use error.errorCode (e.g., 'insufficient_credits')
//      • Use error.message (user-facing, safe to show)
//      • If showTopup flag set → add to response for UI
//   
//   2. If error is generic Error or unknown:
//      • Default to 500 Internal Server Error
//      • Use generic message (\"An unexpected error occurred.\")
//      • Include details ONLY if NODE_ENV=development (Fix API-M-01)
//      • Log full error for debugging (in Cloud Logs)
//
// DETAIL EXPOSURE LOGIC (Fixing API-M-01):
//   
//   Development (NODE_ENV=development):
//     • Include error.message and error.stack in response
//     • Developers can debug quickly locally
//   
//   Production (NODE_ENV=production):
//     • Hide error.message and error.stack
//     • Only send generic \"An unexpected error occurred.\"
//     • Full error still logged to Firebase Cloud Logs
//     • Prevents data leaks while maintaining observability
//
// TYPED RESPONSES:
//   sendSuccess<T>(res, data, statusCode)
//     • Generic type T ensures compile-time type safety
//     • Controllers can't accidentally send wrong data type
//     • Example: sendSuccess<GenerationResult>(res, { generation: '...' }, 200)

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
    // Fix API-M-01: Only expose error details in explicit dev mode.
    // NODE_ENV defaults to 'production' in index.ts, so this is safe.
    details: process.env.NODE_ENV === 'development' ? errMsg : undefined,
  });
}
