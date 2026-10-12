// repo file: move.js — move all ledger accounts to pollingUnit (GitHub Actions)
const fs = require('fs');
const API = 'https://lagoslife.eliysites.com/api';
const CONC = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ledger = null;
for (const p of ['store/accs.json', './store/accs.json', 'accs.json', 'store/minified accs.json']) {
  try { ledger = JSON.parse(fs.readFileSync(p, 'utf8')); console.log('loaded', p, ledger.length); break; }
  catch (e) {}
}
if (!ledger) throw new Error('no ledger: check store checkout');
const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};
const S = { moved: 0, there: 0, loginFail: 0, noGame: 0, putFail: 0, err: 0, done: 0 };
let cursor = 0;
async function one(a, i) {
  const lr = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: a.u, password: a.p }) });
  if (!lr.ok) { S.loginFail++; return; }
  const H = { 'content-type': 'application/json', 'cookie': jar(lr) };
  const sv = await fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie: H.cookie } }).then(r => r.json());
  const g = sv.game || (sv.state && sv.state.game);
  if (!g) { S.noGame++; return; }
  if (g.location === 'pollingUnit' && ((g.stats || {}).visited || []).includes('pollingUnit')) { S.there++; return; }
  g.travel = null; g.work = null; g.job = null; g.queue = []; g.path = [];
  g.pos = { x: 1, y: 1 }; g.facing = 1; g.location = 'pollingUnit'; g.lastMode = 'danfo';
  g.visited = g.visited || [];
  if (!g.visited.includes('pollingUnit')) g.visited.push('pollingUnit');
  g.stats = g.stats || {}; g.stats.visited = g.stats.visited || [];
  if (!g.stats.visited.includes('pollingUnit')) g.stats.visited.push('pollingUnit');
  g.money = (g.money || 0) - 250;
  g.ledger = g.ledger || [];
  g.ledger.push({ id: Date.now().toString(36) + i, k: 'travel.trip', a: -250, t: Date.now(), r: 'danfo:pollingUnit' });
  g.outbox = { notices: [], fx: [] };
  const put = await fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify({ game: g, base: sv.base || sv.updatedAt }) });
  put.ok ? S.moved++ : S.putFail++;
}
async function worker() {
  while (true) {
    const i = cursor++, a = ledger[i];
    if (!a) return;
    try { await one(a, i); } catch (e) { S.err++; }
    S.done++;
    if (S.done % 100 === 0) console.log(`${S.done}/${ledger.length} moved:${S.moved} there:${S.there} putFail:${S.putFail} loginFail:${S.loginFail} noGame:${S.noGame} err:${S.err}`);
    await sleep(150);
  }
}
(async () => {
  const start = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`DONE in ${((Date.now() - start) / 60000).toFixed(1)}min | moved:${S.moved} there:${S.there} putFail:${S.putFail} loginFail:${S.loginFail} noGame:${S.noGame} err:${S.err}`);
})();
