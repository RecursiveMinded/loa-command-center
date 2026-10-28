'use strict';
// Browser smoke test of the whole UI against the real backend (dev server).
// Needs Playwright with Chromium installed:  npm run test:ui
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const L = require('../fixtures/letters');

const PORT = 5199;

/** A minimal multi-page PDF with a text layer, one letter per page. */
function pdfFromPages(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const text of pages) {
    const lines = text.split('\n').flatMap((l) => (l.match(/.{1,95}(\s|$)|\S+/g) || ['']));
    const esc = (s) => s.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '-');
    const stream = `BT /F1 10 Tf 13 TL 50 750 Td ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loa-ui-'));
  const pdf = path.join(tmp, 'Northwind merged.pdf');
  fs.writeFileSync(pdf, pdfFromPages([L.amex, L.emvco, L.mastercard]));
  // A letter whose device the reader cannot find (the fake AI supplies it).
  const blind = path.join(tmp, 'No device.pdf');
  fs.writeFileSync(blind, pdfFromPages([L.discover.replace('Product: Flex/3XXX CL1 ', '')]));
  // A family letter for devices that are not in the register yet.
  const family = path.join(tmp, 'New family.pdf');
  fs.writeFileSync(family, pdfFromPages([L.discover.replace('Flex/3XXX', 'Zeta/7XXX')]));
  // A letter that does not name its device; the file name does.
  const named = path.join(tmp, 'P400CL1_Discover_L2.pdf');
  fs.writeFileSync(named, pdfFromPages([L.discover.replace('Product: Flex/3XXX CL1 ', '').replace('Discover', 'Discover Global Network')]));
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'dev', 'server.js'), path.join(tmp, 'data'), String(PORT)], { stdio: 'inherit', env: { ...process.env, LOA_FAKE_AI: 'Flex/3500-CL1' } });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch();
  const errors = [];
  let failed = false;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForSelector('text=Welcome to LOA Command Center');
    check(true, 'welcome screen');
    await p.click('text=Try sample data');
    await p.waitForSelector('text=Portfolio health');
    check(true, 'dashboard with sample data');
    for (const v of ['Action plan', 'Certifications', 'Devices', 'Matrix', 'Reports', 'Archive', 'Settings']) {
      await p.click(`nav >> text=${v}`);
      await p.waitForSelector(`h1:has-text("${v === 'Certifications' ? 'Certifications' : v}")`);
      check(true, `${v} screen`);
    }
    await p.click('nav >> text=LOA inbox');
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('text=Choose files')]);
    await chooser.setFiles(pdf);
    await p.waitForSelector('text=Finished 1 file', { timeout: 60000 });
    const note = await p.locator('.queue .qitem').first().innerText();
    check(/3 letters found/.test(note), `PDF read and split: ${note.replace(/\s+/g, ' ')}`);
    await p.waitForFunction(() => document.querySelectorAll('.card.review').length >= 3, null, { timeout: 15000 }).catch(() => {});
    const cards = await p.locator('.card.review').count();
    check(cards === 3, `${cards} letters waiting for review`);
    // Approve one letter, then reopen its LOA from the record.
    await p.locator('.card.review').first().locator('button:has-text("Approve")').click();
    await p.waitForFunction(() => document.querySelectorAll('.card.review').length === 2);
    // Bulk edit what the review just created or updated.
    await p.click('text=Bulk edit these');
    await p.waitForSelector('.bulkbar b:has-text("selected")');
    await p.fill('.bulkbar input[aria-label="Value"]', 'Lab platform');
    await p.click('.bulkbar >> text=Apply');
    await p.waitForSelector('td >> text=Lab platform');
    await p.selectOption('.bulkbar select[aria-label="Field"]', 'tags+');
    await p.fill('.bulkbar input[aria-label="Value"]', 'Program X');
    await p.click('.bulkbar >> text=Apply');
    await p.waitForSelector('.utag >> text=Program X');
    check(true, 'bulk edit after review: platform and tag set');
    await p.click('nav >> text=Certifications');
    await p.locator('button.linktag').first().click();
    await p.waitForSelector('.drawer >> text=Northwind merged.pdf');
    const [popup] = await Promise.all([p.waitForEvent('popup'), p.locator('.drawer button[title="Open the LOA"]').first().click()]);
    check(!!popup, 'LOA opens in a new tab from the record');
    await popup.close();
    const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('.drawer button[title="Save a copy"]').first().click()]);
    check(dl.suggestedFilename() === 'Northwind merged.pdf', `LOA saved as a copy: ${dl.suggestedFilename()}`);
    await p.keyboard.press('Escape');
    // The same LOA added to another record offers to link the existing file.
    if (await p.locator('.bulkbar >> text=Clear selection').count()) await p.click('.bulkbar >> text=Clear selection');
    await p.locator('button:has-text("Clear filters")').click({ timeout: 2000 }).catch(() => {});
    await p.locator('table.t tbody tr:not(:has(button.linktag)) .dev').first().click();
    await p.click('.drawer >> text=/^LOAs/');
    await p.setInputFiles('#attach-loa', pdf);
    await p.waitForSelector('.modal >> text=Duplicate LOA', { timeout: 10000 });
    await p.click('.modal >> text=Link the existing LOA to this record');
    await p.waitForSelector('.drawer >> text=Northwind merged.pdf', { timeout: 5000 });
    check(true, 'duplicate LOA added from a record is linked, not stored twice');
    await p.click('.drawer .tabs >> text=/All certifications/');
    await p.waitForSelector('.drawer table.certs', { timeout: 5000 });
    check(true, `record shows all certifications of its device (${await p.locator('.drawer table.certs tbody tr').count()} rows)`);
    await p.click('.drawer .tabs >> text=Details');
    await p.fill('input[aria-label="Add a covered device"]', 'Desk/1700');
    await p.click('.drawer .covers + .row >> text=Add');
    await p.waitForSelector('.drawer .tagrow.covers >> text=Desk/1700');
    await p.click('.drawer >> text=Save changes');
    await p.waitForSelector('text=Saved', { timeout: 5000 });
    check(true, 'one LOA can also certify other devices (covers list saved)');
    await p.check('.drawer input[aria-label="Not renewing"]');
    await p.fill('.drawer input[aria-label="End of life reason"]', 'Replaced by CL2');
    await p.click('.drawer >> text=Save changes');
    await p.waitForSelector('.drawer .pill.retired:has-text("End of life")', { timeout: 5000 });
    check(true, 'a certification can be marked end of life (accepted expiration)');
    await p.keyboard.press('Escape');
    // A letter with no device found: the AI fills it in, then Dismiss still works.
    await p.click('nav >> text=LOA inbox');
    const [ch2] = await Promise.all([p.waitForEvent('filechooser'), p.click('text=Choose files')]);
    await ch2.setFiles(blind);
    await p.waitForSelector('.card.review:has-text("No device.pdf")', { timeout: 60000 });
    const blindCard = p.locator('.card.review:has-text("No device.pdf")');
    await blindCard.locator('button:has-text("AI: find missing values")').click();
    await p.waitForSelector('.card.review:has-text("No device.pdf") >> text=Flex/3500-CL1', { timeout: 10000 });
    await p.locator('.card.review:has-text("No device.pdf") button:has-text("Reject")').click();
    await p.waitForFunction(() => ![...document.querySelectorAll('.card.review')].some((c) => c.textContent.includes('No device.pdf')), null, { timeout: 10000 });
    check(true, 'AI fills a missing device, then the letter can still be dismissed');
    // Nothing in the register for that family yet: create the records from the letter.
    const [ch3] = await Promise.all([p.waitForEvent('filechooser'), p.click('text=Choose files')]);
    await ch3.setFiles(family);
    await p.waitForSelector('.card.review:has-text("New family.pdf")', { timeout: 60000 });
    const famCard = p.locator('.card.review:has-text("New family.pdf")');
    await famCard.locator('input[aria-label="New device name"]').fill('T10');
    await famCard.locator('.sugg:has-text("T100-CL1")').waitFor({ timeout: 5000 });
    check(true, 'device box suggests devices already in the register');
    await famCard.locator('input[aria-label="New device name"]').fill('Zeta/7100-CL1, Zeta/7200-CL1');
    await famCard.locator('button:has-text("Add")').click();
    await famCard.locator('label.field:has-text("Platform") input').fill('Gamma');
    if (process.env.LOA_SHOTS) await famCard.screenshot({ path: path.join(process.env.LOA_SHOTS, 'create-from-letter.png') });
    await famCard.locator('button:has-text("Approve 1 change")').click();
    await p.waitForSelector('text=Applied: 2 created', { timeout: 10000 });
    await p.click('nav >> text=Certifications');
    await p.locator('button:has-text("Clear filters")').click({ timeout: 2000 }).catch(() => {});
    await p.waitForSelector('text=Zeta/7200-CL1', { timeout: 10000 });
    check(true, 'family letter with no matching records creates them');
    // Hardware version filter: CL1 records only.
    await p.selectOption('select[aria-label="All hardware (CL)"]', 'CL1');
    const devs = await p.$$eval('table.t tbody .dev', (els) => els.map((e) => e.textContent));
    check(devs.length > 0 && devs.every((d) => /CL1/.test(d)), `hardware (CL) filter: ${devs.length} CL1 records`);
    // Kernel version filter.
    await p.selectOption('select[aria-label="All hardware (CL)"]', '');
    const kopts = await p.$$eval('select[aria-label="All kernel versions"] option', (os) => os.map((o) => o.value).filter((v) => v && v !== '(none)'));
    if (kopts.length) {
      await p.selectOption('select[aria-label="All kernel versions"]', kopts[0]);
      const kn = await p.$$eval('table.t tbody tr', (els) => els.length);
      check(kn > 0, `kernel version filter: ${kn} records on ${kopts[0]}`);
      await p.selectOption('select[aria-label="All kernel versions"]', '');
    } else check(false, 'kernel version filter has values');
    // Bulk delete with confirmation moves the record to the Archive.
    const before = await p.$$eval('table.t tbody tr', (els) => els.length);
    const gone = await p.locator('table.t tbody tr .dev').first().innerText();
    await p.locator('table.t tbody tr input[type=checkbox]').first().check();
    p.once('dialog', (d) => d.accept());
    await p.click('.bulkbar button:has-text("Delete 1")');
    await p.waitForSelector('text=Moved 1 record to the Archive', { timeout: 5000 });
    await p.waitForFunction((n) => document.querySelectorAll('table.t tbody tr').length === n, before - 1, { timeout: 5000 }).catch(() => {});
    const after = await p.$$eval('table.t tbody tr', (els) => els.length);
    check(after === before - 1, `bulk delete removes the selected record (${before} -> ${after})`);
    if (await p.locator('button:has-text("Clear filters")').count()) await p.click('button:has-text("Clear filters")');
    await p.click('nav >> text=Archive');
    await p.fill('#archive-search', gone.trim());
    await p.waitForSelector(`table.t tbody tr .dev:has-text("${gone.trim()}")`, { timeout: 5000 });
    check(true, `deleted record is searchable in the Archive (${gone.trim()})`);
    await p.locator('table.t tbody tr input[type=checkbox]').first().check();
    await p.click('.bulkbar button:has-text("Restore")');
    await p.waitForSelector('text=Restored 1 record', { timeout: 5000 });
    p.once('dialog', (d) => d.accept());
    await p.click('button:has-text("Move expired records here")');
    await p.waitForSelector('text=/Moved \\d+ records? to the Archive|No records in the register/', { timeout: 5000 });
    await p.fill('#archive-search', '');
    const archived = await p.$$eval('table.t tbody tr', (els) => els.length);
    if (archived) {
      await p.locator('table.t tbody tr input[type=checkbox]').first().check();
      p.once('dialog', (d) => d.accept());
      await p.click('.bulkbar button:has-text("Delete permanently")');
      await p.waitForSelector('text=Deleted 1 record permanently', { timeout: 5000 });
    }
    check(true, `restore, move expired (${archived} archived) and permanent delete`);
    await p.click('nav >> text=LOA inbox');
    const [ch4] = await Promise.all([p.waitForEvent('filechooser'), p.click('text=Choose files')]);
    await ch4.setFiles(named);
    await p.waitForSelector('.card.review:has-text("P400CL1_Discover_L2.pdf") >> text=Device taken from the file name', { timeout: 60000 });
    const namedCard = p.locator('.card.review:has-text("P400CL1_Discover_L2.pdf")');
    check(await namedCard.locator('.prop a:has-text("P400-CL1")').count() > 0, 'device read from the file name matches the register');
    // Bulk: find letters, set a platform on all of them, approve.
    await p.fill('input[aria-label="Find letters"]', 'P400CL1');
    await p.waitForFunction(() => document.querySelectorAll('.card.review').length === 1, null, { timeout: 5000 });
    await p.check('input[aria-label="Select all shown"]');
    await p.fill('input[aria-label="Platform for selected"]', 'Zed');
    await p.click('.inbox-bulk button:has-text("Set on 1")');
    await p.waitForSelector('.card.review .pill:has-text("Zed")', { timeout: 5000 });
    await p.click('.inbox-bulk button:has-text("Approve 1")');
    await p.waitForSelector('text=Approved 1 letter', { timeout: 10000 });
    check(true, 'bulk platform and approve from the LOA inbox');
    // The same file dropped in the inbox again: a duplicate that can be mapped to another device.
    const [chd] = await Promise.all([p.waitForEvent('filechooser'), p.click('text=Choose files')]);
    await chd.setFiles(named);
    await p.waitForSelector('.qitem >> text=/Duplicate, not added again/', { timeout: 30000 });
    await p.click('.qitem button:has-text("Map to another device")');
    await p.waitForSelector('.modal >> text=Duplicate LOA: map it to another device', { timeout: 5000 });
    await p.click('.modal >> text=Keep as is');
    check(true, 'duplicate LOA in the inbox is rejected with a way to map it to another device');
    // Platform alias renames existing records after confirming.
    await p.click('nav >> text=Settings');
    await p.click('text=Matching');
    await p.fill('input[aria-label="Platform aliases: other name"]', 'gamma');
    await p.fill('input[aria-label="Platform aliases: your name"]', 'Gamma Platform');
    await p.waitForSelector('text=2 records use "gamma"', { timeout: 5000 });
    p.once('dialog', (d) => d.accept());
    await p.click('.card:has-text("Platform aliases") button:has-text("Add")');
    await p.waitForSelector('text=2 records renamed', { timeout: 5000 });
    check(true, 'platform alias renames existing records');
    const st = await p.evaluate(() => window.__loaSelfTest());
    check(st.ok, `PDF reader and OCR self test ${JSON.stringify(st)}`);
    await p.click('nav >> text=Today');
    await p.click('.card:has-text("Briefing") button:has-text("Export")');
    await p.waitForSelector('.modal .briefing-preview table', { timeout: 10000 });
    check(true, `briefing export table (${await p.locator('.modal .briefing-preview tbody tr').count()} rows)`);
    await p.keyboard.press('Escape');
    await p.click('nav >> text=Ask AI');
    await p.click('.drawer button.chip:has-text("Check my data")');
    await p.waitForSelector('.drawer .msg.bot >> text=/Data checks found|nothing to clean up/', { timeout: 10000 });
    check(true, `Ask AI data check (${await p.locator('.drawer .issue').count()} findings)`);
    await p.keyboard.press('Escape');
    await p.click('nav >> text=Devices');
    const [l3] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), p.click('button:has-text("L3 sheet")')]);
    check(/L3 approval numbers/.test(l3.suggestedFilename()), `L3 sheet download: ${l3.suggestedFilename()}`);
    await p.click('nav >> text=Settings');
    await p.click('.tabs >> text=AI assistant');
    await p.fill('textarea[aria-label="Rules for the assistant"]', '- CL1 readers are end of life.');
    await p.click('.card:has-text("Your rules and memory") button:has-text("Save")');
    await p.waitForSelector('text=Rules saved', { timeout: 5000 });
    check(true, 'rules file for the assistant saved');
    await p.click('.topbar >> text=Summary report');
    await p.waitForSelector('iframe.report');
    check(true, 'summary report');
    check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } catch (e) {
    check(false, e.message.split('\n')[0]);
    const shot = path.join(tmp, 'failure.png');
    await p.screenshot({ path: shot }).catch(() => {});
    console.log(`screenshot: ${shot}\n${e.message}`);
  } finally {
    await browser.close();
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
