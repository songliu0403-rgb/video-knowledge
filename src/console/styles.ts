export const consoleStyles = `
:root {
  color-scheme: light;
  --surface: #f4f6f7;
  --surface-card: #fcfcfb;
  --surface-muted: #eef1f2;
  --line: rgba(131, 146, 154, 0.18);
  --line-strong: rgba(111, 126, 135, 0.28);
  --text: #172126;
  --text-muted: #5d6b72;
  --text-soft: #7c8b93;
  --primary: #355f68;
  --primary-soft: rgba(53, 95, 104, 0.12);
  --success: #2f6d52;
  --success-soft: rgba(47, 109, 82, 0.14);
  --warning: #8c6625;
  --warning-soft: rgba(140, 102, 37, 0.15);
  --danger: #9b4d43;
  --danger-soft: rgba(155, 77, 67, 0.15);
  --shadow: 0 24px 48px rgba(50, 60, 67, 0.08);
  --radius-xl: 28px;
  --radius-lg: 22px;
  --radius-md: 16px;
  --sidebar-width: 252px;
  font-family: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top right, rgba(53, 95, 104, 0.09), transparent 28%), linear-gradient(180deg, #f7f8f8 0%, var(--surface) 100%); color: var(--text); }
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font: inherit; }
.console-shell { display: flex; min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; width: var(--sidebar-width); display: flex; flex-direction: column; gap: 24px; padding: 28px 18px; border-right: 1px solid var(--line); background: linear-gradient(180deg, rgba(252, 252, 251, 0.9), rgba(244, 246, 247, 0.86)); backdrop-filter: blur(16px); z-index: 20; }
.brand-block { padding: 0 10px; }
.brand-mark { width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; background: var(--primary); color: #f7fbfc; font-weight: 700; letter-spacing: 0.08em; box-shadow: 0 10px 24px rgba(53, 95, 104, 0.18); }
.brand-title { margin: 14px 0 4px; font-size: 24px; font-weight: 700; letter-spacing: -0.03em; }
.brand-subtitle { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; color: var(--text-soft); text-transform: uppercase; }
.sidebar-nav { display: grid; gap: 8px; }
.nav-link { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 14px; color: var(--text-muted); font-size: 14px; font-weight: 600; transition: background 140ms ease, color 140ms ease, transform 140ms ease; }
.nav-link:hover { background: rgba(255, 255, 255, 0.74); color: var(--text); transform: translateX(1px); }
.nav-bullet { width: 8px; height: 8px; border-radius: 999px; background: rgba(53, 95, 104, 0.24); }
.main-shell { flex: 1; margin-left: var(--sidebar-width); min-width: 0; }
.context-bar { position: sticky; top: 0; z-index: 15; display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 58px; padding: 10px 28px; border-bottom: 1px solid var(--line); background: rgba(244, 246, 247, 0.84); backdrop-filter: blur(16px); }
.breadcrumbs { display: flex; gap: 10px; align-items: center; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; color: var(--text-soft); text-transform: uppercase; }
.breadcrumbs strong { color: var(--primary); }
.context-tools { display: flex; align-items: center; gap: 12px; }
.search-box { display: flex; align-items: center; gap: 10px; width: min(300px, 42vw); padding: 8px 12px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255, 255, 255, 0.72); }
.search-box input { width: 100%; border: none; background: transparent; outline: none; color: var(--text-muted); font-size: 13px; }
.search-box span { color: var(--text-soft); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap; }
.page-shell { padding: 24px 28px 40px; }
.hero-card, .panel-card { border: 1px solid rgba(131, 146, 154, 0.16); border-radius: var(--radius-xl); background: var(--surface-card); box-shadow: var(--shadow); }
.hero-card { padding: 28px; margin-bottom: 24px; background: linear-gradient(135deg, rgba(255,255,255,0.98), rgba(249,250,250,0.96)); }
.hero-head, .section-head, .card-head { display: flex; gap: 16px; justify-content: space-between; align-items: flex-start; }
.hero-head { margin-bottom: 18px; }
.eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.18em; color: var(--text-soft); text-transform: uppercase; }
h1, h2, h3 { margin: 0; letter-spacing: -0.03em; }
h1 { margin-top: 8px; font-size: 30px; line-height: 1.1; }
.hero-description, .muted, .section-description, .empty-state { color: var(--text-muted); }
.hero-description { max-width: 860px; margin-top: 12px; font-size: 14px; line-height: 1.8; }
.hero-actions, .action-cluster, .badge-row, .pill-row, .form-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.action-button { appearance: none; border: 1px solid var(--line); background: rgba(255, 255, 255, 0.76); color: var(--text); border-radius: 14px; padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer; transition: transform 120ms ease, border-color 120ms ease, background 120ms ease; }
.action-button:hover:not(:disabled) { transform: translateY(-1px); border-color: var(--line-strong); background: #ffffff; }
.action-button:disabled { opacity: 0.62; cursor: wait; }
.action-button.primary { border-color: rgba(53,95,104,0.22); background: var(--primary); color: #f7fbfc; }
.action-button.ghost { background: var(--primary-soft); color: var(--primary); border-color: transparent; }
.action-button.danger { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
.summary-grid { display: grid; gap: 16px; grid-template-columns: repeat(5, minmax(0, 1fr)); margin-top: 22px; }
.summary-card { padding: 18px; border-radius: var(--radius-lg); background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(243,246,247,0.95)); border: 1px solid rgba(131, 146, 154, 0.14); }
.summary-label, .meta-label, .subheading, th, .inline-form label span { font-size: 12px; font-weight: 700; color: var(--text-soft); letter-spacing: 0.12em; text-transform: uppercase; }
.summary-value { margin-top: 14px; font-size: 32px; font-weight: 700; }
.summary-description { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.section-stack, .entity-grid, .entity-meta { display: grid; gap: 20px; }
.panel-card { padding: 24px; }
.section-head { margin-bottom: 18px; }
.section-title { font-size: 20px; font-weight: 700; }
.section-description { margin: 8px 0 0; font-size: 14px; line-height: 1.7; }
.entity-card { display: grid; gap: 18px; }
.entity-card.entity-card-highlight {
  border-color: rgba(53, 95, 104, 0.38);
  box-shadow: 0 0 0 4px rgba(53, 95, 104, 0.08), var(--shadow);
}
.issue-list { margin: 0; padding-left: 18px; display: grid; gap: 8px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }
.issue-item strong { color: var(--text); }
.badge { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; }
.badge-neutral { background: rgba(101, 116, 123, 0.12); color: var(--text-muted); }
.badge-green { background: var(--success-soft); color: var(--success); }
.badge-amber { background: var(--warning-soft); color: var(--warning); }
.badge-red { background: var(--danger-soft); color: var(--danger); }
.badge-blue { background: var(--primary-soft); color: var(--primary); }
.pill { display: inline-flex; align-items: center; min-height: 30px; padding: 0 12px; border-radius: 999px; background: var(--surface-muted); color: var(--text-muted); font-size: 12px; font-weight: 600; }
.muted-pill { color: var(--text-soft); }
.inline-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 18px; border-radius: var(--radius-lg); border: 1px solid var(--line); background: rgba(244, 246, 247, 0.64); }
.inline-form.guided-form-highlight {
  border-color: rgba(53, 95, 104, 0.34);
  box-shadow: 0 0 0 4px rgba(53, 95, 104, 0.08);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(240, 245, 246, 0.9));
}
.inline-form label { display: grid; gap: 8px; }
.inline-form input, .inline-form select, .inline-form textarea { width: 100%; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,0.86); color: var(--text); padding: 11px 12px; resize: vertical; outline: none; }
.inline-form input:focus, .inline-form select:focus, .inline-form textarea:focus { border-color: rgba(53,95,104,0.3); box-shadow: 0 0 0 3px rgba(53,95,104,0.08); }
.full-width, .form-actions { grid-column: 1 / -1; }
.runtime-layout, .manual-layout { display: grid; gap: 16px; }
.runtime-layout { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.manual-layout { grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr); align-items: start; }
.code-panel { min-height: 320px; margin: 0; padding: 18px; border-radius: var(--radius-lg); border: 1px solid var(--line); background: #172126; color: #d4e3e7; font-size: 12px; line-height: 1.65; overflow: auto; white-space: pre-wrap; word-break: break-word; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
th { letter-spacing: 0.12em; }
.flash { min-height: 22px; margin-top: 14px; font-size: 13px; font-weight: 600; }
.flash[data-tone="green"] { color: var(--success); }
.flash[data-tone="red"] { color: var(--danger); }
.flash[data-tone="blue"] { color: var(--primary); }
.empty-state { padding: 18px; border-radius: var(--radius-lg); background: rgba(244,246,247,0.72); font-size: 14px; line-height: 1.7; }
@media (max-width: 1260px) {
  .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .manual-layout, .runtime-layout { grid-template-columns: 1fr; }
}
@media (max-width: 960px) {
  .console-shell { display: block; }
  .sidebar { position: static; width: 100%; border-right: none; border-bottom: 1px solid var(--line); }
  .main-shell { margin-left: 0; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .context-bar, .hero-head, .section-head, .card-head { flex-direction: column; align-items: stretch; }
  .search-box, .inline-form, .runtime-layout { width: 100%; grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .page-shell { padding: 18px 16px 28px; }
  .context-bar { padding: 12px 16px; }
  .summary-grid { grid-template-columns: 1fr; }
}
`;
