const XLSX = require('xlsx'); const { session, downloadMonthly } = require('./lib/realtime');
(async () => { const { browser, page } = await session(); try {
  const dl = await downloadMonthly(page, process.env.FROM, process.env.TO, 'inout'); await dl.saveAs(process.env.OUT);
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(process.env.OUT).Sheets['Sheet1'], { header: 1, blankrows: false }).slice(1);
  const by = {}; for (const r of rows) { const d = r[1]; by[d] = by[d] || { rows: 0, in: 0, out: 0 }; by[d].rows++; if (/\d/.test(r[2])) by[d].in++; if (/\d/.test(r[3])) by[d].out++; }
  console.log(JSON.stringify(by)); } finally { await browser.close(); } })().catch(e => { console.error('ERR', e.message); process.exit(1); });
