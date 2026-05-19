import type { Capability, PluginHandler, PluginModule } from '../contracts/index.js';

type CapabilityRegistryOptions = {
  plugins: PluginModule[];
};

export class CapabilityRegistry {
  private readonly capabilities: Capability[];
  private readonly capabilitiesById: Map<string, Capability>;
  private readonly pluginsById: Map<string, PluginModule>;

  constructor(options: CapabilityRegistryOptions) {
    this.capabilities = options.plugins.flatMap((plugin) => plugin.manifest.capabilities);
    this.capabilitiesById = new Map(this.capabilities.map((capability) => [capability.capabilityId, capability]));
    this.pluginsById = new Map(options.plugins.map((plugin) => [plugin.manifest.pluginId, plugin]));
  }

  listAll(): Capability[] {
    return [...this.capabilities];
  }

  listExposed(): Capability[] {
    return this.capabilities.filter((capability) => capability.exposure === 'auto');
  }

  get(capabilityId: string): Capability | undefined {
    return this.capabilitiesById.get(capabilityId);
  }

  getHandler(capabilityId: string): PluginHandler | undefined {
    const capability = this.capabilitiesById.get(capabilityId);

    if (!capability) {
      return undefined;
    }

    return this.pluginsById.get(capability.pluginId)?.handlers[capabilityId];
  }
}
