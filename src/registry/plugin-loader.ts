import { pluginManifestSchema, type PluginModule } from '../contracts/index.js';
import { pluginModules } from '../plugins/index.js';

function validateHandlers(module: PluginModule): PluginModule {
  const manifest = pluginManifestSchema.parse(module.manifest);
  const capabilityIds = new Set(manifest.capabilities.map((capability) => capability.capabilityId));

  for (const handlerKey of Object.keys(module.handlers)) {
    if (!capabilityIds.has(handlerKey)) {
      throw new Error(
        `Plugin ${manifest.pluginId} declares a handler for unknown capability ${handlerKey}.`,
      );
    }
  }

  return {
    manifest,
    handlers: module.handlers,
  };
}

export function loadPlugins(modules: PluginModule[] = pluginModules): PluginModule[] {
  return modules.map(validateHandlers);
}
