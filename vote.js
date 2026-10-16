// repo file: vote.js — vote all eligible ledger accounts (GitHub Actions)
// env: CANDIDATE (override), MIN_AGE_DAY (default 1)
const fs = require('fs');
const API = 'https://lagoslife.eliysites.com/api';
const CANDIDATE = process.env.CANDIDATE || 'ecd275bba2b54d4b948c';
const DAY = 86400000 * (Number(process.env.MIN_AGE_DAY) || 1);
const CONC = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ledger = null;
for (const p of ['store/accs.json', './store/accs.json', 'accs.json', 'store/minified accs.json']) {
  try { ledger = JSON.parse(fs.readFileSync(p, 'utf8')); console.log('loaded', p, ledger.length); break; }
  catch (e) {}
}
if (!ledger) throw new Error('no ledger: check store checkout');

const now = Date.now();
const ready = ledger.filter(a => {
  if (!a || !a.u || !a.p) return false;
  if (a.voted === true) return false;
  if (a.at && now - Number(a.at) < DAY) return false;
  return true;
});
console.log(`ledger:${ledger.length} | ready:${ready.length} | candidate:${CANDIDATE}`);

const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};

const S = { touched: 0, voted: 0, vote409: 0, voteFail: 0, loginFail: 0, skipped: 0, putFail: 0, err: 0, done: 0 };
let cursor = 0, STOP = false;

async function one(a) {
  if (STOP) return;
  const lr = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: a.u, password: a.p }) });
  if (!lr.ok) { S.loginFail++; return; }
  const cookie = jar(lr);
  const H = { 'content-type': 'application/json', 'cookie': cookie };
  await sleep(150);
  const sv = await fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie } }).then(r => r.json());
  const g = sv.game || (sv.state && sv.state.game);
  if (!g) { S.skipped++; return; }
  // force-teleport to pollingUnit (no location gate — same as console script)
  g.travel = null; g.work = null; g.job = null; g.queue = []; g.path = [];
  g.pos = { x: 1, y: 1 }; g.facing = 1; g.location = 'pollingUnit'; g.lastMode = 'danfo';
  g.visited = g.visited || [];
  if (!g.visited.includes('pollingUnit')) g.visited.push('pollingUnit');
  g.stats = g.stats || {}; g.stats.visited = g.stats.visited || [];
  if (!g.stats.visited.includes('pollingUnit')) g.stats.visited.push('pollingUnit');
  g.outbox = { notices: [], fx: [] };
  const put = await fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify({ game: g, base: sv.base || sv.updatedAt }) });
  if (!put.ok) { S.putFail++; return; }
  S.touched++;
  await sleep(300);
  const vr = await fetch(`${API}/gov/vote`, { method: 'POST', headers: H, body: JSON.stringify({ candidate: CANDIDATE }) });
  if (vr.ok) { S.voted++; return; }
  const t = await vr.text().catch(() => '');
  if (t.toLowerCase().includes('new accounts')) { STOP = true; console.log('AGE GATE — stopping'); return; }
  if (vr.status === 409) { S.vote409++; return; }
  S.voteFail++;
  if (S.voteFail <= 5) console.log('VOTE FAIL:', a.u, vr.status, t.slice(0, 160));
}

async function worker() {
  while (!STOP) {
    const i = cursor++, a = ready[i];
    if (!a) return;
    try { await one(a); } catch (e) { S.err++; }
    S.done++;
    if (S.done % 50 === 0 || S.done === S.total) console.log(`[${S.done}/${S.total}] touched:${S.touched} voted:${S.voted} 409:${S.vote409} fail:${S.voteFail} putFail:${S.putFail} skipped:${S.skipped}`);
    await sleep(150);
  }
}

(async () => {
  S.total = ready.length;
  const start = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`DONE in ${((Date.now() - start) / 60000).toFixed(1)}min | touched:${S.touched} voted:${S.voted} 409:${S.vote409} voteFail:${S.voteFail} putFail:${S.putFail} loginFail:${S.loginFail} skipped:${S.skipped} err:${S.err}`);
})();
