import { z } from 'zod';

export const executionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const resultEnvelopeSchema = z.object({
  executionId: z.string().min(1),
  capabilityId: z.string().min(1),
  resultType: z.enum(['resource', 'resource_list', 'ack']),
  resourceRef: z.string().min(1),
  finality: z.literal('final'),
  data: z.unknown(),
  nextCapabilities: z.array(z.string()).default([]),
  error: executionErrorSchema.nullable(),
});

export type ExecutionError = z.infer<typeof executionErrorSchema>;
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;
