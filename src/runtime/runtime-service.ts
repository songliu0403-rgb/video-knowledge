import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runtimeSchema, type Runtime } from '../contracts/index.js';
import { readJsonFileSync, writeJsonFileSync } from '../state/json-file-store.js';

const runtimeFileSchema = z.object({
  runtimes: z.array(runtimeSchema).default([]),
});

const runtimeInstallPayloadSchema = z.object({
  binaryPath: z.string().min(1).optional(),
  installPath: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
});

const runtimeRelinkPayloadSchema = z.object({
  binaryPath: z.string().min(1).optional(),
  installPath: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
});

export type RuntimeService = {
  listAll: () => Runtime[];
  get: (runtimeId: string) => Runtime | undefined;
  detect?: (runtimeId: string) => Runtime | undefined;
  install?: (runtimeId: string, payload?: unknown) => Runtime | undefined;
  uninstall?: (runtimeId: string) => Runtime | undefined;
  relink?: (runtimeId: string, payload: unknown) => Runtime | undefined;
};

function getDetectionKind(runtime: Runtime): 'binary' | 'directory' {
  return runtime.detection?.kind ?? 'binary';
}

function getMissingDirectoryEntries(runtime: Runtime, installPath: string): string[] {
  const requiredEntries = runtime.detection?.requiredEntries ?? [];
  if (!existsSync(installPath)) {
    return [...requiredEntries];
  }

  return requiredEntries.filter((entry) => !existsSync(join(installPath, entry)));
}

function canUseDirectory(runtime: Runtime, installPath: string): boolean {
  return getMissingDirectoryEntries(runtime, installPath).length === 0;
}

function resolveDirectoryInstallPath(runtime: Runtime): string | undefined {
  const candidates = [runtime.installPath, ...(runtime.detection?.candidatePaths ?? [])].filter(
    (entry): entry is string => Boolean(entry),
  );

  return candidates.find((candidate) => canUseDirectory(runtime, candidate));
}

function resolveBinaryPath(runtime: Runtime): string | undefined {
  const candidates = [runtime.binaryPath, ...(runtime.detection?.candidatePaths ?? [])].filter(
    (entry): entry is string => Boolean(entry),
  );

  return candidates.find((candidate) => existsSync(candidate));
}

function computeRuntimeHealth(runtime: Runtime): Runtime {
  const checkedAt = new Date().toISOString();

  if (getDetectionKind(runtime) === 'directory') {
    const detectedInstallPath = resolveDirectoryInstallPath(runtime);

    if (detectedInstallPath) {
      return runtimeSchema.parse({
        ...runtime,
        installPath: detectedInstallPath,
        installState: 'installed',
        healthState: 'ready',
        lastCheck: {
          checkedAt,
          status: 'ready',
          reason: 'directory_detected',
          sourcePath: detectedInstallPath,
          missingEntries: [],
        },
      });
    }

    if (runtime.installPath) {
      const missingEntries = getMissingDirectoryEntries(runtime, runtime.installPath);
      return runtimeSchema.parse({
        ...runtime,
        installState: 'broken',
        healthState: 'broken',
        lastCheck: {
          checkedAt,
          status: 'broken',
          reason: existsSync(runtime.installPath) ? 'required_entries_missing' : 'configured_install_path_missing',
          sourcePath: runtime.installPath,
          missingEntries,
        },
      });
    }

    const existingCandidate = (runtime.detection?.candidatePaths ?? []).find((candidate) => existsSync(candidate));

    if (existingCandidate) {
      return runtimeSchema.parse({
        ...runtime,
        installState: 'broken',
        healthState: 'broken',
        lastCheck: {
          checkedAt,
          status: 'broken',
          reason: 'required_entries_missing',
          sourcePath: existingCandidate,
          missingEntries: getMissingDirectoryEntries(runtime, existingCandidate),
        },
      });
    }

    if ((runtime.detection?.candidatePaths ?? []).length > 0) {
      return runtimeSchema.parse({
        ...runtime,
        installState: 'missing',
        healthState: 'missing',
        lastCheck: {
          checkedAt,
          status: 'missing',
          reason: 'candidate_paths_missing',
          missingEntries: runtime.detection?.requiredEntries ?? [],
        },
      });
    }

    return runtimeSchema.parse({
      ...runtime,
      installState: 'missing',
      healthState: 'missing',
      lastCheck: {
        checkedAt,
        status: 'missing',
        reason: 'not_configured',
        missingEntries: runtime.detection?.requiredEntries ?? [],
      },
    });
  }

  const detectedBinaryPath = resolveBinaryPath(runtime);

  if (detectedBinaryPath) {
    return runtimeSchema.parse({
        ...runtime,
        binaryPath: detectedBinaryPath,
        installState: 'installed',
        healthState: 'ready',
        lastCheck: {
          checkedAt,
          status: 'ready',
          reason: 'binary_detected',
          sourcePath: detectedBinaryPath,
          missingEntries: [],
        },
      });
    }

    if (runtime.binaryPath) {
      return runtimeSchema.parse({
        ...runtime,
        installState: 'broken',
        healthState: 'broken',
        lastCheck: {
          checkedAt,
          status: 'broken',
          reason: 'configured_binary_missing',
          sourcePath: runtime.binaryPath,
          missingEntries: [],
        },
      });
    }

    if ((runtime.detection?.candidatePaths ?? []).length > 0) {
      return runtimeSchema.parse({
        ...runtime,
        installState: 'missing',
        healthState: 'missing',
        lastCheck: {
          checkedAt,
          status: 'missing',
          reason: 'candidate_paths_missing',
          missingEntries: [],
        },
      });
    }

    if (runtime.runtimeType === 'service' && runtime.installState === 'installed') {
      return runtimeSchema.parse({
        ...runtime,
        installState: 'installed',
        healthState: 'ready',
        lastCheck: {
          checkedAt,
          status: 'ready',
          reason: 'service_ready_without_path',
          missingEntries: [],
        },
      });
    }

  return runtimeSchema.parse({
    ...runtime,
    installState: 'missing',
    healthState: 'missing',
    lastCheck: {
      checkedAt,
      status: 'missing',
      reason: 'not_configured',
      missingEntries: [],
    },
  });
}

class MutableRuntimeService implements RuntimeService {
  private runtimes: Runtime[];
  private runtimesById: Map<string, Runtime>;

  constructor(
    runtimes: Runtime[],
    private readonly filePath?: string,
  ) {
    this.runtimes = runtimes.map((runtime) => runtimeSchema.parse(runtime));
    this.runtimesById = new Map(this.runtimes.map((runtime) => [runtime.runtimeId, runtime]));
  }

  listAll(): Runtime[] {
    return [...this.runtimes];
  }

  get(runtimeId: string): Runtime | undefined {
    return this.runtimesById.get(runtimeId);
  }

  detect(runtimeId: string): Runtime | undefined {
    const runtime = this.get(runtimeId);

    if (!runtime) {
      return undefined;
    }

    return this.update(runtimeId, () => computeRuntimeHealth(runtime));
  }

  install(runtimeId: string, payload?: unknown): Runtime | undefined {
    const runtime = this.get(runtimeId);

    if (!runtime) {
      return undefined;
    }

    const parsed = runtimeInstallPayloadSchema.parse(payload ?? {});
    const detectionKind = getDetectionKind(runtime);
    const candidate: Runtime = runtimeSchema.parse({
      ...runtime,
      ...(parsed.binaryPath ? { binaryPath: parsed.binaryPath } : {}),
      ...(parsed.installPath ? { installPath: parsed.installPath } : {}),
      ...(parsed.version ? { version: parsed.version } : {}),
      installState: 'installed',
      healthState: runtime.runtimeType === 'service' && detectionKind !== 'directory' && !parsed.binaryPath ? 'ready' : runtime.healthState,
    });

    if (candidate.runtimeType === 'application' && detectionKind === 'binary' && !candidate.binaryPath) {
      throw new Error(`Runtime ${runtimeId} requires a binaryPath when installing an application runtime.`);
    }

    if (detectionKind === 'directory' && !candidate.installPath) {
      throw new Error(`Runtime ${runtimeId} requires an installPath when using directory detection.`);
    }

    return this.update(runtimeId, () => computeRuntimeHealth(candidate));
  }

  uninstall(runtimeId: string): Runtime | undefined {
    const runtime = this.get(runtimeId);

    if (!runtime) {
      return undefined;
    }

    return this.update(runtimeId, () => ({
      runtimeId: runtime.runtimeId,
      name: runtime.name,
      runtimeType: runtime.runtimeType,
      installState: 'missing',
      healthState: 'missing',
      ...(runtime.detection ? { detection: runtime.detection } : {}),
    }));
  }

  relink(runtimeId: string, payload: unknown): Runtime | undefined {
    const runtime = this.get(runtimeId);

    if (!runtime) {
      return undefined;
    }

    const parsed = runtimeRelinkPayloadSchema.parse(payload);
    const detectionKind = getDetectionKind(runtime);

    if (detectionKind === 'directory' && !parsed.installPath) {
      throw new Error(`Runtime ${runtimeId} requires an installPath when relinking a directory runtime.`);
    }

    if (detectionKind === 'binary' && !parsed.binaryPath) {
      throw new Error(`Runtime ${runtimeId} requires a binaryPath when relinking a binary runtime.`);
    }

    return this.update(runtimeId, () =>
      computeRuntimeHealth(
        runtimeSchema.parse({
        ...runtime,
        ...(parsed.binaryPath ? { binaryPath: parsed.binaryPath } : {}),
        ...(parsed.installPath ? { installPath: parsed.installPath } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        }),
      ),
    );
  }

  private update(runtimeId: string, updater: (runtime: Runtime) => Runtime): Runtime | undefined {
    const runtime = this.get(runtimeId);

    if (!runtime) {
      return undefined;
    }

    const updated = runtimeSchema.parse(updater(runtime));
    this.runtimes = this.runtimes.map((entry) =>
      entry.runtimeId === runtimeId ? updated : entry,
    );
    this.reindexAndPersist();
    return updated;
  }

  private reindexAndPersist(): void {
    this.runtimesById = new Map(this.runtimes.map((runtime) => [runtime.runtimeId, runtime]));

    if (!this.filePath) {
      return;
    }

    writeJsonFileSync(this.filePath, {
      runtimes: this.runtimes,
    });
  }
}

export function createRuntimeService(filePath = fileURLToPath(new URL('../../data/runtimes.json', import.meta.url))): RuntimeService {
  const runtimes = existsSync(filePath)
    ? runtimeFileSchema.parse(readJsonFileSync<{ runtimes: Runtime[] }>(filePath)).runtimes
    : [];

  return new MutableRuntimeService(runtimes, filePath);
}
