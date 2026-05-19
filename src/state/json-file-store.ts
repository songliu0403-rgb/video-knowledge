import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, 'utf8');
  return JSON.parse(contents) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonFileSync<T>(filePath: string): T {
  const contents = readFileSync(filePath, 'utf8');
  return JSON.parse(contents) as T;
}

export function writeJsonFileSync(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
