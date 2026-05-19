import type { Capability } from '../../contracts/index.js';

export type OpenClawToolInputProperty = {
  type: 'string' | 'array' | 'object';
  description?: string;
  items?: {
    type: 'string';
  };
};

export type OpenClawToolInputSchema = {
  type: 'object';
  properties: Record<string, OpenClawToolInputProperty>;
  required: string[];
};

export type OpenClawTool = {
  name: string;
  description: string;
  category: Capability['category'];
  side_effect_level: Capability['sideEffectLevel'];
  input_schema: OpenClawToolInputSchema;
};

function mapInputFieldType(fieldType: Capability['inputSchema'][string]['type']): OpenClawToolInputProperty {
  switch (fieldType) {
    case 'string':
    case 'text':
      return { type: 'string' };
    case 'string_array':
      return {
        type: 'array',
        items: {
          type: 'string',
        },
      };
    case 'object':
      return { type: 'object' };
    default:
      throw new Error(`Unknown field type for OpenClaw tool mapping: ${String(fieldType)}`);
  }
}

export function mapCapabilitiesToOpenClawTools(capabilities: Capability[]): OpenClawTool[] {
  return capabilities.map((capability) => {
    const properties: Record<string, OpenClawToolInputProperty> = {};
    const required: string[] = [];

    for (const [fieldName, field] of Object.entries(capability.inputSchema)) {
      properties[fieldName] = {
        ...mapInputFieldType(field.type),
        description: field.description,
      };

      if (field.required) {
        required.push(fieldName);
      }
    }

    return {
      name: capability.capabilityId,
      description: capability.summary,
      category: capability.category,
      side_effect_level: capability.sideEffectLevel,
      input_schema: {
        type: 'object',
        properties,
        required,
      },
    };
  });
}
