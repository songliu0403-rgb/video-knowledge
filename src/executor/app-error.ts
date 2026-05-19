export type AppErrorCode =
  | 'capability_not_found'
  | 'package_unavailable'
  | 'validation_failed'
  | 'connector_not_found'
  | 'connector_unavailable'
  | 'resource_not_found'
  | 'unsupported_operation'
  | 'internal_error';

export type AppErrorDetails = Record<string, unknown>;

function sanitizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    const output: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      const sanitized = sanitizeJsonValue(nestedValue, seen);

      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
    }

    return output;
  }

  return String(value);
}

export class AppError extends Error {
  readonly code: AppErrorCode;

  readonly details: AppErrorDetails;

  readonly statusCode: number;

  constructor(
    code: AppErrorCode,
    message: string,
    options: { details?: AppErrorDetails; statusCode?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details ?? {};
    this.statusCode = options.statusCode ?? 400;
  }

  toJSON(): { code: AppErrorCode; message: string; details: AppErrorDetails } {
    return {
      code: this.code,
      message: this.message,
      details: sanitizeJsonValue(this.details) as AppErrorDetails,
    };
  }
}
