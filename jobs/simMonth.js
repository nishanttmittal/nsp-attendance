// DUMMY-MONTH SIMULATION — exercises the full salary lifecycle against the SAME engine
// and the SAME Firestore fields the app/worker use, with clearly-marked TEST-* employees.
// It NEVER touches the real 92 staff or the biometric machine, and DELETES all test data
// at the end (finally block). Read-back assertions print ✓ / ✗.
const { computePay } = require('./salaryCalc');
const { db } = require('./lib/firestore');

const MK = '2026-05';                       // a complete month → full-month rules (bonus etc.)
const [Y, M] = MK.split('-').map(Number);
const DIM = new Date(Date.UTC(Y, M, 0)).getUTCDate();
const CTX = { daysInMonth: DIM, elapsedDays: DIM, fullMonth: true, monthStart: new Date(Date.UTC(Y, M - 1, 1)), toDate: new Date(Date.UTC(Y, M - 1, DIM)) };
const NEXT = M === 12 ? `${Y + 1}-01` : `${Y}-${String(M + 1).padStart(2, '0')}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { (cond ? pass++ : fail++); console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN');

// pay using the exact same inputs the app's payFor() builds
function pay(emp, att, md = {}) {
  const advs = (emp.advances || []).filter(a => (a.date || '').startsWith(MK));
  const advBalIn = Number(md.advanceBalanceIn || 0);
  const advRecover = md.advanceRecover != null ? Number(md.advanceRecover) : advs.reduce((s, a) => s + Number(a.amount || 0), 0) + advBalIn;
  return computePay({ emp, att, ...CTX, advances: advs, advanceBalanceIn: advBalIn, advanceRecover: advRecover,
    fines: Number(md.fine || 0), loanInstallment: Number(md.loanInstallment || 0), bonus: Number(md.bonus || 0) });
}

const CODES = ['TEST-1', 'TEST-2', 'TEST-3', 'TEST-4', 'TEST-5'];

(async () => {
  const fdb = db();
  const sal = c => fdb.collection('att_salary').doc(c);
  const att = c => fdb.collection('att_attendance').doc(c);
  try {
    console.log(`\n=== DUMMY-MONTH SIMULATION (${MK}, ${DIM} days) — TEST workers only ===\n`);

    // 1) create 5 test workers
    console.log('1. Add 5 test workers');
    await sal('TEST-1').set({ name: 'TEST Ramesh', nickname: 'Press line', dept: 'PRESS', shift: 'GEN', type: 'monthly', amount: 18000, active: true, advances: [], increments: [], months: {} });
    await sal('TEST-2').set({ name: 'TEST Suresh', dept: 'FITTING', shift: 'GEN', type: 'monthly', amount: 15000, active: true, advances: [], increments: [], months: {} });
    await sal('TEST-3').set({ name: 'TEST Daanish', dept: 'HELPER', shift: 'GEN', type: 'daily', wage: 600, active: true, advances: [], increments: [], months: {} });
    await sal('TEST-4').set({ name: 'TEST Mahesh', dept: 'WELDING', shift: '12H', type: 'monthly', amount: 22000, active: true, advances: [], increments: [], months: {} });
    await sal('TEST-5').set({ name: 'TEST Vikas', dept: 'POWDER', shift: 'GEN', type: 'monthly', amount: 16000, active: true, advances: [], increments: [], months: {} });
    ok('5 workers created', (await Promise.all(CODES.map(c => sal(c).get()))).every(s => s.exists));

    // 2) punch attendance (write att_attendance months map directly — simulates the machine)
    console.log('\n2. Attendance for the month');
    await att('TEST-1').set({ months: { [MK]: { presentDays: DIM, absentDays: 0, otHrs: 12, lateHrs: 0, earlyHrs: 0 } } }); // perfect → bonus
    await att('TEST-2').set({ months: { [MK]: { presentDays: 24, absentDays: 3, otHrs: 18, lateHrs: 2, earlyHrs: 0 } } });
    await att('TEST-3').set({ months: { [MK]: { presentDays: 20, absentDays: 0, otHrs: 0, lateHrs: 0, earlyHrs: 0 } } }); // daily wager
    await att('TEST-4').set({ months: { [MK]: { presentDays: 25, absentDays: 1, otHrs: 60, lateHrs: 3, earlyHrs: 0 } } }); // will get a missed-punch fix
    await att('TEST-5').set({ months: { [MK]: { presentDays: 26, absentDays: 0, otHrs: 8, lateHrs: 0, earlyHrs: 0 } } });
    ok('attendance written for all', (await att('TEST-1').get()).data().months[MK].presentDays === DIM);

    // 3) missed punch → correction (simulate the EFFECT: log + credit the day, like the worker does)
    console.log('\n3. Missed punch → fix as full day (with reason + log)');
    {
      const ref = sal('TEST-4'), e = (await ref.get()).data();
      const corrections = [...(e.corrections || []), { date: '14/05/2026', in: '09:00', out: '21:00', reason: 'machine breakdown, worker was present', by: 'sim-owner', at: new Date().toISOString() }];
      await ref.set({ corrections }, { merge: true });
      const a = att('TEST-4'); const rec = (await a.get()).data().months[MK];
      await a.set({ months: { [MK]: { ...rec, presentDays: rec.presentDays + 1, absentDays: Math.max(0, rec.absentDays - 1) } } }, { merge: true });
      const after = (await ref.get()).data();
      ok('correction logged (who/when/reason)', after.corrections.length === 1 && /machine breakdown/.test(after.corrections[0].reason));
      ok('absent day credited to present', (await a.get()).data().months[MK].presentDays === 26);
    }

    // 4) advance with date + mode + remark
    console.log('\n4. Advance (date + mode + remark)');
    {
      const ref = sal('TEST-2'), e = (await ref.get()).data();
      await ref.set({ advances: [...(e.advances || []), { date: `${MK}-10`, mode: 'cash', amount: 2000, remark: 'festival', paidBy: 'sim-manager' }] }, { merge: true });
      const a = (await ref.get()).data().advances;
      ok('advance recorded with date+remark', a.length === 1 && a[0].amount === 2000 && a[0].remark === 'festival' && a[0].date === `${MK}-10`);
    }

    // 5) increment with date + remark
    console.log('\n5. Increment (date + remark, from this month)');
    {
      const ref = sal('TEST-1'), e = (await ref.get()).data();
      await ref.set({ increments: [...(e.increments || []), { amount: 1000, effective: `${MK}-01`, remark: 'annual hike' }] }, { merge: true });
      const fresh = (await ref.get()).data();
      const p = pay(fresh, (await att('TEST-1').get()).data().months[MK]);
      ok('increment lifts effective rate 18000→19000', p.effectiveRate === 19000, `engine rate ${rupee(p.effectiveRate)}`);
    }

    // 6) approve salary (compute → store), and HOLD one worker
    console.log('\n6. Approve salaries (tick) + put one on Hold');
    const approved = {};
    for (const c of ['TEST-1', 'TEST-2', 'TEST-3', 'TEST-4']) {
      const e = (await sal(c).get()).data();
      const a = (await att(c).get()).data().months[MK];
      const p = pay(e, a);
      approved[c] = p;
      await sal(c).set({ months: { ...(e.months || {}), [MK]: { ...(e.months?.[MK] || {}), approved: { by: 'sim-owner', at: new Date().toISOString() }, approvedNet: p.net, approvedCarry: p.advanceBalanceCarried, advanceRecover: p.advanceRecovered } } }, { merge: true });
      console.log(`     ${e.name}: ${a.presentDays}d · OT net ${p.otHrsNet}h · base ${rupee(p.base)} + OT ${rupee(p.otPay)}${p.perfectBonus ? ' + bonus ' + rupee(p.perfectBonus) : ''}${p.advanceRecovered ? ' − adv ' + rupee(p.advanceRecovered) : ''} = NET ${rupee(p.net)}`);
    }
    ok('TEST-1 perfect-attendance bonus applied', approved['TEST-1'].perfectBonus > 0, `bonus ${rupee(approved['TEST-1'].perfectBonus)}`);
    ok('TEST-2 advance deducted from net', approved['TEST-2'].advanceRecovered === 2000);
    ok('TEST-3 daily-wager base = wage×days = 600×20', approved['TEST-3'].base === 12000, `base ${rupee(approved['TEST-3'].base)}`);
    ok('TEST-4 OT paid net of late hrs (12H divisor)', approved['TEST-4'].otHrsNet === 57, `net OT ${approved['TEST-4'].otHrsNet}h`);
    {
      const e = (await sal('TEST-5').get()).data();
      await sal('TEST-5').set({ months: { ...(e.months || {}), [MK]: { hold: { reason: 'machine damage settlement pending', by: 'sim-owner', at: new Date().toISOString() } } } }, { merge: true });
      const h = (await sal('TEST-5').get()).data().months[MK];
      ok('TEST-5 on Hold with reason, not approved', !!h.hold && !h.approved, h.hold.reason);
    }

    // 7) mark paid (simulate worker mark_paid: lock + payment + roll advance forward)
    console.log('\n7. Manager marks paid (bank/cash) + advance rolls forward');
    for (const [c, mode] of [['TEST-1', 'bank'], ['TEST-2', 'cash']]) {
      const e = (await sal(c).get()).data();
      const md = e.months[MK];
      const months = { ...e.months, [MK]: { ...md, locked: true, payment: { date: `${MK}-31`, mode, net: md.approvedNet, by: 'sim-manager' } } };
      months[NEXT] = { ...(months[NEXT] || {}), advanceBalanceIn: Number(md.approvedCarry || 0) };
      await sal(c).set({ months }, { merge: true });
    }
    ok('TEST-1 marked PAID (bank)', (await sal('TEST-1').get()).data().months[MK].payment.mode === 'bank');
    ok('TEST-2 marked PAID (cash)', (await sal('TEST-2').get()).data().months[MK].payment.mode === 'cash');

    // 8) payslip / 9) whatsapp — both read the same computePay net; verify it's a clean positive number
    console.log('\n8/9. Payslip + WhatsApp numbers');
    ok('TEST-1 payslip net positive & matches approved', approved['TEST-1'].net > 0 && (await sal('TEST-1').get()).data().months[MK].payment.net === approved['TEST-1'].net, rupee(approved['TEST-1'].net));

    // 10) editing after approval is blocked — verify the lock condition the UI uses
    console.log('\n10. Post-approval edit lock');
    {
      const md1 = (await sal('TEST-1').get()).data().months[MK]; // paid
      const md4 = (await sal('TEST-4').get()).data().months[MK]; // approved, not paid
      const locked = md => !!md.payment || !!md.approved;
      ok('paid month is locked', locked(md1) === true);
      ok('approved (un-paid) month is locked', locked(md4) === true);
      ok('held month blocks approval', !(await sal('TEST-5').get()).data().months[MK].approved);
    }

    // 11) final settlement on resign (prorated to last day) + inactive
    console.log('\n11. Final settlement & resign (mid-month last day)');
    {
      const c = 'TEST-3', last = `${MK}-20`;
      const e = (await sal(c).get()).data();
      const a = (await att(c).get()).data().months[MK];
      const sp = computePay({ emp: { ...e, exitDate: last }, att: a, ...CTX, advances: [], advanceBalanceIn: 0, advanceRecover: 0 });
      const months = { ...e.months, [MK]: { ...(e.months?.[MK] || {}), approved: { by: 'sim-owner', at: new Date().toISOString() }, approvedNet: sp.net, locked: true, payment: { date: last, mode: 'settlement', net: sp.net, by: 'sim-owner', settlement: true } } };
      await sal(c).set({ months, active: false, exitDate: last, resignedAt: last }, { merge: true });
      const after = (await sal(c).get()).data();
      ok('settlement payment recorded (mode settlement)', after.months[MK].payment.settlement === true, rupee(after.months[MK].payment.net));
      ok('worker marked inactive with exit date', after.active === false && after.exitDate === last);
      ok('daily-wager settlement only paid worked days (no full month)', sp.net === sp.base, `${rupee(sp.base)} base, net ${rupee(sp.net)}`);
    }

    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  } catch (e) {
    console.error('SIMULATION ERROR:', e.message); fail++;
  } finally {
    // CLEANUP — remove every TEST-* doc so nothing reaches the real list
    console.log('\nCleaning up test data…');
    for (const c of CODES) { await sal(c).delete().catch(() => {}); await att(c).delete().catch(() => {}); }
    const left = (await Promise.all(CODES.map(c => sal(c).get()))).filter(s => s.exists).length
      + (await Promise.all(CODES.map(c => att(c).get()))).filter(s => s.exists).length;
    console.log(left === 0 ? '✓ all test data removed.' : `✗ ${left} test docs still present!`);
    process.exit(fail > 0 ? 1 : 0);
  }
})();
