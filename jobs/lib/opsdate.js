// Small date helpers shared by the cross-app ops jobs.
// The welder/plating apps store work dates as 'YYYY-MM-DD' strings in IST.
function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000); // shift to IST
}
function istToday() {
  return istNow().toISOString().slice(0, 10); // YYYY-MM-DD in IST
}
function istDaysAgo(n) {
  return new Date(istNow().getTime() - n * 86400000).toISOString().slice(0, 10);
}
function prettyDate(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}
module.exports = { istNow, istToday, istDaysAgo, prettyDate };
