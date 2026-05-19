import type { Capability, InputField } from '../contracts/index.js';
import { AppError } from './app-error.js';

export type ValidateCapabilityInputResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: AppError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFieldValue(fieldName: string, field: InputField, value: unknown): AppError | null {
  if (field.type === 'string' || field.type === 'text') {
    if (typeof value !== 'string') {
      return new AppError('validation_failed', `Field ${fieldName} must be a string.`, {
        details: { field: fieldName, expected: field.type },
      });
    }

    return null;
  }

  if (field.type === 'string_array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      return new AppError('validation_failed', `Field ${fieldName} must be an array of strings.`, {
        details: { field: fieldName, expected: 'string_array' },
      });
    }

    return null;
  }

  if (field.type === 'object') {
    if (!isPlainObject(value)) {
      return new AppError('validation_failed', `Field ${fieldName} must be an object.`, {
        details: { field: fieldName, expected: 'object' },
      });
    }
  }

  return null;
}

export function validateCapabilityInput(
  capability: Capability,
  input: Record<string, unknown>,
): ValidateCapabilityInputResult {
  for (const [fieldName, field] of Object.entries(capability.inputSchema)) {
    const value = input[fieldName];

    if (value === undefined || value === null) {
      if (field.required) {
        return {
          ok: false,
          error: new AppError('validation_failed', `Missing required field ${fieldName}.`, {
            details: { field: fieldName, expected: field.type, reason: 'required' },
          }),
        };
      }

      continue;
    }

    const fieldError = validateFieldValue(fieldName, field, value);

    if (fieldError) {
      return { ok: false, error: fieldError };
    }
  }

  return { ok: true, value: input };
}
