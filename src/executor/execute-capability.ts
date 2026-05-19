import { randomUUID } from 'node:crypto';
import type { Connector } from '../contracts/index.js';
import type { CapabilityRegistry } from '../registry/capability-registry.js';
import type { ConnectorManager } from '../connectors/connector-manager.js';
import type { PackageRegistry } from '../registry/package-registry.js';
import type { ExecutionLogStore } from '../state/execution-log-store.js';
import type { ResultEnvelope } from '../contracts/index.js';
import type { ExecuteRequest, ExecutionLogEntry } from '../contracts/index.js';
import { AppError } from './app-error.js';
import { validateCapabilityInput } from './validate-input.js';

export type ExecuteCapabilityArgs = {
  capabilityId: string;
  input: Record<string, unknown>;
  context: ExecuteRequest['context'];
  registry: CapabilityRegistry;
  packages?: PackageRegistry;
  connectors: ConnectorManager;
  executionLogStore: ExecutionLogStore;
  accessMode?: 'manual' | 'agent';
  now?: () => string;
};

export type ExecuteCapabilitySuccess = {
  ok: true;
  executionId: string;
  result: ResultEnvelope;
};

export type ExecuteCapabilityFailure = {
  ok: false;
  error: AppError;
};

export type ExecuteCapabilityResult = ExecuteCapabilitySuccess | ExecuteCapabilityFailure;

function logExecution(
  executionLogStore: ExecutionLogStore,
  entry: Omit<ExecutionLogEntry, 'timestamp'> & { timestamp: string },
): void {
  executionLogStore.append(entry);
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError('internal_error', 'Execution failed unexpectedly.', {
    details: error instanceof Error ? { cause: error.message } : {},
    statusCode: 500,
  });
}

function buildErrorEntry(params: {
  executionId: string;
  capabilityId: string;
  connectorId: string;
  caller: string;
  durationMs: number;
  timestamp: string;
  errorCode: string;
}): ExecutionLogEntry {
  return {
    executionId: params.executionId,
    capabilityId: params.capabilityId,
    connectorId: params.connectorId,
    caller: params.caller,
    status: 'error',
    durationMs: params.durationMs,
    timestamp: params.timestamp,
    errorCode: params.errorCode,
  };
}

function buildSuccessEntry(params: {
  executionId: string;
  capabilityId: string;
  connectorId: string;
  caller: string;
  durationMs: number;
  timestamp: string;
}): ExecutionLogEntry {
  return {
    executionId: params.executionId,
    capabilityId: params.capabilityId,
    connectorId: params.connectorId,
    caller: params.caller,
    status: 'success',
    durationMs: params.durationMs,
    timestamp: params.timestamp,
  };
}

function getConnectorOrError(
  capabilityId: string,
  connectorId: string,
  connectors: ConnectorManager,
): { ok: true; connector: Connector } | { ok: false; error: AppError } {
  const connector = connectors.get(connectorId);

  if (!connector) {
    return {
      ok: false,
      error: new AppError('connector_not_found', `Connector ${connectorId} was not found.`, {
        details: { capabilityId, connectorId },
      }),
    };
  }

  if (connector.status !== 'ready') {
    return {
      ok: false,
      error: new AppError('connector_unavailable', `Connector ${connectorId} is not ready.`, {
        details: { capabilityId, connectorId, status: connector.status },
      }),
    };
  }

  return { ok: true, connector };
}

export async function executeCapability(args: ExecuteCapabilityArgs): Promise<ExecuteCapabilityResult> {
  const executionId = `exec_${randomUUID()}`;
  const startedAt = Date.now();
  const timestamp = args.now?.() ?? new Date().toISOString();
  const capability = args.registry.get(args.capabilityId);
  const caller = args.context.caller;
  const accessMode = args.accessMode ?? 'manual';

  if (!capability) {
    const error = new AppError('capability_not_found', `Capability ${args.capabilityId} was not found.`, {
      details: { capabilityId: args.capabilityId },
      statusCode: 404,
    });

    logExecution(args.executionLogStore, buildErrorEntry({
      executionId,
      capabilityId: args.capabilityId,
      connectorId: 'unknown',
      caller,
      durationMs: Date.now() - startedAt,
      timestamp,
      errorCode: error.code,
    }));

    return { ok: false, error };
  }

  if (args.packages) {
    const available =
      accessMode === 'agent'
        ? args.packages.isCapabilityAgentAvailable(capability.capabilityId)
        : args.packages.isCapabilityManualAvailable(capability.capabilityId);

    if (!available) {
      const ownerPackage = args.packages.getOwningPackage(capability.capabilityId);
      const error = new AppError(
        'package_unavailable',
        `Capability ${capability.capabilityId} is not available for ${accessMode} access.`,
        {
          details: {
            capabilityId: capability.capabilityId,
            packageId: ownerPackage?.packageId ?? capability.pluginId,
            accessMode,
          },
          statusCode: 409,
        },
      );

      logExecution(args.executionLogStore, buildErrorEntry({
        executionId,
        capabilityId: capability.capabilityId,
        connectorId: capability.connectorId,
        caller,
        durationMs: Date.now() - startedAt,
        timestamp,
        errorCode: error.code,
      }));

      return { ok: false, error };
    }
  }

  const validation = validateCapabilityInput(capability, args.input);

  if (!validation.ok) {
    logExecution(args.executionLogStore, buildErrorEntry({
      executionId,
      capabilityId: capability.capabilityId,
      connectorId: capability.connectorId,
      caller,
      durationMs: Date.now() - startedAt,
      timestamp,
      errorCode: validation.error.code,
    }));

    return { ok: false, error: validation.error };
  }

  const connectorResult = getConnectorOrError(capability.capabilityId, capability.connectorId, args.connectors);

  if (!connectorResult.ok) {
    logExecution(args.executionLogStore, buildErrorEntry({
      executionId,
      capabilityId: capability.capabilityId,
      connectorId: capability.connectorId,
      caller,
      durationMs: Date.now() - startedAt,
      timestamp,
      errorCode: connectorResult.error.code,
    }));

    return { ok: false, error: connectorResult.error };
  }

  const handler = args.registry.getHandler(capability.capabilityId);

  if (!handler) {
    const error = new AppError(
      'unsupported_operation',
      `Capability ${capability.capabilityId} is not implemented yet.`,
      {
        details: { capabilityId: capability.capabilityId, pluginId: capability.pluginId },
        statusCode: 501,
      },
    );

    logExecution(args.executionLogStore, buildErrorEntry({
      executionId,
      capabilityId: capability.capabilityId,
      connectorId: capability.connectorId,
      caller,
      durationMs: Date.now() - startedAt,
      timestamp,
      errorCode: error.code,
    }));

    return { ok: false, error };
  }

  try {
    const result = await handler(validation.value, {
      connector: connectorResult.connector,
      now: args.now ?? (() => new Date().toISOString()),
    });
    const envelope: ResultEnvelope = {
      executionId,
      capabilityId: capability.capabilityId,
      resultType: result.resultType,
      resourceRef: result.resourceRef,
      finality: result.finality,
      data: result.data,
      nextCapabilities: result.nextCapabilities,
      error: null,
    };

    JSON.stringify(envelope);

    logExecution(args.executionLogStore, buildSuccessEntry({
      executionId,
      capabilityId: capability.capabilityId,
      connectorId: capability.connectorId,
      caller,
      durationMs: Date.now() - startedAt,
      timestamp,
    }));

    return { ok: true, executionId, result: envelope };
  } catch (error) {
    const appError = toAppError(error);

    logExecution(args.executionLogStore, buildErrorEntry({
      executionId,
      capabilityId: capability.capabilityId,
      connectorId: capability.connectorId,
      caller,
      durationMs: Date.now() - startedAt,
      timestamp,
      errorCode: appError.code,
    }));

    return { ok: false, error: appError };
  }
}
