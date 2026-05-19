import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { renderConsolePage } from './console/render-console.js';
import { ControlPlaneService } from './control-plane/control-plane-service.js';
import { createConnectorManager, type ConnectorManager } from './connectors/connector-manager.js';
import { executeRequestSchema } from './contracts/index.js';
import { AppError } from './executor/app-error.js';
import { executeCapability } from './executor/execute-capability.js';
import { sendHtml } from './http/html.js';
import { readJsonBody, sendJson } from './http/json.js';
import { PackageRegistry, createPackageRegistry } from './registry/package-registry.js';
import { handleOpenClawRoute } from './routes/openclaw.js';
import { CapabilityRegistry } from './registry/capability-registry.js';
import { loadPlugins } from './registry/plugin-loader.js';
import { createExecutionLogStore, type ExecutionLogStore } from './state/execution-log-store.js';
import { createRuntimeService, type RuntimeService } from './runtime/runtime-service.js';

export type CapabilityServerDependencies = {
  registry?: CapabilityRegistry;
  packages?: PackageRegistry;
  connectors?: ConnectorManager;
  runtimes?: RuntimeService;
  executionLogStore?: ExecutionLogStore;
};

const defaultPlugins = loadPlugins();
const defaultRegistry = new CapabilityRegistry({ plugins: defaultPlugins });
const defaultPackages = createPackageRegistry({ plugins: defaultPlugins });
const defaultConnectors = createConnectorManager();
const defaultRuntimes = createRuntimeService();
const defaultExecutionLogStore = createExecutionLogStore();

function buildRequestFailureEntry(params: {
  executionId: string;
  durationMs: number;
  timestamp: string;
  errorCode: string;
}): Parameters<ExecutionLogStore['append']>[0] {
  return {
    executionId: params.executionId,
    capabilityId: 'unknown',
    connectorId: 'unknown',
    caller: 'unknown',
    status: 'error',
    durationMs: params.durationMs,
    timestamp: params.timestamp,
    errorCode: params.errorCode,
  };
}

function logRequestFailure(
  executionLogStore: ExecutionLogStore,
  params: {
    executionId: string;
    startedAt: number;
    timestamp: string;
    errorCode: string;
  },
): void {
  executionLogStore.append(
    buildRequestFailureEntry({
      executionId: params.executionId,
      durationMs: Date.now() - params.startedAt,
      timestamp: params.timestamp,
      errorCode: params.errorCode,
    }),
  );
}

async function handleExecute(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: Pick<
    Required<CapabilityServerDependencies>,
    'registry' | 'packages' | 'connectors' | 'executionLogStore'
  >,
): Promise<void> {
  const executionId = `exec_${randomUUID()}`;
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const body = await readJsonBody<unknown>(request);
    const parsed = executeRequestSchema.safeParse(body);

    if (!parsed.success) {
      logRequestFailure(dependencies.executionLogStore, {
        executionId,
        startedAt,
        timestamp,
        errorCode: 'validation_failed',
      });

      sendJson(
        response,
        400,
        {
          ok: false,
          error: new AppError('validation_failed', 'Invalid execute request.', {
            details: { issues: parsed.error.issues },
          }).toJSON(),
        },
      );
      return;
    }

    const result = await executeCapability({
      capabilityId: parsed.data.capabilityId,
      input: parsed.data.input,
      context: parsed.data.context,
      registry: dependencies.registry,
      packages: dependencies.packages,
      connectors: dependencies.connectors,
      executionLogStore: dependencies.executionLogStore,
      accessMode: 'manual',
    });

    if (result.ok) {
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, result.error.statusCode, { ok: false, error: result.error.toJSON() });
  } catch (error) {
    logRequestFailure(dependencies.executionLogStore, {
      executionId,
      startedAt,
      timestamp,
      errorCode: 'validation_failed',
    });

    const appError =
      error instanceof AppError
        ? error
        : new AppError('validation_failed', 'Invalid execute request.', {
            details: error instanceof Error ? { cause: error.message } : {},
            statusCode: 400,
          });

    sendJson(response, appError.statusCode, { ok: false, error: appError.toJSON() });
  }
}

export function createCapabilityServer(
  dependencies: CapabilityServerDependencies = {},
): ReturnType<typeof createServer> {
  const registry = dependencies.registry ?? defaultRegistry;
  const packages = dependencies.packages ?? defaultPackages;
  const connectors = dependencies.connectors ?? defaultConnectors;
  const runtimes = dependencies.runtimes ?? defaultRuntimes;
  const executionLogStore = dependencies.executionLogStore ?? defaultExecutionLogStore;
  const controlPlane = new ControlPlaneService({
    capabilityRegistry: registry,
    packageRegistry: packages,
    connectors,
    runtimeService: runtimes,
  });

  return createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (method === 'GET' && (pathname === '/' || pathname === '/console')) {
      const snapshot = controlPlane.getSnapshot();
      const manualCapabilities = snapshot.packages
        .filter((entry) => entry.readiness.manualAvailable)
        .flatMap((entry) => entry.capabilityIds)
        .map((capabilityId) => registry.get(capabilityId))
        .filter((capability): capability is NonNullable<typeof capability> => Boolean(capability));

      sendHtml(
        response,
        200,
        renderConsolePage({
          snapshot,
          connectors: connectors.listAll(),
          runtimes: runtimes.listAll(),
          manualCapabilities,
          executions: executionLogStore.listAll().slice(-12).reverse(),
        }),
      );
      return;
    }

    if (await handleOpenClawRoute(request, response, {
      registry,
      packages,
      connectors,
      executionLogStore,
    })) {
      return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && pathname === '/api/capabilities') {
      sendJson(response, 200, { capabilities: registry.listAll() });
      return;
    }

    if (method === 'GET' && pathname === '/api/packages') {
      sendJson(response, 200, { packages: packages.listAll() });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/packages/')) {
      const packageId = pathname.slice('/api/packages/'.length);
      const functionPackage = packages.get(packageId);

      if (!functionPackage) {
        sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Package not found.' } });
        return;
      }

      sendJson(response, 200, {
        package: functionPackage,
        capabilities: packages.getCapabilities(packageId),
        accessPolicies: packages.getAccessPolicies(packageId),
      });
      return;
    }

    if (method === 'POST' && pathname.startsWith('/api/packages/')) {
      const suffixes = ['install', 'enable', 'disable', 'uninstall'] as const;
      const matchedSuffix = suffixes.find((suffix) => pathname.endsWith(`/${suffix}`));

      if (matchedSuffix) {
        const packageId = pathname.slice('/api/packages/'.length, -(`/${matchedSuffix}`.length));
        const actionMap = {
          install: () => packages.install(packageId),
          enable: () => packages.enable(packageId),
          disable: () => packages.disable(packageId),
          uninstall: () => packages.uninstall(packageId),
        } as const;
        const functionPackage = actionMap[matchedSuffix]();

        if (!functionPackage) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Package not found.' } });
          return;
        }

        sendJson(response, 200, {
          package: functionPackage,
          capabilities: packages.getCapabilities(packageId),
          accessPolicies: packages.getAccessPolicies(packageId),
        });
        return;
      }
    }

    if (method === 'POST' && pathname.startsWith('/api/packages/') && pathname.endsWith('/agent-exposure')) {
      const packageId = pathname.slice('/api/packages/'.length, -'/agent-exposure'.length);

      try {
        const body = await readJsonBody<{ agentEnabled?: boolean }>(request);

        if (typeof body?.agentEnabled !== 'boolean') {
          sendJson(response, 400, {
            ok: false,
            error: { code: 'validation_failed', message: 'agentEnabled must be a boolean.' },
          });
          return;
        }

        const functionPackage = packages.setAgentEnabled(packageId, body.agentEnabled);

        if (!functionPackage) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Package not found.' } });
          return;
        }

        sendJson(response, 200, {
          package: functionPackage,
          capabilities: packages.getCapabilities(packageId),
          accessPolicies: packages.getAccessPolicies(packageId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid agent exposure payload.';
        sendJson(response, 400, { ok: false, error: { code: 'validation_failed', message } });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/connectors') {
      sendJson(response, 200, { connectors: connectors.listAll() });
      return;
    }

    if (method === 'POST' && pathname === '/api/connectors') {
      if (!connectors.create) {
        sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Connector creation is not available.' } });
        return;
      }
      try {
        const body = await readJsonBody<unknown>(request);
        const connector = connectors.create(body);
        sendJson(response, 201, { connector });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid connector payload.';
        sendJson(response, 400, { ok: false, error: { code: 'validation_failed', message } });
      }
      return;
    }

    if (pathname.startsWith('/api/connectors/')) {
      const connectorId = decodeURIComponent(pathname.slice('/api/connectors/'.length));

      if (method === 'PATCH') {
        if (!connectors.update) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Connector updates are not available.' } });
          return;
        }
        try {
          const body = await readJsonBody<unknown>(request);
          const connector = connectors.update(connectorId, body);

          if (!connector) {
            sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Connector not found.' } });
            return;
          }

          sendJson(response, 200, { connector });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid connector patch.';
          sendJson(response, 400, { ok: false, error: { code: 'validation_failed', message } });
        }
        return;
      }

      if (method === 'DELETE') {
        if (!connectors.delete) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Connector deletion is not available.' } });
          return;
        }

        const deleted = connectors.delete(connectorId);

        if (!deleted) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Connector not found.' } });
          return;
        }

        sendJson(response, 200, { removedConnectorId: connectorId });
        return;
      }

      if (method === 'POST' && connectorId.endsWith('/test')) {
        if (!connectors.test) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Connector health tests are not available.' } });
          return;
        }
        const actualConnectorId = connectorId.slice(0, -'/test'.length);
        const connector = connectors.test(actualConnectorId);

        if (!connector) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Connector not found.' } });
          return;
        }

        sendJson(response, 200, { connector });
        return;
      }

      if (method === 'POST' && connectorId.endsWith('/disable')) {
        if (!connectors.disable) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Connector disable is not available.' } });
          return;
        }
        const actualConnectorId = connectorId.slice(0, -'/disable'.length);
        const connector = connectors.disable(actualConnectorId);

        if (!connector) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Connector not found.' } });
          return;
        }

        sendJson(response, 200, { connector });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/runtimes') {
      sendJson(response, 200, { runtimes: runtimes.listAll() });
      return;
    }

    if (pathname.startsWith('/api/runtimes/')) {
      const runtimeId = decodeURIComponent(pathname.slice('/api/runtimes/'.length));

      if (method === 'POST' && runtimeId.endsWith('/detect')) {
        if (!runtimes.detect) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Runtime detection is not available.' } });
          return;
        }

        const actualRuntimeId = runtimeId.slice(0, -'/detect'.length);
        const runtime = runtimes.detect(actualRuntimeId);

        if (!runtime) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Runtime not found.' } });
          return;
        }

        sendJson(response, 200, { runtime });
        return;
      }

      if (method === 'POST' && runtimeId.endsWith('/install')) {
        if (!runtimes.install) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Runtime install is not available.' } });
          return;
        }

        const actualRuntimeId = runtimeId.slice(0, -'/install'.length);

        try {
          const body = await readJsonBody<unknown>(request);
          const runtime = runtimes.install(actualRuntimeId, body);

          if (!runtime) {
            sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Runtime not found.' } });
            return;
          }

          sendJson(response, 200, { runtime });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid runtime install payload.';
          sendJson(response, 400, { ok: false, error: { code: 'validation_failed', message } });
        }
        return;
      }

      if (method === 'POST' && runtimeId.endsWith('/uninstall')) {
        if (!runtimes.uninstall) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Runtime uninstall is not available.' } });
          return;
        }

        const actualRuntimeId = runtimeId.slice(0, -'/uninstall'.length);
        const runtime = runtimes.uninstall(actualRuntimeId);

        if (!runtime) {
          sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Runtime not found.' } });
          return;
        }

        sendJson(response, 200, { runtime });
        return;
      }

      if (method === 'POST' && runtimeId.endsWith('/relink')) {
        if (!runtimes.relink) {
          sendJson(response, 501, { ok: false, error: { code: 'unsupported_operation', message: 'Runtime relink is not available.' } });
          return;
        }

        const actualRuntimeId = runtimeId.slice(0, -'/relink'.length);

        try {
          const body = await readJsonBody<unknown>(request);
          const runtime = runtimes.relink(actualRuntimeId, body);

          if (!runtime) {
            sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Runtime not found.' } });
            return;
          }

          sendJson(response, 200, { runtime });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid runtime relink payload.';
          sendJson(response, 400, { ok: false, error: { code: 'validation_failed', message } });
        }
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/control-plane') {
      sendJson(response, 200, { controlPlane: controlPlane.getSnapshot() });
      return;
    }

    if (method === 'GET' && pathname === '/api/manual/capabilities') {
      const capabilities = controlPlane
        .getSnapshot()
        .packages
        .filter((entry) => entry.readiness.manualAvailable)
        .flatMap((entry) => entry.capabilityIds)
        .map((capabilityId) => registry.get(capabilityId))
        .filter((capability): capability is NonNullable<typeof capability> => Boolean(capability));

      sendJson(response, 200, { capabilities });
      return;
    }

    if (method === 'GET' && pathname === '/api/executions') {
      sendJson(response, 200, { executions: executionLogStore.listAll() });
      return;
    }

    if (method === 'POST' && pathname === '/api/manual/execute') {
      await handleExecute(request, response, {
        registry,
        packages,
        connectors,
        executionLogStore,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/execute') {
      await handleExecute(request, response, {
        registry,
        packages,
        connectors,
        executionLogStore,
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Route not found.' } });
  });
}

export const server = createCapabilityServer();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? '4317');
  server.listen(port, () => {
    // Minimal startup message for local development.
    // eslint-disable-next-line no-console
    console.log(`Capability repository listening on http://localhost:${port}`);
  });
}
