import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { executionLogEntrySchema, type ExecutionLogEntry } from '../contracts/index.js';
import { readJsonFileSync, writeJsonFileSync } from './json-file-store.js';

export type ExecutionLogStore = {
  listAll: () => ExecutionLogEntry[];
  append: (entry: ExecutionLogEntry) => void;
};

function loadExecutionLogs(filePath: string): ExecutionLogEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const parsed = readJsonFileSync<unknown>(filePath);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    const result = executionLogEntrySchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

export function getDefaultExecutionLogPath(): string {
  return getDefaultExecutionLogPathFromModuleUrl(import.meta.url);
}

export function getDefaultExecutionLogPathFromModuleUrl(moduleUrl: string): string {
  let currentDirectory = dirname(fileURLToPath(moduleUrl));

  while (!existsSync(join(currentDirectory, 'package.json'))) {
    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  const workspaceHash = createHash('sha256').update(currentDirectory).digest('hex').slice(0, 16);

  return join(tmpdir(), 'capability-repository', workspaceHash, 'executions.json');
}

export function createExecutionLogStore(
  filePath = getDefaultExecutionLogPath(),
): ExecutionLogStore {
  const entries = loadExecutionLogs(filePath);

  return {
    listAll: () => [...entries],
    append: (entry) => {
      entries.push(entry);
      writeJsonFileSync(filePath, entries);
    },
  };
}
