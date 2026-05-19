import { z } from 'zod';

export const executeRequestSchema = z.object({
  capabilityId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  context: z.object({
    caller: z.string().min(1),
    sessionId: z.string().optional(),
  }),
});

export const executionLogEntrySchema = z.object({
  executionId: z.string().min(1),
  capabilityId: z.string().min(1),
  connectorId: z.string().min(1),
  caller: z.string().min(1),
  status: z.enum(['success', 'error']),
  durationMs: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  errorCode: z.string().optional(),
}).superRefine((entry, ctx) => {
  if (entry.status === 'success' && entry.errorCode !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['errorCode'],
      message: 'Successful executions must not include errorCode.',
    });
  }

  if (entry.status === 'error' && entry.errorCode === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['errorCode'],
      message: 'Failed executions must include errorCode.',
    });
  }
});

export type ExecuteRequest = z.infer<typeof executeRequestSchema>;
export type ExecutionLogEntry = z.infer<typeof executionLogEntrySchema>;
