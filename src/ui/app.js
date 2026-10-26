import { render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { html, Icon, Toasts, toast, toastError, Spinner } from './lib.js';
import { call, onEvent } from './api.js';
import { addFiles, filesFromDrop, subscribe } from './queue.js';
import { Dashboard } from './views/dashboard.js';
import { Plan } from './views/plan.js';
import { Register } from './views/register.js';
import { Matrix } from './views/matrix.js';
import { Inbox } from './views/inbox.js';
import { Reports, ReportModal } from './views/reports.js';
import { Settings } from './views/settings.js';
import { RecordDrawer } from './views/record.js';
import { Assistant } from './views/assistant.js';
import { selfTest } from './selftest.js';

window.__loaSelfTest = selfTest;

const NAV = [
  ['dashboard', 'Today', 'home'],
  ['plan', 'Action plan', 'plan'],
  ['register', 'Certifications', 'list'],
  ['matrix', 'Matrix', 'grid'],
  ['inbox', 'LOA inbox', 'inbox'],
  ['reports', 'Reports', 'report'],
  ['settings', 'Settings', 'gear'],
];

try {
  const t = localStorage.getItem('loa.theme');
  if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t);
} catch (_) { /* ignore */ }

function App() {
  const [boot, setBoot] = useState(null);
  const [route, setRoute] = useState({ name: 'dashboard', params: null });
  const [version, setVersion] = useState(0);
  const [counts, setCounts] = useState({ inbox: 0, critical: 0 });
  const [record, setRecord] = useState(undefined); // undefined closed, null new, id open
  const [report, setReport] = useState(null);
  const [ai, setAi] = useState(false);
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const refreshCounts = useCallback(async () => {
    try {
      const d = await call('getDashboard');
      setCounts({ inbox: d.summary.inboxPending, critical: d.actions.filter((a) => a.priority === 1).length });
    } catch (_) { /* shown elsewhere */ }
  }, []);
  const refresh = useCallback(() => { setVersion((v) => v + 1); refreshCounts(); }, [refreshCounts]);

  useEffect(() => {
    Promise.all([call('info'), call('getSettings')]).then(([info, settings]) => setBoot({ info, settings })).catch((e) => setBoot({ error: e.message }));
    refreshCounts();
  }, []);

  // Refresh screens as background LOA processing finishes each file.
  useEffect(() => {
    let finished = 0;
    return subscribe((q) => {
      const n = q.items.filter((i) => !['queued', 'working'].includes(i.status)).length;
      if (n > finished) refresh();
      finished = n;
    });
  }, [refresh]);

  useEffect(() => onEvent('navigate', (r) => go(r)), []);
  useEffect(() => onEvent('digest', () => refresh()), []);

  const go = useCallback((name, params = null) => { setRoute({ name, params: params ? { ...params, _t: Date.now() } : null }); }, []);

  // Drop LOAs anywhere in the window.
  useEffect(() => {
    const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true); };
    const over = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const leave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
    const drop = async (e) => {
      dragDepth.current = 0; setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.target.closest && e.target.closest('.drop')) return; // the inbox drop zone handles it
      const files = await filesFromDrop(e.dataTransfer);
      const n = addFiles(files);
      if (n) { toast(`Reading ${n} file${n === 1 ? '' : 's'}…`); go('inbox'); } else toast('No PDF or image files in that drop');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [go]);

  // Keyboard shortcuts.
  useEffect(() => {
    const k = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); const s = document.getElementById('global-search'); if (s) s.focus(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); setReport({}); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  if (!boot) return html`<div class="row" style="padding:40px"><${Spinner} /> Starting…</div>`;
  if (boot.error) return html`<div style="padding:40px"><h2>The app could not start</h2><p class="muted">${boot.error}</p></div>`;

  const app = {
    version, refresh, refreshCounts, counts, go, info: boot.info, settings: boot.settings,
    setSettings: (s) => { setBoot({ ...boot, settings: s }); refresh(); },
    openRecord: (id) => setRecord(id), openReport: (opts) => setReport(opts && !(opts instanceof Event) ? opts : {}),
    openAi: () => setAi(true), search, setSearch,
  };
  const View = { dashboard: Dashboard, plan: Plan, register: Register, matrix: Matrix, inbox: Inbox, reports: Reports, settings: Settings }[route.name] || Dashboard;

  return html`<div class="app">
    <nav class="side" aria-label="Main">
      <div class="brandmark"><div class="logo">LOA</div><div><b>Command Center</b><span>Certification manager</span></div></div>
      ${NAV.map(([k, l, i]) => html`<button class=${`nav ${route.name === k ? 'on' : ''}`} onClick=${() => go(k)}><${Icon} name=${i} />${l}
        ${k === 'inbox' && counts.inbox ? html`<span class="count">${counts.inbox}</span>` : null}
        ${k === 'plan' && counts.critical ? html`<span class="count red">${counts.critical}</span>` : null}</button>`)}
      <div class="spacer"></div>
      <button class="nav" onClick=${() => setAi(true)}><${Icon} name="spark" />Ask AI</button>
      <div class="foot">${boot.settings.companyName ? html`${boot.settings.companyName}<br />` : null}Version ${boot.info.version} · offline</div>
    </nav>
    <main class="main">
      <header class="topbar">
        <div class="search"><${Icon} name="search" /><input id="global-search" type="search" placeholder="Search devices, approvals, owners…  (Ctrl+K)" value=${search}
          onInput=${(e) => { setSearch(e.target.value); if (!['register', 'matrix'].includes(route.name)) go('register'); }} /></div>
        <span class="grow"></span>
        <button class="btn" onClick=${() => go('inbox')}><${Icon} name="upload" /> Add LOAs</button>
        <button class="btn" onClick=${() => setAi(true)}><${Icon} name="spark" /> Ask</button>
        <button class="btn primary" onClick=${() => setReport({})} title="Ctrl+P"><${Icon} name="report" /> Summary report</button>
      </header>
      <div class="content"><${View} app=${app} params=${route.params} key=${route.name} /></div>
    </main>
    ${record !== undefined ? html`<${RecordDrawer} key=${record || 'new'} id=${record} app=${app} onClose=${() => setRecord(undefined)} />` : null}
    ${report ? html`<${ReportModal} opts=${report} onClose=${() => setReport(null)} />` : null}
    ${ai ? html`<${Assistant} app=${app} onClose=${() => setAi(false)} />` : null}
    ${dragging ? html`<div class="dropcover"><div>Drop LOAs to read them</div></div>` : null}
    <${Toasts} />
  </div>`;
}

function hasFiles(e) {
  return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
}

window.addEventListener('error', (e) => toastError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason));

render(html`<${App} />`, document.getElementById('root'));
