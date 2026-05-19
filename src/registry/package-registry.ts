import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type {
  AccessPolicy,
  Capability,
  FunctionPackage,
  FunctionPackageType,
  PluginModule,
} from '../contracts/index.js';
import {
  accessPolicySchema,
  functionPackageSchema,
} from '../contracts/index.js';
import { readJsonFileSync as readJsonFileFromDisk, writeJsonFileSync } from '../state/json-file-store.js';

const packageStateFileSchema = z.object({
  packages: z.array(functionPackageSchema).default([]),
});

type PackageRegistryOptions = {
  plugins: PluginModule[];
  persistedPackages?: FunctionPackage[];
  filePath?: string;
};

type PackageTemplate = {
  name: string;
  packageType: FunctionPackageType;
  runtimeRequirements?: FunctionPackage['runtimeRequirements'];
};

const packageTemplates: Record<string, PackageTemplate> = {
  'plugin.obsidian': {
    name: 'Obsidian Integration',
    packageType: 'integration',
  },
  'plugin.database': {
    name: 'Database Workspace',
    packageType: 'workspace',
    runtimeRequirements: [{ runtimeId: 'runtime.database.main', required: true }],
  },
  'plugin.video-knowledge': {
    name: 'Video Knowledge Workspace',
    packageType: 'workspace',
  },
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function deriveRiskLevel(capability: Capability): AccessPolicy['riskLevel'] {
  if (capability.sideEffectLevel === 'irreversible') {
    return 'high';
  }

  if (capability.category === 'command' || capability.sideEffectLevel === 'reversible') {
    return 'medium';
  }

  return 'low';
}

function deriveConfirmationPolicy(capability: Capability): AccessPolicy['confirmationPolicy'] {
  return capability.category === 'command' || capability.sideEffectLevel !== 'none'
    ? 'manual'
    : 'never';
}

function deriveDefaultPackage(plugin: PluginModule): FunctionPackage {
  const template = packageTemplates[plugin.manifest.pluginId];
  const capabilities = plugin.manifest.capabilities;

  return functionPackageSchema.parse({
    packageId: plugin.manifest.pluginId,
    ownerPluginId: plugin.manifest.pluginId,
    name: template?.name ?? plugin.manifest.pluginId,
    packageType: template?.packageType ?? 'workspace',
    installState: 'installed',
    enabled: true,
    manualEnabled: true,
    agentEnabled: capabilities.some((capability) => capability.exposure === 'auto'),
    runtimeRequirements: template?.runtimeRequirements ?? [],
    requiredConnectorIds: unique(capabilities.map((capability) => capability.connectorId)),
    providedCapabilityIds: capabilities.map((capability) => capability.capabilityId),
  });
}

function mergePackageState(defaultPackage: FunctionPackage, persistedPackage?: FunctionPackage): FunctionPackage {
  if (!persistedPackage) {
    return defaultPackage;
  }

  return functionPackageSchema.parse({
    ...defaultPackage,
    ...persistedPackage,
    packageId: defaultPackage.packageId,
    ownerPluginId: defaultPackage.ownerPluginId,
    requiredConnectorIds:
      persistedPackage.requiredConnectorIds.length > 0
        ? persistedPackage.requiredConnectorIds
        : defaultPackage.requiredConnectorIds,
    providedCapabilityIds:
      persistedPackage.providedCapabilityIds.length > 0
        ? persistedPackage.providedCapabilityIds
        : defaultPackage.providedCapabilityIds,
    runtimeRequirements:
      persistedPackage.runtimeRequirements.length > 0
        ? persistedPackage.runtimeRequirements
        : defaultPackage.runtimeRequirements,
  });
}

export class PackageRegistry {
  private packages: FunctionPackage[];
  private packagesById: Map<string, FunctionPackage>;
  private readonly capabilitiesByPackageId: Map<string, Capability[]>;
  private readonly accessPoliciesByPackageId: Map<string, AccessPolicy[]>;
  private readonly packageIdByCapabilityId: Map<string, string>;
  private readonly filePath?: string;

  constructor(options: PackageRegistryOptions) {
    this.filePath = options.filePath;
    const persistedById = new Map(
      (options.persistedPackages ?? []).map((functionPackage) => [functionPackage.packageId, functionPackage]),
    );

    this.packages = options.plugins.map((plugin) => {
      const defaultPackage = deriveDefaultPackage(plugin);
      return mergePackageState(defaultPackage, persistedById.get(defaultPackage.packageId));
    });
    this.packagesById = new Map(this.packages.map((functionPackage) => [functionPackage.packageId, functionPackage]));
    this.capabilitiesByPackageId = new Map(
      options.plugins.map((plugin) => [plugin.manifest.pluginId, plugin.manifest.capabilities]),
    );
    this.accessPoliciesByPackageId = new Map(
      options.plugins.map((plugin) => [
        plugin.manifest.pluginId,
        plugin.manifest.capabilities.map((capability) =>
          accessPolicySchema.parse({
            packageId: plugin.manifest.pluginId,
            capabilityId: capability.capabilityId,
            manualEnabled: true,
            agentEnabled: capability.exposure === 'auto',
            riskLevel: deriveRiskLevel(capability),
            confirmationPolicy: deriveConfirmationPolicy(capability),
          }),
        ),
      ]),
    );
    this.packageIdByCapabilityId = new Map(
      this.packages.flatMap((functionPackage) =>
        functionPackage.providedCapabilityIds.map((capabilityId) => [capabilityId, functionPackage.packageId] as const),
      ),
    );
  }

  listAll(): FunctionPackage[] {
    return [...this.packages];
  }

  get(packageId: string): FunctionPackage | undefined {
    return this.packagesById.get(packageId);
  }

  getCapabilities(packageId: string): Capability[] {
    return [...(this.capabilitiesByPackageId.get(packageId) ?? [])];
  }

  getAccessPolicies(packageId: string): AccessPolicy[] {
    return [...(this.accessPoliciesByPackageId.get(packageId) ?? [])];
  }

  getOwningPackage(capabilityId: string): FunctionPackage | undefined {
    const packageId = this.packageIdByCapabilityId.get(capabilityId);
    return packageId ? this.get(packageId) : undefined;
  }

  isCapabilityManualAvailable(capabilityId: string): boolean {
    const functionPackage = this.getOwningPackage(capabilityId);

    if (!functionPackage) {
      return true;
    }

    return (
      functionPackage.installState === 'installed' &&
      functionPackage.enabled &&
      functionPackage.manualEnabled
    );
  }

  isCapabilityAgentAvailable(capabilityId: string): boolean {
    const functionPackage = this.getOwningPackage(capabilityId);

    if (!functionPackage) {
      return true;
    }

    return (
      functionPackage.installState === 'installed' &&
      functionPackage.enabled &&
      functionPackage.manualEnabled &&
      functionPackage.agentEnabled
    );
  }

  listAgentAvailableCapabilityIds(): string[] {
    return this.packages
      .filter((functionPackage) =>
        functionPackage.installState === 'installed' &&
        functionPackage.enabled &&
        functionPackage.manualEnabled &&
        functionPackage.agentEnabled,
      )
      .flatMap((functionPackage) => functionPackage.providedCapabilityIds);
  }

  install(packageId: string): FunctionPackage | undefined {
    return this.updatePackage(packageId, (functionPackage) => ({
      ...functionPackage,
      installState: 'installed',
      enabled: true,
    }));
  }

  enable(packageId: string): FunctionPackage | undefined {
    return this.updatePackage(packageId, (functionPackage) => {
      if (functionPackage.installState !== 'installed') {
        return functionPackage;
      }

      return {
        ...functionPackage,
        enabled: true,
      };
    });
  }

  disable(packageId: string): FunctionPackage | undefined {
    return this.updatePackage(packageId, (functionPackage) => ({
      ...functionPackage,
      enabled: false,
    }));
  }

  uninstall(packageId: string): FunctionPackage | undefined {
    return this.updatePackage(packageId, (functionPackage) => ({
      ...functionPackage,
      installState: 'uninstalled',
      enabled: false,
    }));
  }

  setAgentEnabled(packageId: string, agentEnabled: boolean): FunctionPackage | undefined {
    return this.updatePackage(packageId, (functionPackage) => ({
      ...functionPackage,
      agentEnabled,
    }));
  }

  private updatePackage(
    packageId: string,
    updater: (functionPackage: FunctionPackage) => FunctionPackage,
  ): FunctionPackage | undefined {
    const current = this.packagesById.get(packageId);

    if (!current) {
      return undefined;
    }

    const updated = functionPackageSchema.parse(updater(current));
    this.packages = this.packages.map((functionPackage) =>
      functionPackage.packageId === packageId ? updated : functionPackage,
    );
    this.packagesById = new Map(this.packages.map((functionPackage) => [functionPackage.packageId, functionPackage]));
    this.persist();
    return updated;
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }

    writeJsonFileSync(this.filePath, {
      packages: this.packages,
    });
  }
}

export function createPackageRegistry(options: { plugins?: PluginModule[]; filePath?: string } = {}): PackageRegistry {
  const filePath = options.filePath ?? fileURLToPath(new URL('../../data/packages.json', import.meta.url));
  const persistedPackages = existsSync(filePath)
    ? packageStateFileSchema.parse(
        readJsonFileFromDisk<{ packages: FunctionPackage[] }>(filePath),
      ).packages
    : [];

  return new PackageRegistry({
    plugins: options.plugins ?? [],
    persistedPackages,
    filePath,
  });
}
