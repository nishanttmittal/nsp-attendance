// FOCUSED TEST for the payment-confirm change: drives the REAL worker handle('mark_paid')
// using April numbers on a single throwaway TEST-PAY code. Patches notify so NO real
// Telegram is sent (messages are captured in memory). Cleans up at the end.
// Run: node testMarkPaid.js   (uses jobs/firebase-admin.json)

// 1) patch notify BEFORE requiring the worker, so worker binds our capturing versions
const notify = require('./lib/notify');
const sent = [];
notify.sendTelegram = async (t) => { sent.push(t); return { captured: true }; };
notify.sendTelegramDocument = async () => ({ captured: true });

const { handle } = require('./worker');
const { db } = require('./lib/firestore');

const MK = '2026-04';                 // April — the validated month
const NEXT = '2026-05';
const CODE = 'TEST-PAY';
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { (cond ? pass++ : fail++); console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  const sal = db().collection('att_salary').doc(CODE);
  try {
    console.log(`\n=== PAYMENT-CONFIRM TEST (April ${MK}) — TEST-PAY only ===\n`);

    // approved-but-unpaid April month, with an advance carry to verify the roll-forward
    await sal.set({
      name: 'TEST Payflow', dept: 'FITTING', shift: 'GEN', type: 'monthly', amount: 18000, active: true,
      advances: [], increments: [],
      months: { [MK]: { approved: { by: 'sim-owner', at: new Date().toISOString() }, approvedNet: 14200, approvedCarry: 800, advanceRecover: 1000 } },
    });

    // --- A) pay WITH a remark (the new field) ---
    console.log('A. Manager confirms paid — Bank, with remark');
    sent.length = 0;
    const r1 = await handle('mark_paid', { code: CODE, month: MK, mode: 'bank', remark: 'paid at gate', _by: 'sim-manager' });
    const after = (await sal.get()).data();
    const pay = after.months[MK].payment;
    ok('job returned marked paid', r1 === 'marked paid');
    ok('remark stored on payment record', pay.remark === 'paid at gate', `remark="${pay.remark}"`);
    ok('mode/net/by recorded correctly', pay.mode === 'bank' && pay.net === 14200 && pay.by === 'sim-manager', `${pay.mode}/₹${pay.net}/${pay.by}`);
    ok('month locked after pay', after.months[MK].locked === true);
    ok('mark_paid does NOT carry advance (finalize_hisab does that now — owner 2026-06-15)', after.months[NEXT] === undefined);
    ok('Telegram fired once', sent.length === 1);
    ok('Telegram line includes amount, mode, remark + who', /14,200/.test(sent[0]) && /bank/.test(sent[0]) && /paid at gate/.test(sent[0]) && /by sim-manager/.test(sent[0]), sent[0]);

    // --- A2) SAFETY: a second mark_paid on an already-paid month is ignored (no overwrite) ---
    sent.length = 0;
    const r2 = await handle('mark_paid', { code: CODE, month: MK, mode: 'cash', _by: 'sim-manager' });
    ok('re-pay of an already-paid month is ignored', /already paid/.test(r2), r2);
    ok('original payment record preserved (bank/₹14200)', (await sal.get()).data().months[MK].payment.net === 14200);

    // --- B) pay WITHOUT a remark (optional field empty) — fresh unpaid month (full reset clears A's payment) ---
    console.log('\nB. Pay with NO remark (optional) — Cash');
    await sal.set({ name: 'TEST Payflow', months: { [MK]: { approved: { by: 'sim-owner', at: new Date().toISOString() }, approvedNet: 9000, approvedCarry: 0 } } });
    sent.length = 0;
    await handle('mark_paid', { code: CODE, month: MK, mode: 'cash', remark: '', _by: 'sim-manager' });
    const b = (await sal.get()).data().months[MK].payment;
    ok('empty remark stored as empty string', b.remark === '', `remark="${b.remark}"`);
    ok('Telegram has no trailing remark', !/ · paid at gate/.test(sent[0]) && /cash/.test(sent[0]), sent[0]);

    // --- C) guard: cannot pay a month that was never approved ---
    console.log('\nC. Safety: paying an un-approved month is rejected');
    await sal.set({ months: { '2026-03': {} } }, { merge: true });
    let threw = false;
    try { await handle('mark_paid', { code: CODE, month: '2026-03', mode: 'cash', remark: 'x', _by: 'sim-manager' }); }
    catch (e) { threw = /not approved/.test(e.message); }
    ok('un-approved month throws "not approved yet"', threw);

    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  } catch (e) {
    console.error('TEST ERROR:', e.message, e.stack); fail++;
  } finally {
    await sal.delete().catch(() => {});
    const gone = !(await sal.get()).exists;
    console.log(gone ? '✓ test data removed.' : '✗ TEST-PAY still present!');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
