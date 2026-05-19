import type { ConnectorRuntime } from '../connectors/connector-manager.js';
import type { ControlPlaneSnapshot, ControlPlaneSuggestedAction } from '../control-plane/control-plane-service.js';
import type { Capability, ExecutionLogEntry, Runtime } from '../contracts/index.js';
import { consoleClientScript } from './client-script.js';
import { consoleStyles } from './styles.js';

type ConsolePageModel = {
  snapshot: ControlPlaneSnapshot;
  connectors: ConnectorRuntime[];
  runtimes: Runtime[];
  manualCapabilities: Capability[];
  executions: ExecutionLogEntry[];
};

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatTime(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? value
    : timestamp.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function describeRuntimeCheckReason(runtime: Runtime): string | null {
  const lastCheck = runtime.lastCheck;

  if (!lastCheck) {
    return null;
  }

  switch (lastCheck.reason) {
    case 'binary_detected':
      return '已检测到可执行文件。';
    case 'directory_detected':
      return '已检测到安装目录。';
    case 'service_ready_without_path':
      return '当前按服务型运行时视为就绪。';
    case 'configured_binary_missing':
      return '已配置的可执行文件路径不存在。';
    case 'configured_install_path_missing':
      return '已配置的安装目录不存在。';
    case 'required_entries_missing':
      return '安装目录缺少必需条目。';
    case 'candidate_paths_missing':
      return '候选路径都未命中可用运行时。';
    case 'not_configured':
      return '尚未提供可检测的运行时路径。';
    default:
      return null;
  }
}

function renderRuntimeDiagnostics(runtime: Runtime): string {
  if (!runtime.lastCheck) {
    return '<div class="pill-row"><span class="pill muted-pill">还没有检测记录</span></div>';
  }

  const reason = describeRuntimeCheckReason(runtime);
  const details: string[] = [
    `<span class="pill">最近检测 · ${escapeHtml(formatTime(runtime.lastCheck.checkedAt))}</span>`,
    `<span class="pill">状态 · ${escapeHtml(runtime.lastCheck.status)}</span>`,
  ];

  if (runtime.lastCheck.sourcePath) {
    details.push(`<span class="pill">来源 · ${escapeHtml(runtime.lastCheck.sourcePath)}</span>`);
  }

  if (runtime.lastCheck.missingEntries.length > 0) {
    details.push(`<span class="pill">缺少条目 · ${escapeHtml(runtime.lastCheck.missingEntries.join(', '))}</span>`);
  }

  return `
    <div class="entity-meta">
      <div>
        <div class="meta-label">最近检测</div>
        <div class="pill-row">${details.join('')}</div>
      </div>
      ${reason ? `<div class="muted">${escapeHtml(reason)}</div>` : ''}
    </div>
  `;
}

function toneForBoolean(value: boolean): Tone {
  return value ? 'green' : 'neutral';
}

function toneForInstallState(value: string): Tone {
  if (value === 'installed') {
    return 'green';
  }

  if (value === 'broken') {
    return 'red';
  }

  return 'amber';
}

function toneForHealthState(value: string): Tone {
  if (value === 'ready') {
    return 'green';
  }

  if (value === 'broken' || value === 'misconfigured') {
    return 'red';
  }

  if (value === 'offline' || value === 'missing') {
    return 'amber';
  }

  return 'neutral';
}

function renderBadge(label: string, tone: Tone = 'neutral'): string {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function renderSummaryCard(label: string, value: number, description: string): string {
  return `
    <article class="summary-card">
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
      <p class="summary-description">${escapeHtml(description)}</p>
    </article>
  `;
}

function renderSuggestedAction(action: ControlPlaneSuggestedAction): string {
  if (action.command) {
    return `
      <button
        class="action-button ghost"
        type="button"
        data-action-source="suggested"
        ${action.targetRef ? `data-scroll-target="${escapeHtml(action.targetRef)}"` : ''}
        ${action.formRef ? `data-form-ref="${escapeHtml(action.formRef)}"` : ''}
        ${action.focusField ? `data-focus-field="${escapeHtml(action.focusField)}"` : ''}
        ${action.prefill ? `data-prefill='${escapeHtml(JSON.stringify(action.prefill))}'` : ''}
        data-api-action="${escapeHtml(action.command.path)}"
        data-api-method="${escapeHtml(action.command.method)}"
        ${action.command.body ? `data-api-body="${escapeHtml(JSON.stringify(action.command.body))}"` : ''}
      >${escapeHtml(action.label)}</button>
    `;
  }

  if (action.navigateTo) {
    return `
      <a
        class="action-button ghost"
        href="${escapeHtml(action.navigateTo)}"
        data-action-source="suggested"
        ${action.targetRef ? `data-scroll-target="${escapeHtml(action.targetRef)}"` : ''}
        ${action.formRef ? `data-form-ref="${escapeHtml(action.formRef)}"` : ''}
        ${action.focusField ? `data-focus-field="${escapeHtml(action.focusField)}"` : ''}
        ${action.prefill ? `data-prefill='${escapeHtml(JSON.stringify(action.prefill))}'` : ''}
      >${escapeHtml(action.label)}</a>
    `;
  }

  return `<span class="pill">${escapeHtml(action.label)}</span>`;
}

function renderPackageCard(entry: ControlPlaneSnapshot['packages'][number]): string {
  const actions: string[] = [];
  const packageId = encodeURIComponent(entry.package.packageId);

  if (entry.package.installState === 'uninstalled') {
    actions.push(`<button class="action-button primary" type="button" data-api-action="/api/packages/${packageId}/install" data-api-method="POST">安装</button>`);
  } else {
    actions.push(`<button class="action-button" type="button" data-api-action="/api/packages/${packageId}/${entry.package.enabled ? 'disable' : 'enable'}" data-api-method="POST">${entry.package.enabled ? '停用' : '启用'}</button>`);
    actions.push(`<button class="action-button danger" type="button" data-api-action="/api/packages/${packageId}/uninstall" data-api-method="POST" data-confirm-message="确认卸载 ${escapeHtml(entry.package.name)} 吗？">卸载</button>`);
  }

  actions.push(`<button class="action-button ghost" type="button" data-api-action="/api/packages/${packageId}/agent-exposure" data-api-method="POST" data-agent-enabled="${entry.package.agentEnabled ? 'false' : 'true'}">${entry.package.agentEnabled ? '断开 Agent' : '接入 Agent'}</button>`);

  return `
    <article class="panel-card entity-card" data-filter-card data-entity-ref="package:${escapeHtml(entry.package.packageId)}" data-search="${escapeHtml([entry.package.name, entry.package.packageId, ...entry.capabilityIds].join(' '))}">
      <div class="card-head">
        <div>
          <div class="eyebrow">${escapeHtml(entry.package.packageType)}</div>
          <h3>${escapeHtml(entry.package.name)}</h3>
          <p class="muted">${escapeHtml(entry.package.packageId)}</p>
        </div>
        <div class="action-cluster">${actions.join('')}</div>
      </div>
      <div class="badge-row">
        ${renderBadge(`安装: ${entry.package.installState}`, toneForInstallState(entry.package.installState))}
        ${renderBadge(`启用: ${entry.package.enabled ? 'yes' : 'no'}`, toneForBoolean(entry.package.enabled))}
        ${renderBadge(`手动: ${entry.package.manualEnabled ? 'yes' : 'no'}`, toneForBoolean(entry.package.manualEnabled))}
        ${renderBadge(`Agent: ${entry.package.agentEnabled ? 'yes' : 'no'}`, toneForBoolean(entry.package.agentEnabled))}
        ${renderBadge(`手动就绪: ${entry.readiness.manualAvailable ? 'ready' : 'blocked'}`, toneForBoolean(entry.readiness.manualAvailable))}
        ${renderBadge(`Agent 就绪: ${entry.readiness.agentAvailable ? 'ready' : 'blocked'}`, toneForBoolean(entry.readiness.agentAvailable))}
      </div>
      <div class="entity-meta">
        <div>
          <div class="meta-label">Capabilities</div>
          <div class="pill-row">${entry.capabilityIds.map((id) => `<span class="pill">${escapeHtml(id)}</span>`).join('')}</div>
        </div>
        <div>
          <div class="meta-label">Connectors</div>
          <div class="pill-row">${entry.connectorStates.length > 0 ? entry.connectorStates.map((connector) => `<span class="pill">${escapeHtml(connector.connectorId)} · ${escapeHtml(connector.status)}</span>`).join('') : '<span class="pill muted-pill">无依赖</span>'}</div>
        </div>
        <div>
          <div class="meta-label">Runtimes</div>
          <div class="pill-row">${entry.runtimeStates.length > 0 ? entry.runtimeStates.map((runtime) => `<span class="pill">${escapeHtml(runtime.runtimeId)} · ${escapeHtml(runtime.healthState)}</span>`).join('') : '<span class="pill muted-pill">无依赖</span>'}</div>
        </div>
        <div>
          <div class="meta-label">Manual 通道阻塞</div>
          ${
            entry.issues.manual.length > 0
              ? `<ul class="issue-list">${entry.issues.manual.map((issue) => `<li class="issue-item"><strong>${escapeHtml(issue.code)}</strong> · ${escapeHtml(issue.label)}</li>`).join('')}</ul>`
              : '<div class="pill-row"><span class="pill">Manual Ready</span></div>'
          }
        </div>
        <div>
          <div class="meta-label">Agent 通道阻塞</div>
          ${
            entry.issues.agent.length > 0
              ? `<ul class="issue-list">${entry.issues.agent.map((issue) => `<li class="issue-item"><strong>${escapeHtml(issue.code)}</strong> · ${escapeHtml(issue.label)}</li>`).join('')}</ul>`
              : '<div class="pill-row"><span class="pill">Agent Ready</span></div>'
          }
        </div>
        <div>
          <div class="meta-label">建议动作</div>
          ${
            entry.suggestedActions.length > 0
              ? `<div class="pill-row">${entry.suggestedActions.map(renderSuggestedAction).join('')}</div>`
              : '<div class="pill-row"><span class="pill muted-pill">当前无需干预</span></div>'
          }
        </div>
      </div>
    </article>
  `;
}

function renderConnectorCard(connector: ConnectorRuntime): string {
  const connectorId = encodeURIComponent(connector.connectorId);

  return `
    <article class="panel-card entity-card" data-filter-card data-entity-ref="connector:${escapeHtml(connector.connectorId)}" data-search="${escapeHtml([connector.connectorId, connector.title ?? '', connector.connectorType].join(' '))}">
      <div class="card-head">
        <div>
          <div class="eyebrow">${escapeHtml(connector.connectorType)}</div>
          <h3>${escapeHtml(connector.title ?? connector.connectorId)}</h3>
          <p class="muted">${escapeHtml(connector.connectorId)}</p>
        </div>
        <div class="action-cluster">
          <button class="action-button" type="button" data-api-action="/api/connectors/${connectorId}/test" data-api-method="POST">检测</button>
          <button class="action-button" type="button" data-api-action="/api/connectors/${connectorId}/disable" data-api-method="POST">停用</button>
          <button class="action-button danger" type="button" data-api-action="/api/connectors/${connectorId}" data-api-method="DELETE" data-confirm-message="确认删除连接器 ${escapeHtml(connector.connectorId)} 吗？">删除</button>
        </div>
      </div>
      <div class="badge-row">
        ${renderBadge(`状态: ${connector.status}`, toneForHealthState(connector.status))}
        ${renderBadge(`启用: ${connector.enabled ? 'yes' : 'no'}`, toneForBoolean(connector.enabled))}
      </div>
      <form class="inline-form" data-form-ref="connector-update:${escapeHtml(connector.connectorId)}" data-api-form="/api/connectors/${connectorId}" data-api-method="PATCH" data-form-kind="connector-update">
        <label>
          <span>标题</span>
          <input type="text" name="title" value="${escapeHtml(connector.title ?? '')}" />
        </label>
        <label>
          <span>Enabled</span>
          <select name="enabled">
            <option value="">保持不变</option>
            <option value="true"${connector.enabled ? ' selected' : ''}>true</option>
            <option value="false"${!connector.enabled ? ' selected' : ''}>false</option>
          </select>
        </label>
        <label class="full-width">
          <span>配置 JSON</span>
          <textarea name="configJson" rows="6">${escapeHtml(formatJson(connector.config ?? {}))}</textarea>
        </label>
        <div class="form-actions">
          <button class="action-button primary" type="submit">更新连接器</button>
        </div>
      </form>
    </article>
  `;
}

function getRuntimePathField(runtime: Runtime): {
  label: string;
  name: 'binaryPath' | 'installPath';
  value: string;
} {
  if (runtime.detection?.kind === 'directory') {
    return {
      label: 'Install Path',
      name: 'installPath',
      value: runtime.installPath ?? '',
    };
  }

  return {
    label: 'Binary Path',
    name: 'binaryPath',
    value: runtime.binaryPath ?? '',
  };
}

function renderRuntimeCard(runtime: Runtime): string {
  const runtimeId = encodeURIComponent(runtime.runtimeId);
  const pathField = getRuntimePathField(runtime);

  return `
    <article class="panel-card entity-card" data-filter-card data-entity-ref="runtime:${escapeHtml(runtime.runtimeId)}" data-search="${escapeHtml([runtime.runtimeId, runtime.name, runtime.runtimeType].join(' '))}">
      <div class="card-head">
        <div>
          <div class="eyebrow">${escapeHtml(runtime.runtimeType)}</div>
          <h3>${escapeHtml(runtime.name)}</h3>
          <p class="muted">${escapeHtml(runtime.runtimeId)}</p>
        </div>
        <div class="action-cluster">
          <button class="action-button" type="button" data-api-action="/api/runtimes/${runtimeId}/detect" data-api-method="POST">检测</button>
          <button class="action-button danger" type="button" data-api-action="/api/runtimes/${runtimeId}/uninstall" data-api-method="POST">卸载</button>
        </div>
      </div>
      <div class="badge-row">
        ${renderBadge(`安装: ${runtime.installState}`, toneForInstallState(runtime.installState))}
        ${renderBadge(`健康: ${runtime.healthState}`, toneForHealthState(runtime.healthState))}
        ${runtime.version ? renderBadge(`版本: ${runtime.version}`, 'blue') : ''}
      </div>
      ${renderRuntimeDiagnostics(runtime)}
      <div class="runtime-layout">
        <form class="inline-form" data-form-ref="runtime-install:${escapeHtml(runtime.runtimeId)}" data-api-form="/api/runtimes/${runtimeId}/install" data-api-method="POST" data-form-kind="runtime-install">
          <div class="subheading">Install / Repair</div>
          <label><span>${escapeHtml(pathField.label)}</span><input type="text" name="${escapeHtml(pathField.name)}" value="${escapeHtml(pathField.value)}" /></label>
          <label><span>Version</span><input type="text" name="version" value="${escapeHtml(runtime.version ?? '')}" /></label>
          <div class="form-actions"><button class="action-button primary" type="submit">安装或修复</button></div>
        </form>
        <form class="inline-form" data-form-ref="runtime-relink:${escapeHtml(runtime.runtimeId)}" data-api-form="/api/runtimes/${runtimeId}/relink" data-api-method="POST" data-form-kind="runtime-relink">
          <div class="subheading">Relink</div>
          <label><span>${escapeHtml(pathField.label)}</span><input type="text" name="${escapeHtml(pathField.name)}" value="${escapeHtml(pathField.value)}" /></label>
          <label><span>Version</span><input type="text" name="version" value="${escapeHtml(runtime.version ?? '')}" /></label>
          <div class="form-actions"><button class="action-button" type="submit">重新绑定</button></div>
        </form>
      </div>
    </article>
  `;
}

function renderExecutionRow(execution: ExecutionLogEntry): string {
  return `
    <tr>
      <td>${escapeHtml(formatTime(execution.timestamp))}</td>
      <td>${escapeHtml(execution.capabilityId)}</td>
      <td>${escapeHtml(execution.caller)}</td>
      <td>${renderBadge(execution.status, execution.status === 'success' ? 'green' : 'red')}</td>
      <td>${escapeHtml(execution.durationMs)}</td>
      <td>${escapeHtml(execution.connectorId)}</td>
    </tr>
  `;
}

export function renderConsolePage(model: ConsolePageModel): string {
  const summaryCards = [
    renderSummaryCard('功能包', model.snapshot.summary.packageCount, `${model.snapshot.summary.installedPackageCount} 已安装`),
    renderSummaryCard('Manual Ready', model.snapshot.summary.manualEnabledPackageCount, '平台手动可用能力包'),
    renderSummaryCard('Agent Ready', model.snapshot.summary.agentEnabledPackageCount, '已开放给 Agent 的能力包'),
    renderSummaryCard('连接器', model.snapshot.summary.connectorCount, `${model.snapshot.summary.readyConnectorCount} Ready`),
    renderSummaryCard('运行时', model.snapshot.summary.runtimeCount, `${model.snapshot.summary.readyRuntimeCount} Ready`),
  ].join('');

  const capabilityOptions = model.manualCapabilities.map((capability) => `
    <option value="${escapeHtml(capability.capabilityId)}">${escapeHtml(capability.capabilityId)} · ${escapeHtml(capability.summary)}</option>
  `).join('');

  return `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Control Platform</title>
    <style>${consoleStyles}</style>
  </head>
  <body>
    <div class="console-shell">
      <aside class="sidebar">
        <div class="brand-block">
          <div class="brand-mark">ACP</div>
          <div class="brand-title">Agent Control Platform</div>
          <p class="brand-subtitle">Manual First · Agent Optional</p>
        </div>
        <nav class="sidebar-nav">
          <a class="nav-link" href="#overview"><span class="nav-bullet"></span><span>控制面概览</span></a>
          <a class="nav-link" href="#packages"><span class="nav-bullet"></span><span>功能包</span></a>
          <a class="nav-link" href="#connectors"><span class="nav-bullet"></span><span>连接器</span></a>
          <a class="nav-link" href="#runtimes"><span class="nav-bullet"></span><span>运行时</span></a>
          <a class="nav-link" href="#manual"><span class="nav-bullet"></span><span>手动调用</span></a>
          <a class="nav-link" href="#executions"><span class="nav-bullet"></span><span>执行记录</span></a>
        </nav>
        <div class="empty-state">这是一版内置控制台。平台默认支持手动使用，只有显式开放的功能才会接入 Agent。</div>
      </aside>

      <div class="main-shell">
        <header class="context-bar">
          <nav class="breadcrumbs"><span>Rhodes Island</span><span>/</span><strong>Control Plane</strong></nav>
          <div class="context-tools">
            <label class="search-box">
              <input type="text" placeholder="搜索功能包、连接器、运行时..." data-console-filter />
              <span>Filter</span>
            </label>
            <button class="action-button" type="button" onclick="window.location.reload()">刷新</button>
          </div>
        </header>

        <main class="page-shell">
          <section class="hero-card" id="overview">
            <div class="hero-head">
              <div>
                <div class="eyebrow">Control Plane</div>
                <h1>控制平台优先，Agent 按需接入。</h1>
                <p class="hero-description">这一版控制台沿用旧项目的工作台层次，先把功能包、连接器、运行时、手动调用和 Agent 暴露统一放进一个可管理界面。</p>
              </div>
              <div class="hero-actions">
                <a class="action-button ghost" href="/api/control-plane" target="_blank" rel="noreferrer">查看控制面 JSON</a>
                <a class="action-button" href="/adapter/openclaw/tools" target="_blank" rel="noreferrer">查看 Agent Tools</a>
              </div>
            </div>
            <div class="summary-grid">${summaryCards}</div>
            <div class="flash" data-flash></div>
          </section>

          <div class="section-stack">
            <section class="panel-card" id="packages">
              <div class="section-head">
                <div>
                  <div class="eyebrow">Packages</div>
                  <h2 class="section-title">功能包生命周期</h2>
                  <p class="section-description">这里管理安装、启停、卸载，以及是否开放给 Agent。</p>
                </div>
              </div>
              <div class="entity-grid">${model.snapshot.packages.map(renderPackageCard).join('') || '<div class="empty-state">当前没有已注册功能包。</div>'}</div>
            </section>

            <section class="panel-card" id="connectors">
              <div class="section-head">
                <div>
                  <div class="eyebrow">Connectors</div>
                  <h2 class="section-title">外部连接器</h2>
                  <p class="section-description">支持创建、更新、检测、停用和删除。连接器决定平台接到哪个外部实例。</p>
                </div>
              </div>
              <form class="inline-form" data-form-ref="connector-create" data-api-form="/api/connectors" data-api-method="POST" data-form-kind="connector-create">
                <label><span>Connector ID</span><input type="text" name="connectorId" placeholder="filesystem.obsidian.vault.alt" required /></label>
                <label><span>Connector Type</span><select name="connectorType"><option value="filesystem">filesystem</option><option value="runtime">runtime</option></select></label>
                <label><span>Title</span><input type="text" name="title" placeholder="备用 Vault" /></label>
                <label class="full-width"><span>配置 JSON</span><textarea name="configJson" rows="5" placeholder='{"rootPath":"D:/vault"}'></textarea></label>
                <div class="form-actions"><button class="action-button primary" type="submit">创建连接器</button></div>
              </form>
              <div class="entity-grid" style="margin-top: 16px;">${model.connectors.map(renderConnectorCard).join('') || '<div class="empty-state">当前没有连接器。</div>'}</div>
            </section>

            <section class="panel-card" id="runtimes">
              <div class="section-head">
                <div>
                  <div class="eyebrow">Runtimes</div>
                  <h2 class="section-title">软件运行时</h2>
                  <p class="section-description">先做最小 detect / install / uninstall / relink 骨架，让平台能认出软件本体状态。</p>
                </div>
              </div>
              <div class="entity-grid">${model.runtimes.map(renderRuntimeCard).join('') || '<div class="empty-state">当前没有运行时。</div>'}</div>
            </section>

            <section class="panel-card" id="manual">
              <div class="section-head">
                <div>
                  <div class="eyebrow">Manual Execute</div>
                  <h2 class="section-title">手动调用</h2>
                  <p class="section-description">当功能不接入 Agent 时，仍可以直接在平台里按能力调用。</p>
                </div>
              </div>
              <div class="manual-layout">
                <form class="inline-form" data-api-form="/api/manual/execute" data-api-method="POST" data-form-kind="manual-execute">
                  <label class="full-width"><span>Capability</span><select name="capabilityId">${capabilityOptions || '<option value="">当前没有手动可用能力</option>'}</select></label>
                  <label><span>Caller</span><input type="text" name="caller" value="manual-console" /></label>
                  <label class="full-width"><span>Input JSON</span><textarea name="inputJson" rows="12" placeholder='{"query":"plugin platform"}'>{}</textarea></label>
                  <div class="form-actions"><button class="action-button primary" type="submit">执行能力</button></div>
                </form>
                <pre class="code-panel" data-manual-output>${escapeHtml(formatJson({
                  hint: '提交后这里会显示统一结果。',
                  availableCapabilities: model.manualCapabilities.map((capability) => capability.capabilityId),
                }))}</pre>
              </div>
            </section>

            <section class="panel-card" id="executions">
              <div class="section-head">
                <div>
                  <div class="eyebrow">Executions</div>
                  <h2 class="section-title">最近执行记录</h2>
                  <p class="section-description">统一执行入口留下的最近日志，便于核对调用来源、耗时和失败原因。</p>
                </div>
              </div>
              ${model.executions.length > 0 ? `
                <table>
                  <thead><tr><th>时间</th><th>Capability</th><th>Caller</th><th>状态</th><th>耗时</th><th>Connector</th></tr></thead>
                  <tbody>${model.executions.map(renderExecutionRow).join('')}</tbody>
                </table>
              ` : '<div class="empty-state">当前还没有执行记录。</div>'}
            </section>
          </div>
        </main>
      </div>
    </div>
    <script>${consoleClientScript}</script>
  </body>
</html>
  `;
}
