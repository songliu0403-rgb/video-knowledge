import { z } from 'zod';

export const accessRiskLevelSchema = z.enum(['low', 'medium', 'high']);
export const confirmationPolicySchema = z.enum(['never', 'manual']);

export const accessPolicySchema = z.object({
  packageId: z.string().min(1),
  capabilityId: z.string().min(1),
  manualEnabled: z.boolean().default(true),
  agentEnabled: z.boolean().default(false),
  riskLevel: accessRiskLevelSchema,
  confirmationPolicy: confirmationPolicySchema,
});

export type AccessRiskLevel = z.infer<typeof accessRiskLevelSchema>;
export type ConfirmationPolicy = z.infer<typeof confirmationPolicySchema>;
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
