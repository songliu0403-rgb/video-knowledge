import { z } from 'zod';

export const runtimeTypeSchema = z.enum(['service', 'application']);
export const runtimeInstallStateSchema = z.enum(['installed', 'missing', 'broken']);
export const runtimeHealthStateSchema = z.enum(['ready', 'missing', 'broken']);
export const runtimeDetectionKindSchema = z.enum(['binary', 'directory']);
export const runtimeCheckReasonSchema = z.enum([
  'binary_detected',
  'directory_detected',
  'service_ready_without_path',
  'configured_binary_missing',
  'configured_install_path_missing',
  'required_entries_missing',
  'candidate_paths_missing',
  'not_configured',
]);
export const runtimeDetectionSchema = z.object({
  kind: runtimeDetectionKindSchema,
  candidatePaths: z.array(z.string().min(1)).default([]),
  requiredEntries: z.array(z.string().min(1)).default([]),
});
export const runtimeCheckSchema = z.object({
  checkedAt: z.string().datetime(),
  status: runtimeHealthStateSchema,
  reason: runtimeCheckReasonSchema,
  sourcePath: z.string().min(1).optional(),
  missingEntries: z.array(z.string().min(1)).default([]),
});

export const runtimeSchema = z.object({
  runtimeId: z.string().min(1),
  name: z.string().min(1),
  runtimeType: runtimeTypeSchema,
  installState: runtimeInstallStateSchema,
  healthState: runtimeHealthStateSchema,
  binaryPath: z.string().min(1).optional(),
  installPath: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  detection: runtimeDetectionSchema.optional(),
  lastCheck: runtimeCheckSchema.optional(),
});

export type RuntimeType = z.infer<typeof runtimeTypeSchema>;
export type RuntimeInstallState = z.infer<typeof runtimeInstallStateSchema>;
export type RuntimeHealthState = z.infer<typeof runtimeHealthStateSchema>;
export type RuntimeDetectionKind = z.infer<typeof runtimeDetectionKindSchema>;
export type RuntimeDetection = z.infer<typeof runtimeDetectionSchema>;
export type RuntimeCheckReason = z.infer<typeof runtimeCheckReasonSchema>;
export type RuntimeCheck = z.infer<typeof runtimeCheckSchema>;
export type Runtime = z.infer<typeof runtimeSchema>;
