// Create an employee on the V26 portal (ERP_Employee.aspx?RowId=MA== = Add). One worker per run.
//   PE_NAME= PE_CARD= PE_DEPT= PE_GENDER=Male|Female PE_SHIFT=GEN PE_DOJ=dd/mm/yyyy DRY=true|false
const { session, readGrid } = require('./lib/realtime');
const fs = require('fs');
const { PE_NAME, PE_CARD, PE_DEPT, PE_GENDER, PE_DOJ } = process.env;
const PE_SHIFT = process.env.PE_SHIFT || 'GEN';
const DRY = process.env.DRY !== 'false';
const ci = (opts, want) => opts.find(o => o.toLowerCase() === want.toLowerCase());
(async () => {
  if (!PE_NAME || !PE_CARD || !PE_DEPT || !PE_GENDER || !PE_DOJ) throw new Error('PE_NAME PE_CARD PE_DEPT PE_GENDER PE_DOJ required');
  if (!/^\d{8}$/.test(PE_CARD) || PE_CARD === '00000001') throw new Error('bad card');
  const { browser, page } = await session();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  try {
    // guard: card must NOT already exist
    await page.goto('https://onlinerealsoft.com/ERP_EmployeeList.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
    if (/AccountUpgrade/i.test(page.url())) throw new Error('licence wall');
    const before = await readGrid(page);
    if (before.slice(1).some(r => r[3] === PE_CARD)) throw new Error('card already on portal: ' + PE_CARD);
    await page.goto('https://onlinerealsoft.com/ERP_Employee.aspx?RowId=MA%3d%3d', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    await page.evaluate(() => { document.querySelectorAll('.modal.show,.modal.fade,.modal-backdrop').forEach(e => e.remove()); document.body.classList.remove('modal-open'); });
    const sel = async (id, want) => { const opts = await page.locator('#' + id).evaluate(e => Array.from(e.options).map(o => o.text.trim())); const lab = ci(opts, want); if (!lab) throw new Error(`${id}: no option '${want}' in ${opts}`); await page.selectOption('#' + id, { label: lab }); };
    const setDate = async (id, v) => { await page.evaluate(([id, v]) => { const el = document.getElementById(id); if (el._flatpickr) el._flatpickr.setDate(v, true, 'd/m/Y'); el.value = v; ['input', 'change', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true }))); }, [id, v]); };
    await page.fill('#Txtempname', PE_NAME); await page.fill('#Txtcardno', PE_CARD); await page.fill('#Txtpaycode', PE_CARD);
    await sel('CboGender', PE_GENDER); await sel('cbodeptname', PE_DEPT); await sel('cboshiftname', PE_SHIFT); await sel('cboofficetimepolicy', PE_SHIFT);
    await setDate('TxtDOJ', PE_DOJ); await setDate('txtshiftstartdate', PE_DOJ);
    const read = () => page.evaluate(() => { const g = id => { const el = document.getElementById(id); return el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text.trim() : el.value; }; return { name: g('Txtempname'), card: g('Txtcardno'), pay: g('Txtpaycode'), gender: g('CboGender'), dept: g('cbodeptname'), shift: g('cboshiftname'), policy: g('cboofficetimepolicy'), doj: g('TxtDOJ'), shiftStart: g('txtshiftstartdate'), fwoff: g('cboFWOff') }; });
    const filled = await read(); console.log('Filled:', JSON.stringify(filled));
    if (filled.card !== PE_CARD || filled.gender === 'Select Gender') throw new Error('fill mismatch');
    if (DRY) { console.log('DRY — not saved'); return; }
    await Promise.all([page.waitForLoadState('networkidle', { timeout: 40000 }).catch(() => {}), page.click('#cmdsave')]);
    await page.waitForTimeout(2500);
    console.log('after save url:', page.url(), 'dialogs:', JSON.stringify(dialogs));
    await page.goto('https://onlinerealsoft.com/ERP_EmployeeList.aspx', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
    const after = await readGrid(page);
    const row = after.slice(1).find(r => r[3] === PE_CARD);
    console.log('list rows', before.length - 1, '->', after.length - 1, 'new row:', JSON.stringify(row));
    if (!row) throw new Error('NOT FOUND in list after save');
    fs.writeFileSync(`rules_backup/portal-added-${PE_CARD}-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ at: new Date().toISOString(), filled, dialogs, row, after }, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
