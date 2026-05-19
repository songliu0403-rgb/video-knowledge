import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJsonBody<T = unknown>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');

  if (!rawBody) {
    return undefined as T;
  }

  return JSON.parse(rawBody) as T;
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}
