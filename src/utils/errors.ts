// ─── utils/errors.ts — Custom AppError Class Hierarchy ────────────────────────

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
