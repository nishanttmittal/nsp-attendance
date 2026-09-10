// Edit ONE existing employee on the V26 portal with a wait after every dropdown (slow-portal safe).
//   PE_CARD= PE_NAME= PE_DEPT= PE_GENDER= PE_SHIFT= [PE_DOJ=dd/mm/yyyy] DRY=true|false
const { session, readGrid, findEmployeeEdit } = require('./lib/realtime');
const fs = require('fs');
const { PE_CARD, PE_NAME, PE_DEPT, PE_GENDER, PE_SHIFT, PE_DOJ } = process.env;
const DRY = process.env.DRY !== 'false';
const ci = (opts, want) => opts.find(o => o.toLowerCase() === want.toLowerCase());
(async () => {
  if (!PE_CARD) throw new Error('PE_CARD required');
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    const hit = await findEmployeeEdit(page, PE_CARD);
    console.log('edit:', hit.editUrl);
    const settle = async () => { await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(1500); };
    const read = () => page.evaluate(() => { const g = id => { const el = document.getElementById(id); if (!el) return '(missing)'; return el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text.trim() : el.value; }; return { name: g('Txtempname'), card: g('Txtcardno'), gender: g('CboGender'), dept: g('cbodeptname'), shift: g('cboshiftname'), policy: g('cboofficetimepolicy'), doj: g('TxtDOJ') }; });
    const sel = async (id, want) => { const opts = await page.locator('#' + id).evaluate(e => Array.from(e.options).map(o => o.text.trim())); const lab = ci(opts, want); if (!lab) throw new Error(`${id}: no option '${want}' in ${opts}`); await page.selectOption('#' + id, { label: lab }); await settle(); };
    await page.goto(hit.editUrl, { waitUntil: 'domcontentloaded' }); await settle();
    await page.evaluate(() => { document.querySelectorAll('.modal.show,.modal.fade,.modal-backdrop').forEach(e => e.remove()); document.body.classList.remove('modal-open'); });
    const before = await read(); console.log('before:', JSON.stringify(before));
    if (before.card !== PE_CARD) throw new Error('identity mismatch: page card ' + before.card);
    if (PE_SHIFT) { await sel('cboshiftname', PE_SHIFT); await sel('cboofficetimepolicy', PE_SHIFT); }
    if (PE_DEPT) await sel('cbodeptname', PE_DEPT);
    if (PE_GENDER) await sel('CboGender', PE_GENDER);
    if (PE_NAME) { await page.fill('#Txtempname', PE_NAME); await page.waitForTimeout(300); }
    if (PE_DOJ) await page.evaluate((v) => { for (const id of ['TxtDOJ', 'txtshiftstartdate']) { const el = document.getElementById(id); if (!el) continue; if (el._flatpickr) el._flatpickr.setDate(v, true, 'd/m/Y'); el.value = v; ['input', 'change', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true }))); } }, PE_DOJ);
    // re-assert in case a late postback replaced the DOM
    let cur = await read();
    if (PE_GENDER && cur.gender !== PE_GENDER) { await sel('CboGender', PE_GENDER); cur = await read(); }
    if (PE_NAME && cur.name !== PE_NAME) { await page.fill('#Txtempname', PE_NAME); cur = await read(); }
    console.log('filled:', JSON.stringify(cur));
    const want = { name: PE_NAME, dept: PE_DEPT, gender: PE_GENDER, shift: PE_SHIFT, policy: PE_SHIFT, doj: PE_DOJ };
    const bad = Object.entries(want).filter(([k, v]) => v && String(cur[k]).toLowerCase() !== v.toLowerCase());
    if (bad.length) throw new Error('fill mismatch: ' + JSON.stringify(bad));
    if (DRY) { console.log('DRY — not saved'); return; }
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 40000 }).catch(() => {}), page.click('#cmdsave')]);
    await page.waitForTimeout(2500);
    console.log('after save url:', page.url(), 'dialogs:', JSON.stringify(dialogs));
    const hit2 = await findEmployeeEdit(page, PE_CARD);
    await page.goto(hit2.editUrl, { waitUntil: 'domcontentloaded' }); await settle();
    const after = await read(); console.log('readback:', JSON.stringify(after));
    const bad2 = Object.entries(want).filter(([k, v]) => v && String(after[k]).toLowerCase() !== v.toLowerCase());
    fs.writeFileSync(`rules_backup/portal-edit-${PE_CARD}-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ at: new Date().toISOString(), before, after, dialogs }, null, 1));
    if (bad2.length) { console.error('READBACK MISMATCH', JSON.stringify(bad2)); process.exit(2); }
    console.log('OK saved + verified');
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
