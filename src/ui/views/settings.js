import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, fmtWhen, plural, useLoad, Spinner, toast, toastError, Select, bytes } from '../lib.js';
import { call, native, isDesktop } from '../api.js';
import { extractPdf } from '../extract.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Settings({ app, params }) {
  const [tab, setTab] = useState((params && params.tab) || 'general');
  useEffect(() => { if (params && params.tab) setTab(params.tab); }, [params]);
  const [s, setS] = useState(app.settings);
  useEffect(() => setS(app.settings), [app.settings]);
  const save = async (patch, msg = 'Saved') => {
    try { const ns = await call('setSettings', patch); app.setSettings(ns); toast(msg, 'ok'); } catch (e) { toastError(e); }
  };
  const tabs = [['general', 'General'], ['notify', 'Notifications'], ['planning', 'Planning'], ['ai', 'AI assistant'], ['data', 'Data and import'], ['matching', 'Matching']];
  return html`
    <div class="page-head"><div><h1>Settings</h1><p>Everything is stored on this computer, in your data folder.</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    <div style="max-width:880px">
      ${tab === 'general' ? html`<${General} s=${s} setS=${setS} save=${save} app=${app} />` : null}
      ${tab === 'notify' ? html`<${Notify} s=${s} save=${save} />` : null}
      ${tab === 'planning' ? html`<${Planning} s=${s} save=${save} app=${app} />` : null}
      ${tab === 'ai' ? html`<${Ai} s=${s} save=${save} />` : null}
      ${tab === 'data' ? html`<${Data} app=${app} />` : null}
      ${tab === 'matching' ? html`<${Matching} s=${s} save=${save} app=${app} />` : null}
    </div>`;
}

function General({ s, save, app }) {
  const [name, setName] = useState(s.userName || '');
  const [company, setCompany] = useState(s.companyName || '');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('loa.theme') || 'system'; } catch (_) { return 'system'; } });
  const applyTheme = (t) => {
    setTheme(t);
    try { localStorage.setItem('loa.theme', t); } catch (_) { /* ignore */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  };
  return html`<div class="cards">
    <div class="card pad"><h3>You</h3><p class="muted small">Your name is recorded on every change you approve, and your company name appears on reports.</p>
      <div class="grid2 mt"><label class="field">Your name<input type="text" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <label class="field">Company (shown on reports)<input type="text" value=${company} onInput=${(e) => setCompany(e.target.value)} /></label></div>
      <button class="btn primary mt" onClick=${() => save({ userName: name.trim(), companyName: company.trim() })}>Save</button></div>
    <div class="card pad"><h3>Appearance</h3><div class="seg mt">${['system', 'light', 'dark'].map((t) => html`<button class=${theme === t ? 'on' : ''} onClick=${() => applyTheme(t)}>${t[0].toUpperCase() + t.slice(1)}</button>`)}</div></div>
    ${isDesktop ? html`<div class="card pad"><h3>Windows</h3>
      <label class="check mt"><input type="checkbox" checked=${s.runInBackground !== false} onChange=${(e) => save({ runInBackground: e.target.checked })} /> Keep running in the system tray when the window is closed, so reminders still arrive</label><br />
      <label class="check mt"><input type="checkbox" checked=${!!s.startWithWindows} onChange=${(e) => save({ startWithWindows: e.target.checked })} /> Start with Windows (in the tray)</label></div>` : null}
    <div class="card pad"><h3>About</h3><p class="muted small">LOA Command Center ${app.info.version}. Works offline. LOA text is read on this computer, and the optional AI assistant only talks to a model running on your own machine or network.</p></div>
  </div>`;
}

function Notify({ s, save }) {
  const [n, setN] = useState(s.notify);
  useEffect(() => setN(s.notify), [s.notify]);
  const set = (k, v) => setN({ ...n, [k]: v });
  return html`<div class="card pad">
    <h3>Action digest</h3><p class="muted small">A short Windows notification that lists what to do: expired approvals, renewals to start, LOAs to chase, portal changes. Clicking it opens your action plan. If the computer was off at the scheduled time, it arrives when the app next starts.</p>
    <label class="check mt"><input type="checkbox" checked=${n.enabled} onChange=${(e) => set('enabled', e.target.checked)} /> Send me a digest</label>
    <div class="row wrap gap-l mt">
      <div class="seg">${['daily', 'weekly', 'monthly'].map((f) => html`<button class=${n.frequency === f ? 'on' : ''} onClick=${() => set('frequency', f)}>${f[0].toUpperCase() + f.slice(1)}</button>`)}</div>
      ${n.frequency === 'weekly' ? html`<label class="row">on <${Select} value=${String(n.weekday)} onChange=${(v) => set('weekday', Number(v))} options=${DAYS.map((d, i) => ({ value: String(i), label: d }))} /></label>` : null}
      ${n.frequency === 'monthly' ? html`<label class="row">on day <input type="number" min="1" max="28" style="width:70px" value=${n.monthday} onInput=${(e) => set('monthday', Math.min(28, Math.max(1, Number(e.target.value) || 1)))} /></label>` : null}
      <label class="row">at <input type="time" value=${n.time} onInput=${(e) => set('time', e.target.value)} /></label>
    </div>
    <div class="row mt-l"><button class="btn primary" onClick=${() => save({ notify: n }, 'Schedule saved')}>Save schedule</button>
      <button class="btn" onClick=${() => native('testNotification').then(() => toast('Digest sent')).catch(toastError)}><${Icon} name="bell" /> Send one now</button>
      ${n.lastSent ? html`<span class="muted small">Last sent ${fmtWhen(n.lastSent)}</span>` : null}</div>
  </div>`;
}

function Planning({ s, save, app }) {
  const [lt, setLt] = useState(s.leadTimes);
  const [conf, setConf] = useState(s.autoApproveConfidence);
  return html`<div class="cards">
    <div class="card pad"><h3>Renewal lead times</h3><p class="muted small">How many days before expiry renewal work should start, per approval type. The planner raises a renewal action at this point and escalates it as the date gets closer.</p>
      <div class="grid4 mt">${app.info.taxonomy.categories.map((c) => html`<label class="field">${c}<input type="number" min="0" max="900" value=${lt[c] ?? 90} onInput=${(e) => setLt({ ...lt, [c]: Number(e.target.value) || 0 })} /></label>`)}</div>
      <button class="btn primary mt" onClick=${() => save({ leadTimes: lt })}>Save lead times</button></div>
    <div class="card pad"><h3>One-click approval</h3><p class="muted small">"Approve safe" applies a letter without review only when every change is a strong device match, has no warnings, and the reader's confidence is at least this value.</p>
      <div class="row mt"><input type="range" min="70" max="100" value=${conf} onInput=${(e) => setConf(Number(e.target.value))} style="width:260px" /><b>${conf}%</b>
        <button class="btn primary" onClick=${() => save({ autoApproveConfidence: conf })}>Save</button></div></div>
  </div>`;
}

function Ai({ s, save }) {
  const [ai, setAi] = useState(s.ai);
  const [status, setStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try { await call('setSettings', { ai }); setStatus(await call('aiStatus')); } catch (e) { toastError(e); } finally { setTesting(false); }
  };
  return html`<div class="cards">
    <div class="card pad"><div class="ai-head"><span class="spark"><${Icon} name="spark" /></span><h3>Local AI assistant</h3></div>
      <p class="muted small mt">The action plan, renewal waves and digest always come from the built-in rules engine, so the app works fully without AI. Turn this on to add a free local model (such as Google's Gemma) for written briefings, answers to questions about your portfolio, draft emails, and help reading difficult letters. The model runs on your computer; no data is sent to the internet.</p>
      <div class="seg mt">${[['off', 'Off'], ['ollama', 'Ollama (recommended)'], ['openai', 'Other local server']].map(([k, l]) => html`<button class=${ai.provider === k ? 'on' : ''} onClick=${() => setAi({ ...ai, provider: k, baseUrl: k === 'ollama' ? 'http://127.0.0.1:11434' : k === 'openai' ? 'http://127.0.0.1:1234' : ai.baseUrl })}>${l}</button>`)}</div>
      ${ai.provider !== 'off' ? html`<div class="grid2 mt">
        <label class="field">Server address<input type="url" value=${ai.baseUrl} onInput=${(e) => setAi({ ...ai, baseUrl: e.target.value })} /></label>
        <label class="field">Model<input type="text" list="model-list" value=${ai.model} onInput=${(e) => setAi({ ...ai, model: e.target.value })} />
          <datalist id="model-list">${['gemma3:4b', 'gemma3:12b', 'gemma3:1b', 'llama3.2:3b', 'qwen2.5:7b', ...((status && status.models) || [])].map((m) => html`<option value=${m} />`)}</datalist></label>
        ${ai.provider === 'openai' ? html`<label class="field">API key (if your server needs one)<input type="password" value=${ai.apiKey} onInput=${(e) => setAi({ ...ai, apiKey: e.target.value })} /></label>` : null}
      </div>` : null}
      <div class="row mt"><button class="btn primary" onClick=${() => save({ ai }, 'AI settings saved')}>Save</button>
        ${ai.provider !== 'off' ? html`<button class="btn" disabled=${testing} onClick=${test}>${testing ? html`<${Spinner} />` : null} Test connection</button>` : null}</div>
      ${status ? html`<div class=${`callout mt ${status.available ? 'good' : 'warn'}`}>${status.message}</div>` : null}
    </div>
    ${ai.provider === 'ollama' ? html`<div class="card pad"><h3>Set up Gemma with Ollama (about 5 minutes)</h3>
      <ol class="small" style="padding-left:18px;line-height:1.9;margin:8px 0 0">
        <li>Install Ollama for Windows from <a onClick=${() => native('openExternal', { url: 'https://ollama.com/download' })}>ollama.com/download</a>.</li>
        <li>Open a Command Prompt and run <span class="mono">ollama pull gemma3:4b</span> (about 3 GB; use <span class="mono">gemma3:1b</span> on low-memory laptops).</li>
        <li>Come back here and press Test connection.</li></ol>
      <p class="muted small mt">The address must be on this computer or your local network. Internet AI services are not allowed, so your LOAs never leave your control.</p></div>` : null}
  </div>`;
}

function Data({ app }) {
  const [health, reloadHealth] = useLoad(() => call('health'), [app.version]);
  const [backups, reloadBackups] = useLoad(() => call('listBackups'), [app.version]);
  return html`<div class="cards">
    <${ImportTracker} app=${app} />
    <${ImportPortal} app=${app} />
    <div class="card pad"><h3>Data folder</h3>
      ${health ? html`<div class="kv mt"><span class="k">Location</span><span class="mono">${health.dataDir}</span>
        <span class="k">Records</span><span>${health.records}</span><span class="k">Archived LOA files</span><span>${health.documents}</span>
        <span class="k">Database check</span><span>${health.integrity === 'ok' ? 'OK' : health.integrity}</span>
        <span class="k">Last backup</span><span>${health.lastBackup ? fmtWhen(health.lastBackup) : 'Never'}</span></div>` : html`<${Spinner} />`}
      <p class="muted small mt">Original LOA files are copied into the "LOA Documents" folder here and never modified. A backup is taken automatically each day and before any restore or bulk clear.</p>
      ${isDesktop ? html`<div class="row wrap mt">
        <button class="btn" onClick=${() => native('openPath', { path: health.dataDir }).catch(toastError)}><${Icon} name="folder" /> Open folder</button>
        <button class="btn" onClick=${async () => { try { const dir = await native('chooseFolder'); if (dir && confirm(`Move your data to ${dir}? The app restarts afterwards. A shared or OneDrive folder works for backup, but only one person should use the app on a database at a time.`)) await native('moveData', { path: dir }); } catch (e) { toastError(e); } }}>Move data folder…</button>
      </div>` : null}</div>
    <div class="card pad"><div class="row between"><h3>Backups</h3><button class="btn" onClick=${async () => { try { await call('backup', 'manual'); toast('Backup saved', 'ok'); reloadBackups(); reloadHealth(); } catch (e) { toastError(e); } }}>Back up now</button></div>
      ${backups && backups.length ? html`<table class="t compact mt"><thead><tr><th>Backup</th><th>Size</th><th></th></tr></thead><tbody>
        ${backups.slice(0, 12).map((b) => html`<tr><td class="small">${fmtWhen(b.mtime)} <span class="faint">${b.name.replace(/^loa-[\d-]+-?/, '').replace('.db', '')}</span></td><td class="small">${bytes(b.size)}</td>
          <td class="nowrap" style="text-align:right"><button class="btn sm" onClick=${async () => {
            if (!confirm('Restore this backup? Your current data is backed up first, then replaced.')) return;
            try { await call('restore', b.path); toast('Restored', 'ok'); setTimeout(() => location.reload(), 600); } catch (e) { toastError(e); }
          }}>Restore</button></td></tr>`)}</tbody></table>` : html`<p class="muted small mt">No backups yet.</p>`}</div>
    <div class="card pad"><h3>Sample and reset</h3><div class="row wrap mt">
      <button class="btn" onClick=${async () => { try { const r = await call('loadSampleData'); toast(`Loaded ${r.added} sample records`, 'ok'); app.refresh(); } catch (e) { toastError(e); } }}>Load sample data</button>
      <button class="btn danger" onClick=${async () => { if (!confirm('Delete all records, letters and history? A backup is taken first.')) return; try { await call('clearAllData'); toast('All data cleared'); app.refresh(); } catch (e) { toastError(e); } }}><${Icon} name="trash" /> Clear all data</button></div>
      <p class="muted small mt">Sample data can only be loaded into an empty database. Clear it before importing your real tracker.</p></div>
  </div>`;
}

function ImportReport({ r }) {
  return html`<div class="mt"><div class="row wrap"><span class="pill good">${r.added} new</span><span class="pill brand">${r.updated} updated</span><span class="pill">${r.unchanged} unchanged</span>
      ${r.duplicatesInFile ? html`<span class="pill warning">${r.duplicatesInFile} duplicate rows</span>` : null}${r.conflicts && r.conflicts.length ? html`<span class="pill critical">${r.conflicts.length} conflicts</span>` : null}
      ${r.notFound && r.notFound.length ? html`<span class="pill warning">${r.notFound.length} not in your records</span>` : null}</div>
    ${r.sheets ? html`<div class="small muted mt">${r.sheets.map((s) => `${s.sheet}: ${s.rows} rows${s.skipped ? `, ${s.skipped} skipped` : ''}`).join(' · ')}</div>` : null}
    ${r.context && (r.context.platform || r.context.bundle) ? html`<div class="small muted mt">Detected ${[r.context.platform, r.context.bundle].filter(Boolean).join(' · ')}</div>` : null}
    ${r.conflicts && r.conflicts.length ? html`<details class="mt"><summary class="small">Conflicts (kept your values)</summary><div class="excerpt mt">${r.conflicts.slice(0, 200).map((c) => (typeof c === 'string' ? c : `${c.device} · ${c.scheme} ${c.category} · ${c.field}: kept ${c.current || '—'}, file has ${c.incoming || '—'} (${c.reason})`)).join('\n')}</div></details>` : null}
    ${r.notFound && r.notFound.length ? html`<details class="mt"><summary class="small">Not found</summary><div class="excerpt mt">${r.notFound.join('\n')}</div></details>` : null}</div>`;
}

function ImportTracker({ app }) {
  const input = useRef();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const b = new Uint8Array(await f.arrayBuffer());
      setFile({ name: f.name, bytes: b });
      setPreview(await call('importTracker', { filename: f.name, bytes: b, dryRun: true }));
    } catch (er) { toastError(er); setFile(null); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await call('importTracker', { filename: file.name, bytes: file.bytes, dryRun: false });
      toast(`Imported: ${r.added} new, ${r.updated} updated`, 'ok');
      setFile(null); setPreview(null); app.refresh();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<div class="card pad"><h3>Import a tracker spreadsheet</h3>
    <p class="muted small">Excel (.xlsx) or CSV. Columns such as Device, Brand/Scheme, Approval type, Approval number and Expiry are recognised by name; sheet names like "L1" or "PCI" are used as hints. Re-importing is safe: your manual edits and newer dates are never overwritten.</p>
    <input ref=${input} type="file" accept=".xlsx,.xlsm,.csv" class="hidden" onChange=${pick} />
    <div class="row mt"><button class="btn primary" disabled=${busy} onClick=${() => input.current.click()}><${Icon} name="table" /> Choose spreadsheet</button>${busy ? html`<${Spinner} />` : null}</div>
    ${preview ? html`<div class="callout mt"><b>Preview of ${file.name}</b><${ImportReport} r=${preview} />
      <div class="row mt"><button class="btn primary" disabled=${busy} onClick=${apply}>Import</button><button class="btn" onClick=${() => { setFile(null); setPreview(null); }}>Cancel</button></div></div>` : null}
  </div>`;
}

function ImportPortal({ app }) {
  const input = useRef();
  const [mode, setMode] = useState('records');
  const [payload, setPayload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const b = new Uint8Array(await f.arrayBuffer());
      const lower = f.name.toLowerCase();
      let p;
      if (/\.(html?|mhtml?|mht)$/.test(lower)) p = { filename: f.name, bytes: b };
      else if (lower.endsWith('.pdf')) { const ex = await extractPdf(b, { ocr: false, keepLines: true }); p = { filename: f.name, text: ex.pages.join('\n'), lines: ex.lines }; }
      else p = { filename: f.name, text: new TextDecoder().decode(b) };
      setPayload(p);
      setPreview(await call('importPortal', { ...p, dryRun: true, asPublished: mode === 'compare' }));
    } catch (er) { toastError(er); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await call('importPortal', { ...payload, dryRun: false, asPublished: mode === 'compare' });
      toast(mode === 'compare' ? `Published dates updated on ${plural(r.updated, 'record')}` : `Imported: ${r.added} new, ${r.updated} updated`, 'ok');
      setPayload(null); setPreview(null); app.refresh();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return html`<div class="card pad"><h3>Import a published portal page</h3>
    <p class="muted small">Load the certification tables from your developer portal or kernel bundle page. Save the page from your browser as "Web page, single file" (.mhtml) or HTML for the most accurate result; a PDF printout also works.</p>
    <div class="seg mt"><button class=${mode === 'records' ? 'on' : ''} onClick=${() => { setMode('records'); setPreview(null); }}>Create and update records</button>
      <button class=${mode === 'compare' ? 'on' : ''} onClick=${() => { setMode('compare'); setPreview(null); }}>Compare published dates only</button></div>
    <p class="faint small mt">${mode === 'compare' ? 'Records are not changed; the published date is stored so the Portal changes report shows what needs updating on the website.' : 'New devices are added; existing dates are only replaced by later ones.'}</p>
    <input ref=${input} type="file" accept=".html,.htm,.mhtml,.mht,.pdf,.txt" class="hidden" onChange=${pick} />
    <div class="row mt"><button class="btn primary" disabled=${busy} onClick=${() => input.current.click()}><${Icon} name="globe" /> Choose page</button>${busy ? html`<${Spinner} />` : null}</div>
    ${preview ? html`<div class="callout mt"><b>Preview of ${payload.filename}</b> · ${plural(preview.total, 'row')} found<${ImportReport} r=${preview} />
      <div class="row mt"><button class="btn primary" disabled=${busy || !preview.total} onClick=${apply}>Import</button><button class="btn" onClick=${() => { setPayload(null); setPreview(null); }}>Cancel</button></div></div>` : null}
  </div>`;
}

function Matching({ s, save, app }) {
  const [words, setWords] = useState((s.noiseWords || []).join(', '));
  const [aliases, reload] = useLoad(() => call('listAliases'), [app.version]);
  const [a, setA] = useState(''); const [d, setD] = useState('');
  const add = async () => {
    if (!a.trim() || !d.trim()) return;
    try { const r = await call('setAlias', a.trim(), d.trim()); toast(`Alias saved; ${plural(r.rematched, 'letter')} re-matched`, 'ok'); setA(''); setD(''); reload(); app.refresh(); } catch (e) { toastError(e); }
  };
  return html`<div class="cards">
    <div class="card pad"><h3>Words to ignore in device names</h3><p class="muted small">Brand and marketing words that letters add to device names (for example a product line name). They are ignored when matching letters to devices.</p>
      <textarea rows="3" style="width:100%" class="mt" value=${words} onInput=${(e) => setWords(e.target.value)}></textarea>
      <button class="btn primary mt" onClick=${() => save({ noiseWords: words.split(/[,\n]/).map((w) => w.trim()).filter(Boolean) }, 'Saved; pending letters re-matched')}>Save</button></div>
    <div class="card pad"><h3>Device aliases</h3><p class="muted small">When a letter calls a device by another name, map it to your device name. Pending letters are re-matched straight away.</p>
      <div class="row mt"><input type="text" placeholder="Name in the letter" value=${a} onInput=${(e) => setA(e.target.value)} /><span>→</span>
        <input type="text" placeholder="Your device name" value=${d} onInput=${(e) => setD(e.target.value)} /><button class="btn primary" onClick=${add}>Add</button></div>
      ${aliases && Object.keys(aliases).length ? html`<table class="t compact mt"><tbody>${Object.entries(aliases).map(([k, v]) => html`<tr><td class="mono">${k}</td><td>→ <b>${v}</b></td>
        <td style="text-align:right"><button class="btn sm ghost" onClick=${async () => { await call('setAlias', k, ''); reload(); }}>Remove</button></td></tr>`)}</tbody></table>` : null}</div>
  </div>`;
}
