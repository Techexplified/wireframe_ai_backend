// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ─── utils/errors.ts — Custom AppError Class Hierarchy
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Defines custom error classes for typed error handling throughout the application.
//   Replaces generic JavaScript Error with domain-specific errors.
//   Every error includes: message (user-facing), statusCode (HTTP), errorCode (machine-readable).
//
// ERROR HIERARCHY:
//   AppError (base class)
//     ├── BadRequestError (400) — Client sent invalid input
//     ├── UnauthorizedError (401) — Authentication failed
//     ├── ForbiddenError (403) — Authenticated but not authorized
//     ├── NotFoundError (404) — Resource not found
//     ├── ConflictError (409) — Resource state conflict (duplicate, etc.)
//     └── BadGatewayError (502) — Upstream service error
//
// DESIGN PATTERN:
//   Typed errors allow controllers to:
//     1. Throw specific errors (clear intent)
//     2. No error strings mixed with status codes
//     3. Catch/handle by type if needed
//     4. error.middleware.ts reads statusCode and errorCode
//   
//   Example:
//     throw new ForbiddenError('User is not Pro', 'plan_required', true);
//   
//   Result:
//     { error: 'plan_required', message: 'User is not Pro', status_code: 403 }
//
// KEY PROPERTIES:
//   
//   message: string
//     • User-facing error message sent to client
//     • Explains what went wrong in understandable terms
//     • Example: "Not enough credits. Please upgrade or purchase credits."
//     • Should NOT expose system internals (no stack traces, connection strings, etc.)
//   
//   statusCode: number
//     • HTTP status code (400, 401, 403, 404, 409, 500, 502)
//     • Determines response status header
//     • Guides client on how to handle error (retry, auth, upgrade, etc.)
//   
//   errorCode: string
//     • Machine-readable error identifier
//     • Used by client to handle specific errors programmatically
//     • Examples: 'insufficient_credits', 'plan_required', 'rate_limit_exceeded'
//     • Logged for analytics and debugging
//   
//   showTopup?: boolean
//     • Optional flag (ForbiddenError specific)
//     • If true: client should show "upgrade to Pro" or "buy credits" UI
//     • If false: generic Forbidden message (plan_required → true, identity_mismatch → false)
//     • Used to drive UX: some errors are worth showing monetization prompt
//   
//   details?: unknown
//     • Optional debug information (not sent to client in production)
//     • Only exposed if NODE_ENV=development
//     • Helps developers debug without exposing sensitive data in production logs
//
// USAGE IN CONTROLLERS:
//   
//   // Invalid input validation
//   if (!prompt || !prompt.trim()) {
//     throw new BadRequestError('Prompt cannot be empty', 'invalid_prompt');
//   }
//   
//   // Authentication failure
//   if (!firebaseToken) {
//     throw new UnauthorizedError('No token provided', 'missing_token');
//   }
//   
//   // Authorization failure
//   if (plan !== 'pro') {
//     throw new ForbiddenError('Only Pro users can top-up', 'plan_required', true);
//   }
//   
//   // Resource not found
//   if (!user) {
//     throw new NotFoundError('User does not exist', 'user_not_found');
//   }
//   
//   // State conflict
//   if (user.subscription_cancelled) {
//     throw new ConflictError('Subscription already cancelled', 'subscription_cancelled');
//   }
//   
//   // Upstream error
//   if (openRouterResponse.status === 502) {
//     throw new BadGatewayError('OpenRouter unavailable', 'ai_unavailable');
//   }
//
// ERROR HANDLING FLOW:
//   1. Controller throws AppError (or subclass)
//   2. Error bubbles up (not caught)
//   3. Async wrapper: catch(err) → next(err)
//   4. Express error middleware catches via next(err)
//   5. error.middleware.ts calls sendError(err)
//   6. sendError() reads statusCode + errorCode, formats JSON response
//   7. HTTP response sent to client with appropriate status + error JSON
//
// WHY CUSTOM ERRORS vs. GENERIC throw new Error():
//   ✗ Generic Error:
//     throw new Error('Not authorized');  // No status code; middleware defaults to 500
//     throw new Error('400 client error'); // Fragile; parsing error message
//   
//   ✓ Custom Error:
//     throw new UnauthorizedError('...', 'not_authorized');
//     // statusCode=401, errorCode='not_authorized', message='...'
//     // No parsing needed; structured data

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly showTopup?: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode = 500,
    errorCode = 'internal_error',
    showTopup?: boolean,
    details?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.showTopup = showTopup;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request payload', errorCode = 'invalid_request') {
    super(message, 400, errorCode);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', errorCode = 'unauthorized') {
    super(message, 401, errorCode);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'Access forbidden',
    errorCode = 'forbidden',
    showTopup?: boolean
  ) {
    super(message, 403, errorCode, showTopup);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', errorCode = 'not_found') {
    super(message, 404, errorCode);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource state conflict', errorCode = 'conflict') {
    super(message, 409, errorCode);
  }
}

export class BadGatewayError extends AppError {
  constructor(message = 'Upstream service error', errorCode = 'upstream_error') {
    super(message, 502, errorCode);
  }
}
