// job.js — parallel boot/repair/drain. env: MODE, TO, TEMPLATE_U, TEMPLATE_P (+ACCS_JSON fallback)
const fs = require('fs');
const API = 'https://lagoslife.eliysites.com/api';
const TO = process.env.TO || '';
const FEE = 50, MIN = 100, SEED = 1096000, CONC = 5;
let ledger = null;
for (const p of ['store/accs.json', './store/accs.json', 'accs.json', 'store/minified accs.json']) {
  try { ledger = JSON.parse(fs.readFileSync(p, 'utf8')); console.log('loaded ledger from', p, ledger.length, 'accounts'); break; }
  catch (e) {}
}
if (!ledger && process.env.ACCS_JSON) { ledger = JSON.parse(process.env.ACCS_JSON); console.log('loaded ledger from ACCS_JSON secret', ledger.length, 'accounts'); }
if (!ledger) {
  console.log('WORKSPACE ROOT:', fs.readdirSync('.'));
  try { console.log('STORE DIR:', fs.readdirSync('store')); } catch (e) { console.log('no store/ dir — second checkout missing or failed'); }
  throw new Error('no ledger found: commit job.yml with both checkout steps, or re-add the ACCS_JSON secret');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};
const login = async (u, p) => {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return r.ok ? { 'content-type': 'application/json', 'cookie': jar(r) } : null;
};
const S = { booted: 0, repaired: 0, drained: 0, broke: 0, fail: 0, total: 0, done: 0 };
const ERR = [];
const note = (m) => { if (ERR.length < 10) ERR.push(m); };
let cursor = 0, clean = null;
async function one(a) {
  const H = await login(a.u, a.p);
  if (!H) { S.fail++; return; }
  const get = async () => fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie: H.cookie } }).then(r => r.json());
  const put = (game, base) => fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify({ game, base }) });
  let sv = await get();
  if (!sv?.game && clean) {
    const g = JSON.parse(JSON.stringify(clean));
    g.sim.name = a.u;
    if ((await put(g, sv.now ?? Date.now())).ok) { S.booted++; await sleep(100); sv = await get(); }
    else { S.fail++; note('BOOT ' + a.u); return; }
  }
  if (!sv?.game) { S.fail++; note('NOGAME ' + a.u); return; }
  if (Number(sv.game.money) < MIN + FEE) {
    const g = JSON.parse(JSON.stringify(sv.game));
    g.money = SEED;
    const rr = await put(g, sv.updatedAt ?? sv.now);
    if (!rr.ok) { S.broke++; note('REPAIR ' + a.u + ' ' + rr.status); return; }
    S.repaired++; await sleep(100); sv = await get();
  }
  let amount = Math.floor(Number(sv.game.money ?? 0)) - FEE;
  if (amount < MIN) { S.broke++; return; }
  for (let t = 0; t < 3; t++) {
    const sr = await fetch(`${API}/send`, { method: 'POST', headers: H, body: JSON.stringify({ to: TO, amount }) });
    if (sr.ok) { S.drained++; S.total += amount; return; }
    const err = await sr.text();
    if (err.includes('try again')) { await sleep(2000); continue; }
    const have = Number((err.match(/have ₦([\d,]+)/) || [])[1]?.replace(/,/g, ''));
    if (have) { amount = have - FEE; await sleep(500); continue; }
    S.fail++; note('SEND ' + a.u + ' ' + sr.status + ' ' + err.slice(0, 100)); return;
  }
  S.fail++; note('SEND-retry ' + a.u);
}
async function worker() {
  while (true) {
    const a = ledger[cursor++];
    if (!a) return;
    try { await one(a); } catch (e) { S.fail++; }
    S.done++;
    if (S.done % 100 === 0) console.log(`${S.done}/${ledger.length} drained:${S.drained} ₦${S.total.toLocaleString()} repaired:${S.repaired} booted:${S.booted} broke:${S.broke} fail:${S.fail}`);
    await sleep(150);
  }
}
(async () => {
  const TH = await login(process.env.TEMPLATE_U, process.env.TEMPLATE_P);
  if (TH) {
    const ts = await fetch(`${API}/save`, { headers: { cookie: TH.cookie } }).then(r => r.json());
    if (ts?.game) { clean = JSON.parse(JSON.stringify(ts.game)); clean.money = SEED; }
  }
  console.log(clean ? 'template ready' : 'template FAILED — boot disabled', ledger.length, 'accounts');
  const start = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`DONE in ${((Date.now() - start) / 60000).toFixed(1)}min | drained:${S.drained} ₦${S.total.toLocaleString()} repaired:${S.repaired} booted:${S.booted} broke:${S.broke} fail:${S.fail}`);
  console.log('ERRORS:\n' + ERR.join('\n'));
})();
