import { z } from 'zod';

export const capabilityCategorySchema = z.enum(['read', 'command']);
export const sideEffectLevelSchema = z.enum(['none', 'reversible', 'irreversible']);
export const exposureSchema = z.enum(['auto', 'hidden', 'disabled']);
export const inputFieldSchema = z.object({
  type: z.enum(['string', 'text', 'string_array', 'object']),
  description: z.string().min(1),
  required: z.boolean().default(true),
});

export const capabilitySchema = z.object({
  capabilityId: z.string().min(1),
  pluginId: z.string().min(1),
  summary: z.string().min(1),
  category: capabilityCategorySchema,
  sideEffectLevel: sideEffectLevelSchema,
  exposure: exposureSchema,
  connectorId: z.string().min(1),
  inputSchema: z.record(z.string(), inputFieldSchema),
  resultType: z.enum(['resource', 'resource_list', 'ack']),
  resourceRef: z.string().min(1),
  nextCapabilities: z.array(z.string()).default([]),
});

export type CapabilityCategory = z.infer<typeof capabilityCategorySchema>;
export type SideEffectLevel = z.infer<typeof sideEffectLevelSchema>;
export type Exposure = z.infer<typeof exposureSchema>;
export type InputField = z.infer<typeof inputFieldSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
