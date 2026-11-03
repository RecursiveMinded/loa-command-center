// One device, everything it is certified for: the device itself (PCI, L1
// Contact, TQM), each hardware version (L1 Contactless, TQM, L2 per brand) and
// the bundle's shared EMV L2 contact kernel. Opened by clicking a device name.
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Drawer, Spinner, fmtDate, HealthPill, toastError } from '../lib.js';
import { call } from '../api.js';
import { DeviceCerts } from './record.js';

export function DeviceDrawer({ dev, app, onClose }) {
  const [p, setP] = useState(null);
  const load = () => call('deviceView', dev).then(setP).catch(toastError);
  useEffect(() => { load(); }, [dev.device, dev.platform, dev.bundle, app.version]);
  if (!p) return html`<${Drawer} title=${dev.device} onClose=${onClose}><${Spinner} /><//>`;
  const rows = p.sections.flatMap((s) => s.rows);
  const held = rows.filter((r) => r.record).length;
  const missing = rows.filter((r) => r.status === 'missing').length;
  const expired = rows.filter((r) => r.record && r.record.health === 'expired' && !r.record.eol).length;
  const sub = html`<span class="row wrap">${p.platform || p.bundle ? html`<span class="tag">${[p.platform, p.bundle].filter(Boolean).join(' · ')}</span>` : null}
    <span>${held} certification${held === 1 ? '' : 's'}</span>${expired ? html`<span class="bad-text">${expired} expired</span>` : null}${missing ? html`<span class="bad-text">${missing} missing</span>` : null}
    ${p.sections.length > 1 ? html`<span class="faint">Hardware versions: ${p.sections.filter((s) => s.reader).map((s) => s.version).join(', ')}</span>` : null}</span>`;
  const l2 = p.l2contact;
  return html`<${Drawer} title=${p.device} sub=${sub} onClose=${onClose} wide>
    ${!p.sections.length ? html`<div class="empty"><${Icon} name="shield" /><h3>No certifications for ${dev.device}</h3><div>Add its LOAs in the LOA inbox.</div></div>` : html`
    <div class="loa-strip"><${Icon} name="grid" /><span class="grow"><b>EMV L2 Contact kernel</b> <span class="faint small">· one approval for the whole ${p.bundle || 'bundle'}</span></span>
      ${l2 ? html`<a onClick=${() => app.openRecord(l2.id)}>${l2.kernel_version ? `v${l2.kernel_version} · ` : ''}expires ${fmtDate(l2.expiry_date) || 'no date'}</a> <${HealthPill} r=${l2} />` : html`<span class="bad-text small">Not on file</span>`}</div>
    <${DeviceCerts} p=${p} app=${app} reload=${load} />`}
  <//>`;
}
