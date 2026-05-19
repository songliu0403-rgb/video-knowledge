import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AppError } from '../../executor/app-error.js';

export function failVideoKnowledgeDataError(message: string, details: Record<string, unknown>): never {
  throw new AppError('unsupported_operation', message, {
    details,
    statusCode: 501,
  });
}

export function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    failVideoKnowledgeDataError(`Video knowledge file ${filePath} contains invalid JSON.`, {
      filePath,
      reason: 'invalid_json',
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    failVideoKnowledgeDataError(`Video knowledge file ${filePath} must contain a JSON object.`, {
      filePath,
      reason: 'invalid_shape',
    });
  }

  return parsed as Record<string, unknown>;
}

export function readTextFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  return readFileSync(filePath, 'utf8');
}

export function transcriptInvalidReason(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  const trimmed = text.trim();

  if (!trimmed) {
    return undefined;
  }

  const head = trimmed.slice(0, 4000);

  if (/^Traceback \(most recent call last\):/m.test(head)) {
    return 'error_traceback';
  }

  if (/\b(?:httpx|httpcore)\.RemoteProtocolError\b/.test(head)) {
    return 'error_traceback';
  }

  return undefined;
}

export function isUsableTranscriptText(text: string | undefined): boolean {
  return Boolean(text?.trim()) && transcriptInvalidReason(text) === undefined;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const directoryPath = dirname(filePath);
  const tempPath = join(directoryPath, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  mkdirSync(directoryPath, { recursive: true });

  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }

    throw error;
  }
}

export function normalizeInput(value: unknown): string {
  return String(value ?? '').trim();
}

export function extractBilibiliVideoId(value: unknown): string | undefined {
  const text = normalizeInput(value);
  const match = /\b(BV[0-9A-Za-z]+)\b/.exec(text);

  return match?.[1];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function valueToString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

export function valueToNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = valueToNumber(value);

  if (!seconds) {
    return undefined;
  }

  return new Date(seconds * 1000).toISOString();
}

export function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function uniqueByTitle(values: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const value of values) {
    const key = asString(value.title) ?? JSON.stringify(value);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(value);
  }

  return results;
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function parseLimit(value: unknown, fallback: number): number {
  const parsed = valueToNumber(value);

  if (!parsed || parsed < 1) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), 5000);
}

export function parseOffset(value: unknown): number {
  const parsed = valueToNumber(value);

  if (parsed === undefined || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseDelayMs(value: unknown, fallback: number): number {
  const parsed = valueToNumber(value);

  if (parsed === undefined || parsed < 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), 10000);
}

export function getMutableObjectProperty(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = asObject(parent[key]);

  if (current) {
    return current;
  }

  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export function paginate<T>(items: T[], input: Record<string, unknown>): { items: T[]; limit: number; offset: number; total: number } {
  const limit = parseLimit(input.limit, 50);
  const offset = parseOffset(input.offset);

  return {
    items: items.slice(offset, offset + limit),
    limit,
    offset,
    total: items.length,
  };
}
