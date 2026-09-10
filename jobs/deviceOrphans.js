// READ-ONLY: machine list + raw attendance log 01–10 Sep vs portal employee list.
// Goal: card numbers the DEVICE recorded that are NOT on the portal.
const XLSX = require('/home/nishel/attendance-app/jobs/node_modules/xlsx');
const { session, readGrid } = require('/home/nishel/attendance-app/jobs/lib/realtime');
const fs = require('fs');
const S = '/tmp/claude-1000/-home-nishel/d79b081a-0853-4b9f-8a46-6eff905703db/scratchpad';
(async () => {
  const { browser, page } = await session();
  try {
    // 1. machine list
    await page.goto('https://onlinerealsoft.com/ERP_MachineList.aspx', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2000);
    const mg = await readGrid(page);
    console.log('MACHINES:'); mg.slice(0, 8).forEach(r => console.log('  ', r.join(' | ')));
    // 2. portal employee codes
    await page.goto('https://onlinerealsoft.com/ERP_EmployeeList.aspx', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    const eg = await readGrid(page);
    const codes = new Set();
    for (const r of eg) for (const c of r) { const m = c.match(/\b(\d{8})\b/); if (m) codes.add(m[1]); }
    console.log('PORTAL employee codes:', codes.size);
    // 3. raw attendance log
    await page.goto('https://onlinerealsoft.com/ERP_AttendanceLog.aspx', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2000);
    const ctl = await page.evaluate(() => ({
      devs: Array.from(document.querySelectorAll('#Device_List option')).map(o => o.value + ':' + o.text),
      btns: Array.from(document.querySelectorAll('input[type=submit],input[type=button],button,a[id]')).filter(b => b.offsetWidth > 0).map(b => `${b.id}=${(b.value || b.innerText || '').trim().slice(0, 25)}`).slice(0, 40),
    }));
    console.log('LOG PAGE devices:', ctl.devs.join(' ; '));
    console.log('LOG PAGE buttons:', ctl.btns.join(' ; '));
    for (const [sel, v] of [['#txtdate', '01/09/2026'], ['#txttodate', '10/09/2026']]) {
      await page.evaluate(({ sel, v }) => { const e = document.querySelector(sel); e.removeAttribute('readonly'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, { sel, v });
    }
    // find the download control: prefer element whose text mentions download/excel/export
    page.on('dialog', d => { console.log('DIALOG:', d.message()); d.accept().catch(()=>{}); });
    await page.evaluate(() => { const sel = document.querySelector('#Device_List'); for (const o of sel.options) o.selected = true; sel.dispatchEvent(new Event('change', { bubbles: true })); if (window.$ && $(sel)[0].sumo) { try { $(sel)[0].sumo.selectAll(); } catch(e){} } });
    console.log('device selected:', await page.evaluate(() => Array.from(document.querySelector('#Device_List').selectedOptions).map(o=>o.value).join(',')));
    const target = '#Button3'; const _skip = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input[type=submit],input[type=button],button,a'));
      const hit = els.find(b => b.offsetWidth > 0 && /download|excel|export|show|view|generate/i.test((b.value || b.innerText || b.id || '')));
      return hit ? (hit.id ? '#' + hit.id : null) : null;
    });
    console.log('download control:', target);
    if (!target) { console.log('no download control found — page HTML saved'); fs.writeFileSync(S + '/attlog.html', await page.content()); return; }
    let dl = null;
    try {
      [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(target)]);
    } catch (e) { console.log('no download event:', e.message.slice(0, 80)); }
    if (dl) {
      const f = S + '/rawlog_sep.xls'; await dl.saveAs(f);
      const wb = XLSX.readFile(f); const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
      console.log('RAW rows:', rows.length, 'header:', JSON.stringify(rows[0]).slice(0, 200));
      const seen = {};
      for (const r of rows.slice(1)) { const c = String(r[0] ?? '').trim(); const m = c.match(/\d+/); if (!m) continue; const k = m[0].padStart(8, '0'); seen[k] = (seen[k] || 0) + 1; }
      const orphans = Object.keys(seen).filter(k => !codes.has(k)).sort();
      console.log('raw punch codes:', Object.keys(seen).length, '| NOT ON PORTAL:', orphans.length);
      orphans.forEach(k => console.log('  ORPHAN', k, 'punches', seen[k]));
      fs.writeFileSync(S + '/rawlog_summary.json', JSON.stringify({ seen, orphans, portal: [...codes] }, null, 1));
    } else {
      // maybe it rendered a grid instead
      await page.waitForTimeout(3000);
      const g = await readGrid(page); console.log('grid rows after click:', g.length); g.slice(0, 5).forEach(r => console.log('  ', r.join(' | ')));
      fs.writeFileSync(S + '/attlog_after.html', await page.content());
    }
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
