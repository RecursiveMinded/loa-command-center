// Shared UI helpers and small components.
import { h } from 'preact';
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

// ------------------------------------------------------------------ icons
const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  plan: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  list: 'M4 6h16M4 12h16M4 18h16',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  inbox: 'M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z',
  report: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  chev: 'M9 6l6 6-6 6',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  snooze: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9h6l-6 6h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  wave: 'M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-2',
};

export function Icon({ name, size, cls }) {
  return html`<svg class=${cls} viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name] || P.file} /></svg>`;
}

// --------------------------------------------------------------- formatting
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m) return String(iso);
  return `${MON[m - 1]} ${d}, ${y}`;
}
export function fmtMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MON[m - 1]} ${String(y).slice(2)}`;
}
export function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${fmtDate(d.toISOString().slice(0, 10))} ${d.toTimeString().slice(0, 5)}`;
}
export function daysLabel(days) {
  if (days == null) return 'No date';
  if (days < 0) return `${-days} d ago`;
  if (days === 0) return 'Today';
  return `${days} d`;
}
export function plural(n, word, pl) { return `${n} ${n === 1 ? word : (pl || `${word}s`)}`; }
export function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const HEALTH = {
  expired: { label: 'Expired', color: 'var(--bad)' },
  critical: { label: 'Due ≤ 90 d', color: 'var(--crit)' },
  warning: { label: 'Due ≤ 12 mo', color: 'var(--warn)' },
  good: { label: 'Current', color: 'var(--good)' },
  unknown: { label: 'No date', color: 'var(--none)' },
  retired: { label: 'End of life', color: 'var(--none)' },
};

export function HealthPill({ r }) {
  const h0 = HEALTH[r.health] || HEALTH.unknown;
  return html`<span class=${`pill ${r.health}`}><span class="dot"></span>${r.health === 'expired' || r.health === 'critical' || r.health === 'warning' ? daysLabel(r.days) : h0.label}</span>`;
}

export function recLabel(r) {
  return [r.device, r.scheme, r.category].filter(Boolean).join(' · ');
}

// --------------------------------------------------------------- components
export function Spinner() { return html`<span class="spin"></span>`; }

export function Empty({ icon = 'file', title, children }) {
  return html`<div class="empty"><${Icon} name=${icon} /><h3>${title}</h3><div>${children}</div></div>`;
}

export function Drawer({ onClose, title, sub, wide, children, footer }) {
  useEsc(onClose);
  return html`<div>
    <div class="scrim" onClick=${onClose}></div>
    <aside class=${`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="hd row between top"><div class="grow"><h2>${title}</h2>${sub ? html`<div class="muted small mt">${sub}</div>` : null}</div>
        <button class="btn ghost icon" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
      <div class="bd">${children}</div>
      ${footer ? html`<div class="ft">${footer}</div>` : null}
    </aside></div>`;
}

export function Modal({ onClose, title, wide, children }) {
  useEsc(onClose);
  return html`<div>
    <div class="scrim" style="z-index:60" onClick=${onClose}></div>
    <div class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="row between" style="margin-bottom:12px"><h2>${title}</h2><button class="btn ghost icon" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
      ${children}
    </div></div>`;
}

function useEsc(fn) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') fn && fn(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [fn]);
}

// ------------------------------------------------------------------ toasts
let pushToast = () => {};
export function toast(msg, kind = '') { pushToast(msg, kind); }
export function toastError(e) { pushToast(e && e.message ? e.message : String(e), 'err'); }

export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    pushToast = (msg, kind) => {
      const id = Math.random();
      setList((l) => [...l, { id, msg, kind }]);
      setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3800);
    };
  }, []);
  return html`<div class="toasts" role="status">${list.map((t) => html`<div class=${`toast ${t.kind}`} key=${t.id}>${t.msg}</div>`)}</div>`;
}

// ------------------------------------------------------------------- hooks
/** Load async data; reloads when deps change. Returns [data, reload, loading, error]. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (my === seq.current) setState({ data, loading: false, error: null });
    } catch (e) {
      if (my === seq.current) setState((s) => ({ ...s, loading: false, error: e }));
    }
  }, deps);
  useEffect(() => { load(); }, [load]);
  return [state.data, load, state.loading, state.error];
}

export function usePersist(key, initial) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(`loa.${key}`); return s ? { ...initial, ...JSON.parse(s) } : initial; } catch (_) { return initial; }
  });
  const set = useCallback((nv) => {
    setV((old) => {
      const next = typeof nv === 'function' ? nv(old) : nv;
      try { localStorage.setItem(`loa.${key}`, JSON.stringify(next)); } catch (_) { /* private mode */ }
      return next;
    });
  }, [key]);
  return [v, set];
}

/** Run an async action with busy state and error toasts. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn) => {
    setBusy(true);
    try { return await fn(); } catch (e) { toastError(e); return undefined; } finally { setBusy(false); }
  }, []);
  return [busy, run];
}

export function unique(list) { return [...new Set(list.filter((x) => x != null && x !== ''))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })); }

export function Ring({ value, size = 74 }) {
  const r = (size - 10) / 2, c = 2 * Math.PI * r;
  const color = value >= 80 ? 'var(--good)' : value >= 60 ? 'var(--warn)' : 'var(--bad)';
  return html`<div class="ring" style=${`width:${size}px;height:${size}px`}>
    <svg width=${size} height=${size}><circle cx=${size / 2} cy=${size / 2} r=${r} stroke="var(--line)" stroke-width="8" fill="none" />
      <circle cx=${size / 2} cy=${size / 2} r=${r} stroke=${color} stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray=${`${(c * value) / 100} ${c}`} /></svg>
    <b>${value}</b></div>`;
}

export function Select({ value, onChange, options, placeholder, cls, title }) {
  return html`<select class=${cls} value=${value} title=${title || placeholder} aria-label=${title || placeholder} onChange=${(e) => onChange(e.target.value)}>
    ${placeholder != null ? html`<option value="">${placeholder}</option>` : null}
    ${options.map((o) => (typeof o === 'object' ? html`<option value=${o.value}>${o.label}</option>` : html`<option value=${o}>${o}</option>`))}
  </select>`;
}
