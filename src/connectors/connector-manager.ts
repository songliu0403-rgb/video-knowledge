import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectorSchema, type Connector } from '../contracts/index.js';
import { readJsonFileSync, writeJsonFileSync } from '../state/json-file-store.js';

const connectorRuntimeSchema = connectorSchema.extend({
  title: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const connectorMutationSchema = z.object({
  connectorId: z.string().min(1),
  connectorType: z.enum(['filesystem', 'runtime']),
  title: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const connectorPatchSchema = z.object({
  title: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const connectorFileSchema = z.object({
  connectors: z.array(connectorRuntimeSchema).default([]),
});

export type ConnectorRuntime = Connector & {
  title?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ConnectorManager = {
  listAll: () => ConnectorRuntime[];
  get: (connectorId: string) => ConnectorRuntime | undefined;
  create?: (input: unknown) => ConnectorRuntime;
  update?: (connectorId: string, patch: unknown) => ConnectorRuntime | undefined;
  test?: (connectorId: string) => ConnectorRuntime | undefined;
  disable?: (connectorId: string) => ConnectorRuntime | undefined;
  delete?: (connectorId: string) => boolean;
};

function getConnectorHealthStatus(connector: ConnectorRuntime): ConnectorRuntime['status'] {
  if (!connector.enabled) {
    return 'offline';
  }

  if (connector.connectorType === 'filesystem') {
    const rootPath =
      typeof connector.config?.rootPath === 'string'
        ? connector.config.rootPath
        : typeof connector.config?.vaultPath === 'string'
          ? connector.config.vaultPath
          : undefined;

    if (!rootPath) {
      return 'misconfigured';
    }

    try {
      return statSync(rootPath).isDirectory() ? 'ready' : 'misconfigured';
    } catch {
      return 'misconfigured';
    }
  }

  if (connector.connectorType === 'runtime') {
    return connector.config ? 'ready' : 'misconfigured';
  }

  return 'misconfigured';
}

class MutableConnectorManager implements ConnectorManager {
  private connectors: ConnectorRuntime[];
  private connectorsById: Map<string, ConnectorRuntime>;

  constructor(
    connectors: ConnectorRuntime[],
    private readonly filePath?: string,
  ) {
    this.connectors = connectors.map((connector) => connectorRuntimeSchema.parse(connector));
    this.connectorsById = new Map(this.connectors.map((connector) => [connector.connectorId, connector]));
  }

  listAll(): ConnectorRuntime[] {
    return [...this.connectors];
  }

  get(connectorId: string): ConnectorRuntime | undefined {
    return this.connectorsById.get(connectorId);
  }

  create(input: unknown): ConnectorRuntime {
    const parsed = connectorMutationSchema.parse(input);
    const existing = this.get(parsed.connectorId);

    if (existing) {
      throw new Error(`Connector ${parsed.connectorId} already exists.`);
    }

    const connector = connectorRuntimeSchema.parse({
      ...parsed,
      enabled: true,
      status: 'offline',
    });

    this.connectors = [...this.connectors, connector];
    this.reindexAndPersist();
    return connector;
  }

  update(connectorId: string, patch: unknown): ConnectorRuntime | undefined {
    const current = this.get(connectorId);

    if (!current) {
      return undefined;
    }

    const parsedPatch = connectorPatchSchema.parse(patch);
    const updated = connectorRuntimeSchema.parse({
      ...current,
      ...parsedPatch,
      connectorId: current.connectorId,
      connectorType: current.connectorType,
    });

    this.connectors = this.connectors.map((connector) =>
      connector.connectorId === connectorId ? updated : connector,
    );
    this.reindexAndPersist();
    return updated;
  }

  test(connectorId: string): ConnectorRuntime | undefined {
    const current = this.get(connectorId);

    if (!current) {
      return undefined;
    }

    const updated = connectorRuntimeSchema.parse({
      ...current,
      status: getConnectorHealthStatus(current),
    });

    this.connectors = this.connectors.map((connector) =>
      connector.connectorId === connectorId ? updated : connector,
    );
    this.reindexAndPersist();
    return updated;
  }

  disable(connectorId: string): ConnectorRuntime | undefined {
    const current = this.get(connectorId);

    if (!current) {
      return undefined;
    }

    const updated = connectorRuntimeSchema.parse({
      ...current,
      enabled: false,
      status: 'offline',
    });

    this.connectors = this.connectors.map((connector) =>
      connector.connectorId === connectorId ? updated : connector,
    );
    this.reindexAndPersist();
    return updated;
  }

  delete(connectorId: string): boolean {
    const current = this.get(connectorId);

    if (!current) {
      return false;
    }

    this.connectors = this.connectors.filter((connector) => connector.connectorId !== connectorId);
    this.reindexAndPersist();
    return true;
  }

  private reindexAndPersist(): void {
    this.connectorsById = new Map(this.connectors.map((connector) => [connector.connectorId, connector]));

    if (!this.filePath) {
      return;
    }

    writeJsonFileSync(this.filePath, {
      connectors: this.connectors,
    });
  }
}

export function createConnectorManager(filePath = fileURLToPath(new URL('../../data/connectors.json', import.meta.url))): ConnectorManager {
  const connectors = existsSync(filePath)
    ? connectorFileSchema.parse(readJsonFileSync<{ connectors: ConnectorRuntime[] }>(filePath)).connectors
    : [];

  return new MutableConnectorManager(connectors, filePath);
}
