import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VideoKnowledgeConnector } from './types.js';

let cachedWorkspaceRootPath: string | undefined;

export function getWorkspaceRootPath(): string {
  if (cachedWorkspaceRootPath) {
    return cachedWorkspaceRootPath;
  }

  let currentDirectory = dirname(fileURLToPath(import.meta.url));

  while (!existsSync(join(currentDirectory, 'package.json'))) {
    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  cachedWorkspaceRootPath = currentDirectory;
  return currentDirectory;
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function windowsPathToWslPath(path: string): string {
  const drive = path[0].toLowerCase();
  const rest = path.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive}/${rest}`;
}

export function resolveConfiguredPath(configuredPath: string): string {
  if (process.platform !== 'win32' && isWindowsAbsolutePath(configuredPath)) {
    return windowsPathToWslPath(configuredPath);
  }

  return isAbsolute(configuredPath)
    ? configuredPath
    : join(getWorkspaceRootPath(), configuredPath);
}

export function getVideoRootPath(connector: VideoKnowledgeConnector): string {
  const config = connector.config ?? {};

  if (typeof config.rootPath === 'string') {
    return resolveConfiguredPath(config.rootPath);
  }

  return join(getWorkspaceRootPath(), '..', 'data', 'video-poc');
}

export function getCollectionsRootPath(connector: VideoKnowledgeConnector): string {
  const config = connector.config ?? {};

  if (typeof config.collectionsRootPath === 'string') {
    return resolveConfiguredPath(config.collectionsRootPath);
  }

  return join(getVideoRootPath(connector), '_collections');
}

export function getQueuesRootPath(connector: VideoKnowledgeConnector): string {
  const config = connector.config ?? {};

  if (typeof config.queuesRootPath === 'string') {
    return resolveConfiguredPath(config.queuesRootPath);
  }

  return join(getVideoRootPath(connector), '_queues');
}

export function getConfiguredString(connector: VideoKnowledgeConnector, key: string): string | undefined {
  const value = connector.config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const preferredBilibiliCookieNames = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4',
  'b_nut',
  'CURRENT_FNVAL',
  'bili_ticket',
  'bili_ticket_expires',
];

function normalizeBilibiliCookie(rawCookie: string): string {
  const trimmed = rawCookie.trim();

  if (!trimmed) {
    return '';
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (lines.length > 0 && lines.every((line) => line.includes('\t'))) {
    const values = new Map<string, string>();

    for (const line of lines) {
      const columns = line.split('\t');

      if (columns.length < 7) {
        continue;
      }

      const [domain, , , , , name, value] = columns;

      if (!domain.toLowerCase().includes('bilibili.com') && !domain.toLowerCase().includes('bilibili.cn')) {
        continue;
      }

      if (name && value) {
        values.set(name, value);
      }
    }

    const orderedNames = preferredBilibiliCookieNames.filter((name) => values.has(name));
    orderedNames.push(...[...values.keys()].filter((name) => !orderedNames.includes(name)).sort());

    return orderedNames.map((name) => `${name}=${values.get(name)}`).join('; ');
  }

  return lines.join(' ');
}

export function getBilibiliCookie(connector: VideoKnowledgeConnector): { cookie: string; source: string } | undefined {
  const inlineCookie = getConfiguredString(connector, 'bilibiliCookie') ?? process.env.BILIBILI_COOKIE;

  if (inlineCookie?.trim()) {
    return { cookie: normalizeBilibiliCookie(inlineCookie), source: getConfiguredString(connector, 'bilibiliCookie') ? 'connector.config.bilibiliCookie' : 'env.BILIBILI_COOKIE' };
  }

  const cookieFilePath = getConfiguredString(connector, 'bilibiliCookieFilePath') ?? process.env.BILIBILI_COOKIE_FILE;

  if (!cookieFilePath) {
    return undefined;
  }

  const resolvedPath = resolveConfiguredPath(cookieFilePath);

  if (!existsSync(resolvedPath)) {
    return undefined;
  }

  const cookie = normalizeBilibiliCookie(readFileSync(resolvedPath, 'utf8'));

  return cookie ? { cookie, source: `file:${resolvedPath}` } : undefined;
}
