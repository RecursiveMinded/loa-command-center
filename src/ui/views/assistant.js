import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Drawer, Spinner, toastError, plural } from '../lib.js';
import { call } from '../api.js';

const CHECK = 'Check my data for problems and conflicts';
const SUGGEST = [
  CHECK,
  'What should I do this week?',
  'Which approvals expire in the next 90 days?',
  'Which Visa approvals expire next year?',
  'What has no owner?',
  'Summarise the portfolio for my manager',
];

export function Assistant({ app, onClose }) {
  const [status, setStatus] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef();
  useEffect(() => { call('aiStatus').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { if (end.current) end.current.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);
  const ask = async (text) => {
    const question = (text || q).trim();
    if (!question) return;
    setQ('');
    setMsgs((m) => [...m, { me: true, text: question }]);
    setBusy(true);
    try {
      // Data clean-up runs the app's integrity checks; the model (if on) prioritises them.
      const r = question === CHECK || /\b(clean ?up|integrity|conflict|data (check|quality|problem))/i.test(question) ? await call('aiDataReview') : await call('aiAsk', question);
      setMsgs((m) => [...m, { text: r.text, ai: r.ai, issues: r.issues }]);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const mode = status && status.available ? `Local AI: ${app.settings.ai.model}` : 'Rules engine (AI off)';
  return html`<${Drawer} title="Ask about your certifications" sub=${html`<span class="row"><span class="spark" style="width:20px;height:20px"><${Icon} name="spark" size="12" /></span>${mode}${status && !status.available ? html` · <a onClick=${() => { onClose(); app.go('settings', { tab: 'ai' }); }}>Set up local AI</a>` : null}</span>`} onClose=${onClose}
    footer=${html`<form class="row" style="width:100%" onSubmit=${(e) => { e.preventDefault(); ask(); }}>
      <input type="text" class="grow" placeholder="Ask a question…" value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />
      <button class="btn primary" disabled=${busy}>Ask</button></form>`}>
    ${!msgs.length ? html`<div><p class="muted">Ask in plain English. Answers come only from your own records${status && status.available ? ', summarised by the model on your computer' : ''}.</p>
      <div class="suggest mt">${SUGGEST.map((s) => html`<button class="chip" onClick=${() => ask(s)}>${s}</button>`)}</div></div>` : null}
    <div class="msgs">${msgs.map((m) => html`<div class=${`msg ${m.me ? 'me' : 'bot'}`}>${m.text}
      ${m.issues && m.issues.length ? html`<div class="issues">${m.issues.map((i) => html`<div class="issue"><span class=${`pill ${i.severity === 'high' ? 'expired' : i.severity === 'medium' ? 'critical' : 'warning'}`}>${i.severity}</span>
        <span class="grow">${i.title}</span><button class="btn sm" onClick=${() => { onClose(); app.go('register', { filter: { ids: i.recordIds, idsLabel: i.title } }); }}>Show ${plural(i.recordIds.length, 'record')}</button></div>`)}</div>` : null}</div>`)}
      ${busy ? html`<div class="msg bot row"><${Spinner} /> Thinking…</div>` : null}<div ref=${end}></div></div>
  <//>`;
}
