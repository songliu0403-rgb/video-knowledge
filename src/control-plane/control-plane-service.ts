import type { ConnectorRuntime } from '../connectors/connector-manager.js';
import type { AccessPolicy, FunctionPackage, Runtime } from '../contracts/index.js';
import type { CapabilityRegistry } from '../registry/capability-registry.js';
import type { PackageRegistry } from '../registry/package-registry.js';
import type { RuntimeService } from '../runtime/runtime-service.js';

export type ControlPlaneIssue = {
  code:
    | 'package_uninstalled'
    | 'package_disabled'
    | 'manual_access_disabled'
    | 'agent_access_disabled'
    | 'connector_missing'
    | 'connector_offline'
    | 'connector_misconfigured'
    | 'runtime_missing'
    | 'runtime_broken';
  label: string;
  subjectId?: string;
};

export type ControlPlaneSuggestedAction = {
  code:
    | 'install_package'
    | 'enable_package'
    | 'review_connectors'
    | 'test_connector'
    | 'install_runtime'
    | 'relink_runtime'
    | 'expose_agent';
  label: string;
  subjectId?: string;
  targetRef?: string;
  formRef?: string;
  focusField?: string;
  prefill?: Record<string, unknown>;
  command?: {
    method: 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: Record<string, unknown>;
  };
  navigateTo?: string;
};

export type PackageControlPlaneEntry = {
  package: FunctionPackage;
  capabilityIds: string[];
  connectorStates: ConnectorRuntime[];
  runtimeStates: Runtime[];
  accessPolicies: AccessPolicy[];
  readiness: {
    manualAvailable: boolean;
    agentAvailable: boolean;
  };
  issues: {
    manual: ControlPlaneIssue[];
    agent: ControlPlaneIssue[];
  };
  suggestedActions: ControlPlaneSuggestedAction[];
};

export type ControlPlaneSnapshot = {
  summary: {
    packageCount: number;
    installedPackageCount: number;
    enabledPackageCount: number;
    manualEnabledPackageCount: number;
    agentEnabledPackageCount: number;
    capabilityCount: number;
    connectorCount: number;
    readyConnectorCount: number;
    runtimeCount: number;
    readyRuntimeCount: number;
  };
  packages: PackageControlPlaneEntry[];
};

type ControlPlaneServiceOptions = {
  capabilityRegistry: CapabilityRegistry;
  packageRegistry: PackageRegistry;
  connectors: {
    listAll: () => ConnectorRuntime[];
    get: (connectorId: string) => ConnectorRuntime | undefined;
  };
  runtimeService: RuntimeService;
};

function pushIssue(issues: ControlPlaneIssue[], issue: ControlPlaneIssue): void {
  if (issues.some((entry) => entry.code === issue.code && entry.subjectId === issue.subjectId)) {
    return;
  }

  issues.push(issue);
}

function pushAction(actions: ControlPlaneSuggestedAction[], action: ControlPlaneSuggestedAction): void {
  if (
    actions.some(
      (entry) =>
        entry.code === action.code &&
        entry.subjectId === action.subjectId &&
        entry.formRef === action.formRef,
    )
  ) {
    return;
  }

  actions.push(action);
}

function inferConnectorType(connectorId?: string): 'filesystem' | 'runtime' | undefined {
  if (!connectorId) {
    return undefined;
  }

  if (connectorId.startsWith('filesystem.')) {
    return 'filesystem';
  }

  if (connectorId.startsWith('runtime.')) {
    return 'runtime';
  }

  return undefined;
}

function getRuntimeRepairField(runtime?: Runtime): 'binaryPath' | 'installPath' {
  return runtime?.detection?.kind === 'directory' ? 'installPath' : 'binaryPath';
}

function deriveConnectorIssues(
  functionPackage: FunctionPackage,
  connectorStates: ConnectorRuntime[],
): ControlPlaneIssue[] {
  const issues: ControlPlaneIssue[] = [];

  for (const connectorId of functionPackage.requiredConnectorIds) {
    const connector = connectorStates.find((entry) => entry.connectorId === connectorId);

    if (!connector) {
      pushIssue(issues, {
        code: 'connector_missing',
        label: `缺少连接器 ${connectorId}。`,
        subjectId: connectorId,
      });
      continue;
    }

    if (!connector.enabled || connector.status === 'offline') {
      pushIssue(issues, {
        code: 'connector_offline',
        label: `连接器 ${connectorId} 当前离线。`,
        subjectId: connectorId,
      });
      continue;
    }

    if (connector.status !== 'ready') {
      pushIssue(issues, {
        code: 'connector_misconfigured',
        label: `连接器 ${connectorId} 需要重新检查配置。`,
        subjectId: connectorId,
      });
    }
  }

  return issues;
}

function deriveRuntimeIssues(
  functionPackage: FunctionPackage,
  runtimeStates: Runtime[],
): ControlPlaneIssue[] {
  const issues: ControlPlaneIssue[] = [];

  for (const requirement of functionPackage.runtimeRequirements) {
    const runtime = runtimeStates.find((entry) => entry.runtimeId === requirement.runtimeId);

    if (!runtime) {
      pushIssue(issues, {
        code: 'runtime_missing',
        label: `缺少运行时 ${requirement.runtimeId}。`,
        subjectId: requirement.runtimeId,
      });
      continue;
    }

    if (runtime.installState === 'installed' && runtime.healthState === 'ready') {
      continue;
    }

    if (runtime.installState === 'missing' || runtime.healthState === 'missing') {
      pushIssue(issues, {
        code: 'runtime_missing',
        label: `运行时 ${requirement.runtimeId} 尚未安装或未就绪。`,
        subjectId: requirement.runtimeId,
      });
      continue;
    }

    pushIssue(issues, {
      code: 'runtime_broken',
      label: `运行时 ${requirement.runtimeId} 已损坏或需要重新绑定。`,
      subjectId: requirement.runtimeId,
    });
  }

  return issues;
}

function deriveSuggestedActions(
  functionPackage: FunctionPackage,
  manualIssues: ControlPlaneIssue[],
  agentIssues: ControlPlaneIssue[],
  runtimeStates: Runtime[],
): ControlPlaneSuggestedAction[] {
  const actions: ControlPlaneSuggestedAction[] = [];
  const allIssues = [...manualIssues, ...agentIssues];

  for (const issue of allIssues) {
    switch (issue.code) {
      case 'package_uninstalled':
        pushAction(actions, {
          code: 'install_package',
          label: `安装 ${functionPackage.name}`,
          targetRef: `package:${functionPackage.packageId}`,
          command: {
            method: 'POST',
            path: `/api/packages/${functionPackage.packageId}/install`,
          },
        });
        break;
      case 'package_disabled':
        pushAction(actions, {
          code: 'enable_package',
          label: `启用 ${functionPackage.name}`,
          targetRef: `package:${functionPackage.packageId}`,
          command: {
            method: 'POST',
            path: `/api/packages/${functionPackage.packageId}/enable`,
          },
        });
        break;
      case 'connector_missing':
        pushAction(actions, {
          code: 'review_connectors',
          label: '去连接器区补齐连接配置',
          subjectId: issue.subjectId,
          targetRef: issue.subjectId ? `connector:${issue.subjectId}` : undefined,
          navigateTo: '#connectors',
          formRef: 'connector-create',
          focusField: 'connectorId',
          prefill: {
            connectorId: issue.subjectId,
            connectorType: inferConnectorType(issue.subjectId),
          },
        });
        break;
      case 'connector_offline':
      case 'connector_misconfigured':
        pushAction(actions, {
          code: 'test_connector',
          label: `检测连接器 ${issue.subjectId ?? ''}`.trim(),
          subjectId: issue.subjectId,
          targetRef: issue.subjectId ? `connector:${issue.subjectId}` : undefined,
          formRef: issue.subjectId ? `connector-update:${issue.subjectId}` : undefined,
          focusField: 'configJson',
          command: issue.subjectId
            ? {
                method: 'POST',
                path: `/api/connectors/${issue.subjectId}/test`,
              }
            : undefined,
        });
        break;
      case 'runtime_missing': {
        const runtime = runtimeStates.find((entry) => entry.runtimeId === issue.subjectId);
        const focusField = getRuntimeRepairField(runtime);
        pushAction(actions, {
          code: 'install_runtime',
          label: `安装运行时 ${issue.subjectId ?? ''}`.trim(),
          subjectId: issue.subjectId,
          targetRef: issue.subjectId ? `runtime:${issue.subjectId}` : undefined,
          formRef: issue.subjectId ? `runtime-install:${issue.subjectId}` : undefined,
          focusField,
          command:
            runtime?.runtimeType === 'service' && runtime?.detection?.kind !== 'directory' && issue.subjectId
              ? {
                  method: 'POST',
                  path: `/api/runtimes/${issue.subjectId}/install`,
                }
              : undefined,
          navigateTo: runtime?.runtimeType === 'service' ? undefined : '#runtimes',
        });
        break;
      }
      case 'runtime_broken':
        {
          const runtime = runtimeStates.find((entry) => entry.runtimeId === issue.subjectId);
        pushAction(actions, {
          code: 'relink_runtime',
          label: `重新绑定运行时 ${issue.subjectId ?? ''}`.trim(),
          subjectId: issue.subjectId,
          targetRef: issue.subjectId ? `runtime:${issue.subjectId}` : undefined,
          navigateTo: '#runtimes',
          formRef: issue.subjectId ? `runtime-relink:${issue.subjectId}` : undefined,
          focusField: getRuntimeRepairField(runtime),
        });
        break;
        }
      case 'agent_access_disabled':
        pushAction(actions, {
          code: 'expose_agent',
          label: `将 ${functionPackage.name} 接入 Agent`,
          targetRef: `package:${functionPackage.packageId}`,
          command: {
            method: 'POST',
            path: `/api/packages/${functionPackage.packageId}/agent-exposure`,
            body: {
              agentEnabled: true,
            },
          },
        });
        break;
      default:
        break;
    }
  }

  return actions;
}

export class ControlPlaneService {
  constructor(private readonly options: ControlPlaneServiceOptions) {}

  getSnapshot(): ControlPlaneSnapshot {
    const packages = this.options.packageRegistry.listAll().map((functionPackage) => {
      const connectorStates = functionPackage.requiredConnectorIds
        .map((connectorId) => this.options.connectors.get(connectorId))
        .filter((connector): connector is ConnectorRuntime => Boolean(connector));
      const runtimeStates = functionPackage.runtimeRequirements
        .map((requirement) => this.options.runtimeService.get(requirement.runtimeId))
        .filter((runtime): runtime is Runtime => Boolean(runtime));
      const accessPolicies = this.options.packageRegistry.getAccessPolicies(functionPackage.packageId);
      const manualIssues: ControlPlaneIssue[] = [];

      if (functionPackage.installState !== 'installed') {
        pushIssue(manualIssues, {
          code: 'package_uninstalled',
          label: `${functionPackage.name} 尚未安装。`,
        });
      }

      if (!functionPackage.enabled) {
        pushIssue(manualIssues, {
          code: 'package_disabled',
          label: `${functionPackage.name} 当前已停用。`,
        });
      }

      if (!functionPackage.manualEnabled) {
        pushIssue(manualIssues, {
          code: 'manual_access_disabled',
          label: `${functionPackage.name} 当前未开放手动入口。`,
        });
      }

      for (const issue of deriveConnectorIssues(functionPackage, connectorStates)) {
        pushIssue(manualIssues, issue);
      }

      for (const issue of deriveRuntimeIssues(functionPackage, runtimeStates)) {
        pushIssue(manualIssues, issue);
      }

      const agentIssues = [...manualIssues];

      if (!functionPackage.agentEnabled) {
        pushIssue(agentIssues, {
          code: 'agent_access_disabled',
          label: `${functionPackage.name} 尚未开放给 Agent。`,
        });
      }

      const suggestedActions = deriveSuggestedActions(functionPackage, manualIssues, agentIssues, runtimeStates);

      return {
        package: functionPackage,
        capabilityIds: this.options.packageRegistry
          .getCapabilities(functionPackage.packageId)
          .map((capability) => capability.capabilityId),
        connectorStates,
        runtimeStates,
        accessPolicies,
        readiness: {
          manualAvailable: manualIssues.length === 0,
          agentAvailable: agentIssues.length === 0,
        },
        issues: {
          manual: manualIssues,
          agent: agentIssues,
        },
        suggestedActions,
      };
    });

    const connectors = this.options.connectors.listAll();
    const runtimes = this.options.runtimeService.listAll();

    return {
      summary: {
        packageCount: packages.length,
        installedPackageCount: packages.filter((entry) => entry.package.installState === 'installed').length,
        enabledPackageCount: packages.filter((entry) => entry.package.enabled).length,
        manualEnabledPackageCount: packages.filter((entry) => entry.package.manualEnabled).length,
        agentEnabledPackageCount: packages.filter((entry) => entry.package.agentEnabled).length,
        capabilityCount: this.options.capabilityRegistry.listAll().length,
        connectorCount: connectors.length,
        readyConnectorCount: connectors.filter((connector) => connector.enabled && connector.status === 'ready').length,
        runtimeCount: runtimes.length,
        readyRuntimeCount: runtimes.filter((runtime) => runtime.installState === 'installed' && runtime.healthState === 'ready').length,
      },
      packages,
    };
  }
}
