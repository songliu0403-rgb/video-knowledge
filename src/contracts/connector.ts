import { z } from 'zod';

export const connectorTypeSchema = z.enum(['filesystem', 'runtime']);
export const connectorStatusSchema = z.enum(['ready', 'offline', 'misconfigured']);

export const connectorSchema = z.object({
  connectorId: z.string().min(1),
  connectorType: connectorTypeSchema,
  enabled: z.boolean().default(true),
  status: connectorStatusSchema,
});

export type ConnectorType = z.infer<typeof connectorTypeSchema>;
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
export type Connector = z.infer<typeof connectorSchema>;
