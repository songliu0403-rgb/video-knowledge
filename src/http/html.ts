import type { ServerResponse } from 'node:http';

export function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
}
