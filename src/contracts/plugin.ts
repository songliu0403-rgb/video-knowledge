import { z } from 'zod';
import { capabilitySchema } from './capability.js';
import type { Connector } from './connector.js';
import type { ResultEnvelope } from './result.js';

export const pluginManifestSchema = z.object({
  pluginId: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(capabilitySchema).min(1),
}).superRefine((manifest, ctx) => {
  const seenCapabilityIds = new Set<string>();

  for (let index = 0; index < manifest.capabilities.length; index += 1) {
    const capability = manifest.capabilities[index];

    if (capability.pluginId !== manifest.pluginId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'pluginId'],
        message: 'Capability pluginId must match the manifest pluginId.',
      });
    }

    if (seenCapabilityIds.has(capability.capabilityId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'capabilityId'],
        message: 'Capability ids must be unique within a manifest.',
      });
      continue;
    }

    seenCapabilityIds.add(capability.capabilityId);
  }
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginHandlerContext = {
  connector: Connector;
  now: () => string;
};
export type PluginHandler = (
  input: Record<string, unknown>,
  context: PluginHandlerContext,
) => Promise<Omit<ResultEnvelope, 'executionId' | 'capabilityId' | 'error'>>;
export type PluginModule = {
  manifest: PluginManifest;
  handlers: Record<string, PluginHandler>;
};
