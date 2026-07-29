// Apply the owner's per-month manual override to an attendance record.
//
// This is a DELIBERATE MIRROR of the override block in web/src/lib/paycalc.js. The Node callers
// (Telegram payslips, CLI reports) build `att` straight from att_attendance and never applied the
// override, so a month the owner had corrected in the app reported different figures over Telegram
// than on screen — and an owner-typed OT figure produced ₹0 there (Codex review 2026-07-30).
//
// ⚠️ DUPLICATION IS INTENTIONAL AND TEMPORARY. It exists because the web engine is ESM under web/
// and the Node engine is CJS under jobs/. Delete this file when the single shared payroll core
// lands; until then, any change to paycalc's override handling MUST be mirrored here.
//
//   md          = emp.months[monthKey]
//   elapsedDays = days counted so far in the period (drives the absent back-fill for a days override)
function applyOverride(att, md, elapsedDays) {
  const ov = md && md.override;
  if (!ov) return att;
  let out = { ...att };
  if (ov.days != null) {
    // Honour the override LITERALLY: pay exactly `days` days. absentDays is left un-floored so the
    // engine's max(0, elapsed − absent) resolves back to exactly that number.
    const ovDays = Number(ov.days) || 0;
    out = {
      ...out,
      presentDays: ovDays, equivalentDays: ovDays,
      weeklyOff: 0, weeklyOffPresent: 0, holiday: 0, unpaidWorkedSat: 0,
      absentDays: (Number(elapsedDays) || 0) - ovDays,
      noRecord: false,
    };
  }
  if (ov.ot != null) {
    // otOverride marks this as OWNER-TYPED rather than portal data, so computePay honours it even for
    // app-only staff (guard/driver), who are otherwise blocked from OT for having no punch feed.
    out = { ...out, otHrs: Number(ov.ot) || 0, lateHrs: 0, earlyHrs: 0, otOverride: true };
  }
  return out;
}

module.exports = { applyOverride };
