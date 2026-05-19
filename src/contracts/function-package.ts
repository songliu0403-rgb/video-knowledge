import { z } from 'zod';

export const functionPackageTypeSchema = z.enum(['integration', 'workspace']);
export const functionPackageInstallStateSchema = z.enum(['installed', 'uninstalled']);

export const runtimeRequirementSchema = z.object({
  runtimeId: z.string().min(1),
  required: z.boolean().default(true),
});

export const functionPackageSchema = z.object({
  packageId: z.string().min(1),
  ownerPluginId: z.string().min(1),
  name: z.string().min(1),
  packageType: functionPackageTypeSchema,
  installState: functionPackageInstallStateSchema,
  enabled: z.boolean().default(true),
  manualEnabled: z.boolean().default(true),
  agentEnabled: z.boolean().default(false),
  runtimeRequirements: z.array(runtimeRequirementSchema).default([]),
  requiredConnectorIds: z.array(z.string().min(1)).default([]),
  providedCapabilityIds: z.array(z.string().min(1)).default([]),
});

export type FunctionPackageType = z.infer<typeof functionPackageTypeSchema>;
export type FunctionPackageInstallState = z.infer<typeof functionPackageInstallStateSchema>;
export type RuntimeRequirement = z.infer<typeof runtimeRequirementSchema>;
export type FunctionPackage = z.infer<typeof functionPackageSchema>;
