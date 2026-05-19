import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../executor/app-error.js';
import { executeCapability } from '../executor/execute-capability.js';
import { readJsonBody, sendJson } from '../http/json.js';
import type { CapabilityRegistry } from '../registry/capability-registry.js';
import type { PackageRegistry } from '../registry/package-registry.js';
import type { ConnectorManager } from '../connectors/connector-manager.js';
import type { ExecutionLogStore } from '../state/execution-log-store.js';
import { mapCapabilitiesToOpenClawTools } from '../adapter/openclaw/tool-mapper.js';

export type OpenClawRouteDependencies = {
  registry: CapabilityRegistry;
  packages: PackageRegistry;
  connectors: ConnectorManager;
  executionLogStore: ExecutionLogStore;
};

const openClawToolRequestSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  context: z.object({
    caller: z.string().min(1),
    sessionId: z.string().optional(),
  }),
});

function isOpenClawToolsListPath(method: string, pathname: string): boolean {
  return method === 'GET' && pathname === '/adapter/openclaw/tools';
}

function getOpenClawToolName(pathname: string): string | null {
  const prefix = '/adapter/openclaw/tools/';

  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const toolName = pathname.slice(prefix.length);
  return toolName ? decodeURIComponent(toolName) : null;
}

function buildFailureResponse(error: AppError): { success: false; data: null; error: ReturnType<AppError['toJSON']> } {
  return {
    success: false,
    data: null,
    error: error.toJSON(),
  };
}

function buildValidationFailureResponse(message: string, details: Record<string, unknown>): { success: false; data: null; error: ReturnType<AppError['toJSON']> } {
  return buildFailureResponse(
    new AppError('validation_failed', message, {
      details,
    }),
  );
}

function buildInternalFailureResponse(message: string, details: Record<string, unknown>): { success: false; data: null; error: ReturnType<AppError['toJSON']> } {
  return buildFailureResponse(
    new AppError('internal_error', message, {
      details,
      statusCode: 500,
    }),
  );
}

export async function handleOpenClawRoute(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: OpenClawRouteDependencies,
): Promise<boolean> {
  try {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const exposedCapabilities = dependencies.registry
      .listExposed()
      .filter((capability) => dependencies.packages.isCapabilityAgentAvailable(capability.capabilityId));

    if (isOpenClawToolsListPath(method, pathname)) {
      const tools = mapCapabilitiesToOpenClawTools(exposedCapabilities);

      sendJson(response, 200, {
        success: true,
        data: { tools },
        error: null,
      });

      return true;
    }

    if (method !== 'POST') {
      return false;
    }

    const toolName = getOpenClawToolName(pathname);

    if (!toolName) {
      return false;
    }

    const capability = exposedCapabilities.find((entry) => entry.capabilityId === toolName);

    if (!capability) {
      sendJson(
        response,
        404,
        buildFailureResponse(
          new AppError('capability_not_found', `Capability ${toolName} was not found.`, {
            details: { capabilityId: toolName },
            statusCode: 404,
          }),
        ),
      );

      return true;
    }

    let body: unknown;

    try {
      body = await readJsonBody<unknown>(request);
    } catch (error) {
      sendJson(
        response,
        400,
        buildValidationFailureResponse('Invalid OpenClaw tool request.', {
          cause: error instanceof Error ? error.message : String(error),
        }),
      );

      return true;
    }

    const parsed = openClawToolRequestSchema.safeParse(body);

    if (!parsed.success) {
      sendJson(
        response,
        400,
        buildValidationFailureResponse('Invalid OpenClaw tool request.', {
          issues: parsed.error.issues,
        }),
      );

      return true;
    }

    const result = await executeCapability({
      capabilityId: toolName,
      input: parsed.data.input,
      context: parsed.data.context,
      registry: dependencies.registry,
      packages: dependencies.packages,
      connectors: dependencies.connectors,
      executionLogStore: dependencies.executionLogStore,
      accessMode: 'agent',
    });

    if (result.ok) {
      sendJson(response, 200, {
        success: true,
        data: result.result,
        error: null,
      });
      return true;
    }

    sendJson(response, result.error.statusCode, buildFailureResponse(result.error));
    return true;
  } catch (error) {
    sendJson(
      response,
      500,
      buildInternalFailureResponse('OpenClaw tool execution failed unexpectedly.', {
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  }
}
