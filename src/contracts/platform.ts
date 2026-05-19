export type PlatformKernel = 'openclaw';

export type PlatformSectionKey = 'workspace' | 'ai' | 'system';

export type PlatformModuleKind = 'core' | 'plugin';

export type PlatformIconKey =
  | 'layout-dashboard'
  | 'cpu'
  | 'bot'
  | 'network'
  | 'puzzle'
  | 'clock'
  | 'terminal'
  | 'wrench'
  | 'key-round'
  | 'layers-3'
  | 'waypoints'
  | 'shield-check'
  | 'route'
  | 'database';

export type PlatformNavItemContract = {
  id: string;
  to: string;
  label: string;
  iconKey: PlatformIconKey;
};

export type PlatformShellRouteContract = {
  id: string;
  path: string;
  componentKey: string;
};

export type PlatformCapabilityFlags = {
  ui: boolean;
  api: boolean;
  agentTools: boolean;
  dataContract: boolean;
  permissions: boolean;
};

export type PlatformModuleContract = {
  id: string;
  kind: 'core';
  section: PlatformSectionKey;
  kernel: PlatformKernel;
  title: string;
  description: string;
  primaryLabel: string;
  iconKey: PlatformIconKey;
  primaryRoute: string;
  routeMatchers: string[];
  navItems: PlatformNavItemContract[];
  capabilities: PlatformCapabilityFlags;
  agentTools: string[];
  permissions: string[];
  dataDomains: string[];
};

export type PlatformManifest = {
  kernel: PlatformKernel;
  version: 1;
  modules: PlatformModuleContract[];
};

export type PlatformPluginLifecycleState =
  | 'parked'
  | 'planned'
  | 'designing'
  | 'installable'
  | 'installed';

export type PlatformAuthorizationState = 'pending' | 'approved' | 'rejected';

export type PlatformPluginDomain =
  | 'ue'
  | 'database'
  | 'info'
  | 'finance'
  | 'research';

export type PlatformPluginCandidate = {
  id: string;
  title: string;
  domain: PlatformPluginDomain;
  state: PlatformPluginLifecycleState;
  summary: string;
  needs: string[];
};

export type PlatformPluginContract = {
  moduleId: string;
  title: string;
  domain: PlatformPluginDomain;
  expectedPermissions: string[];
  expectedDataDomains: string[];
  expectedAgentTools: string[];
  mountRoutes: string[];
  installChecks: string[];
};

export type PlatformPluginArtifactKind =
  | 'frontend-shell'
  | 'frontend-route'
  | 'backend-api'
  | 'backend-workspace'
  | 'shared-contract';

export type PlatformPluginArtifactDefinition = {
  id: string;
  label: string;
  kind: PlatformPluginArtifactKind;
  relativePath: string;
  required: boolean;
};

export type PlatformPluginTemplate = {
  moduleId: string;
  title: string;
  version: string;
  pluginType: 'business-module';
  installStrategy: 'platform-installer';
  shell: {
    title: string;
    description: string;
    primaryLabel: string;
    iconKey: PlatformIconKey;
    attachSection: PlatformSectionKey;
    attachZone: 'workspace-entry' | 'ai-entry';
    primaryRoute: string;
    mountRoutes: string[];
    routes: PlatformShellRouteContract[];
    navItems: PlatformNavItemContract[];
  };
  api: {
    hostRouteBase: string;
  };
  agentTools: string[];
  permissions: string[];
  dataDomains: string[];
  artifacts: PlatformPluginArtifactDefinition[];
  lifecycleHooks: Array<'install' | 'enable' | 'disable' | 'attach' | 'detach'>;
};

export type PlatformToolRegistryEntry = {
  id: string;
  moduleId: string;
  permissionScope: string | null;
  dataDomains: string[];
};

export type PlatformPermissionRisk = 'low' | 'medium' | 'high';

export type PlatformPermissionGrantMode =
  | 'kernel'
  | 'install-approval'
  | 'runtime-approval';

export type PlatformPermissionPolicy = {
  scope: string;
  title: string;
  description: string;
  risk: PlatformPermissionRisk;
  grantMode: PlatformPermissionGrantMode;
  requiresConfirmation: boolean;
};

export type PlatformAuthorizationRequest = {
  id: string;
  moduleId: string;
  title: string;
  permissionScope: string;
  reason: string;
  state: PlatformAuthorizationState;
};

export type PlatformMountedPlugin = {
  moduleId: string;
  title: string;
  domain: PlatformPluginDomain;
  status: 'mounted';
  enabled: boolean;
  mountedAt: string;
  mountRoutes: string[];
  toolIds: string[];
  dataDomains: string[];
  permissionScopes: string[];
};

export type PlatformCatalog = {
  kernel: PlatformKernel;
  candidates: PlatformPluginCandidate[];
  tools: PlatformToolRegistryEntry[];
  authorizationRequests: PlatformAuthorizationRequest[];
  mountedPlugins: PlatformMountedPlugin[];
};

export type PlatformPluginOverview = {
  moduleId: string;
  title: string;
  domain: PlatformPluginDomain;
  lifecycleState: PlatformPluginLifecycleState;
  mountedPlugin: PlatformMountedPlugin | null;
  authorizationRequests: PlatformAuthorizationRequest[];
  tools: PlatformToolRegistryEntry[];
  permissions: PlatformPermissionPolicy[];
  contract: PlatformPluginContract | null;
  template: PlatformPluginTemplate | null;
};

export type PlatformRegistrySnapshot = {
  kernel: PlatformKernel;
  summary: {
    coreModuleCount: number;
    pluginCandidateCount: number;
    installedPluginCount: number;
    enabledPluginCount: number;
    toolCount: number;
    permissionCount: number;
  };
  plugins: PlatformPluginOverview[];
};

export type PlatformPersistedState = {
  pluginStates: Record<string, PlatformPluginLifecycleState>;
  authorizationRequests: PlatformAuthorizationRequest[];
  mountedPlugins: PlatformMountedPlugin[];
};
