// Monthly attendance download from NewMonthly.aspx.
//   MONTH=0|1|2   (0=current month-to-date, 1=last month, 2=two months ago)
//   SCOPE=all | dept:<DEPARTMENT NAME> | emp:<EMP CODE>
//   REPORT=Button10 (Monthly Summary In Excel, default) | Button15 | Btn_MonthlyMusterBookReport ...
// Captures the file download into ./downloads. Falls back to scraping an inline table to CSV.
const path = require('path');
const fs = require('fs');
const { session } = require('./lib/realtime');

const URL = 'https://onlinerealsoft.com/NewMonthly.aspx';
const OUT_DIR = path.resolve(__dirname, 'downloads');
const MONTH = parseInt(process.env.MONTH || '0', 10);
const SCOPE = process.env.SCOPE || 'all';
const REPORT = process.env.REPORT || 'Button10';
const DRY = process.env.DRY === 'true';

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }

// returns { from, to, label } for the target month
function monthRange(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0);
  const to = offset === 0 ? now : lastOfMonth; // current month -> up to today
  return { from: first, to, label: `${first.getFullYear()}-${pad(first.getMonth() + 1)}` };
}

async function setDate(page, sel, value) {
  await page.locator(sel).evaluate((n, v) => {
    n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); n.blur();
  }, value);
}

// Department scope: NewMonthly mislabels the Department controls as "Designation"
// (optfewDesignation radio + chkdepartmentlist_* checkboxes). Select by label text.
async function selectDepartment(page, deptName) {
  await page.check('#MainContent_optfewDesignation').catch(() => {});
  await page.waitForTimeout(800);
  const result = await page.evaluate((name) => {
    const want = name.trim().toUpperCase();
    const boxes = Array.from(document.querySelectorAll('input[id^="MainContent_chkdepartmentlist_"]'));
    // each checkbox's OWN label (CheckBoxList renders <input id=x><label for=x>NAME</label>)
    const labelOf = cb => {
      const l = document.querySelector(`label[for="${cb.id}"]`);
      return (l ? l.innerText : '').trim().toUpperCase();
    };
    boxes.forEach(cb => { if (cb.checked) cb.click(); });           // clear any defaults
    const target = boxes.find(cb => labelOf(cb) === want);
    if (!target) return { id: null, labels: boxes.map(labelOf) };
    if (!target.checked) target.click();
    return { id: target.id, labels: boxes.map(labelOf) };
  }, deptName);
  if (!result.id) throw new Error(`Department "${deptName}" not found. Available: ${result.labels.join(', ')}`);
  return result.id;
}

// Click an All/Few radio by its visible label text (the form mislabels control ids).
async function checkRadioByLabel(page, labelText) {
  const id = await page.evaluate((t) => {
    const lbl = Array.from(document.querySelectorAll('label')).find(l => l.innerText.trim().toLowerCase() === t.toLowerCase());
    return lbl ? lbl.getAttribute('for') : null;
  }, labelText);
  if (!id) throw new Error('Radio label not found: ' + labelText);
  await page.locator('#' + id).check({ force: true }).catch(async () => {
    await page.locator('#' + id).evaluate(r => r.click());
  });
  return id;
}

// Single-employee scope: pick "Few Employee" (styled radio -> DOM click; triggers a postback),
// then check the employee box whose label contains the code.
async function selectEmployee(page, code) {
  await page.locator('#optFewEmployee').evaluate(r => { if (!r.checked) r.click(); });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const res = await page.evaluate((c) => {
    const boxes = Array.from(document.querySelectorAll('input[id^="chkemployeelist_"]'));
    const labelOf = cb => {
      const l = document.querySelector(`label[for="${cb.id}"]`);
      if (l) return l.innerText.trim();
      let n = cb.parentElement; return n ? n.innerText.trim() : '';
    };
    const target = boxes.find(cb => labelOf(cb).includes(c));
    if (!target) return { ok: false, count: boxes.length, sample: boxes.slice(0, 3).map(labelOf) };
    if (!target.checked) target.click();
    return { ok: true, label: labelOf(target) };
  }, code);
  if (!res.ok) throw new Error(`Employee ${code} not found among ${res.count} (sample: ${(res.sample || []).join(' | ')})`);
  return res.label;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, context, page } = await session();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200);
    if (await page.locator('#MainContent_chknewwindow').isChecked().catch(() => false)) {
      await page.uncheck('#MainContent_chknewwindow').catch(() => {});
    }
    const { from, to, label } = monthRange(MONTH);
    await setDate(page, '#MainContent_txtdate', fmt(from));
    await setDate(page, '#MainContent_txttodate', fmt(to));

    let scopeTag = 'all';
    if (SCOPE.startsWith('dept:')) { await selectDepartment(page, SCOPE.slice(5)); scopeTag = 'dept-' + SCOPE.slice(5).replace(/\s+/g, '_'); }
    else if (SCOPE.startsWith('emp:')) { const lbl = await selectEmployee(page, SCOPE.slice(4)); console.log('  picked employee:', lbl); scopeTag = 'emp-' + SCOPE.slice(4); }
    // all = leave defaults

    console.log(`Month ${label}  range ${fmt(from)}..${fmt(to)}  scope=${SCOPE}  report=${REPORT}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'monthly_prepared.png'), fullPage: true });
    if (DRY) { console.log('=> DRY: prepared only'); await browser.close(); return; }

    const outName = `monthly_${label}_${scopeTag}.xls`;
    const outPath = path.join(OUT_DIR, outName);
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 35000 }),
        page.click('#MainContent_' + REPORT),
      ]);
      await download.saveAs(outPath);
      const sz = fs.statSync(outPath).size;
      console.log(`=> DOWNLOADED ${outName} (${sz} bytes) suggested="${download.suggestedFilename()}"`);
    } catch (e) {
      // no download — maybe inline table or popup; capture both for diagnosis
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT_DIR, 'monthly_after_click.png'), fullPage: true });
      const pages = context.pages();
      console.log(`=> NO DOWNLOAD (${e.message.split('\n')[0]}). open pages=${pages.length}; screenshot saved.`);
    }
  } finally { await browser.close(); }
})();
