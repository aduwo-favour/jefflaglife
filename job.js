// job.js — parallel boot/repair/drain. env: TO, SEED, TEMPLATE_U, TEMPLATE_P (+ACCS_JSON fallback)
const fs = require('fs');
const API = 'https://lagoslife.eliysites.com/api';
const TO = process.env.TO || '';
const FEE = 50, MIN = 100, CONC = 5;
const SEED = Number(process.env.SEED || 10000000);
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
console.log('SEED:', SEED, 'TO:', TO ? TO.slice(0, 6) + '...' : '(empty)');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};
// base token: prefer top-level base, then game.version, then timestamps
const baseOf = sv => sv.base ?? sv.updatedAt ?? sv.now ?? sv.game?.version ?? Date.now();
const login = async (u, p) => {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return r.ok ? { 'content-type': 'application/json', 'cookie': jar(r) } : null;
};
const S = { booted: 0, repaired: 0, drained: 0, broke: 0, repairFail: 0, fail: 0, total: 0, done: 0 };
const ERR = [];
let debugDone = false;
const note = (m) => { if (ERR.length < 10) ERR.push(m); if (ERR.length <= 8) console.log('ERR:', m); };
let cursor = 0, clean = null;

// PUT with retry off the server's own 409 body. returns { ok, sv } where sv is fresh state.
async function sturdyPut(H, cookie, curSv, mutate, tag) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const g = JSON.parse(JSON.stringify(curSv.game));
    mutate(g);
    const base = baseOf(curSv);
    // bump version on odd attempts — server may require version+1
    if (attempt % 2 === 1) g.version = (curSv.game?.version ?? 0) + 1;
    const r = await fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify({ game: g, base }) });
    if (r.ok) {
      if (attempt > 0) console.log(`${tag} put ok on attempt ${attempt} (bump=${attempt % 2 === 1})`);
      return { ok: true, sv: await fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie } }).then(x => x.json()).catch(() => null) };
    }
    const t = await r.text().catch(() => '');
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!debugDone) {
      debugDone = true;
      console.log('DEBUG get keys:', Object.keys(curSv), '| base:', JSON.stringify(curSv.base), '| updatedAt:', curSv.updatedAt, '| now:', curSv.now, '| game.version:', curSv.game?.version);
      console.log('DEBUG 409 keys:', j ? Object.keys(j) : '(non-json)', '| 409 base:', j ? JSON.stringify(j.base) : '?', '| 409 updatedAt:', j?.updatedAt, '| 409 game.version:', j?.game?.version);
    }
    if (r.status === 409 && j?.game) {
      curSv = { ...j, game: j.game };
      if (curSv.base === undefined && j.base === undefined) curSv.base = base; // keep last base if server sends none
      await sleep(500);
      continue;
    }
    return { ok: false, status: r.status, body: t };
  }
  return { ok: false, status: 409, body: 'retry exhausted' };
}

async function one(a) {
  const H = await login(a.u, a.p);
  if (!H) { S.fail++; return; }
  const cookie = H.cookie;
  const get = async () => fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie } }).then(r => r.json());
  let sv = await get();
  if (!sv?.game && clean) {
    const g = JSON.parse(JSON.stringify(clean));
    g.sim.name = a.u;
    const pr = await sturdyPut(H, cookie, { ...sv, game: g }, () => {}, 'BOOT ' + a.u);
    if (pr.ok) { S.booted++; await sleep(100); sv = pr.sv || await get(); }
    else { S.fail++; note('BOOT ' + a.u + ' ' + pr.status + ' ' + String(pr.body).slice(0, 120)); return; }
  }
  if (!sv?.game) { S.fail++; note('NOGAME ' + a.u); return; }
  if (sv.game?.sim?.name && sv.game.sim.name !== a.u) {
    // save slot holds a stranger's sim — realign before money write
    const fix = await sturdyPut(H, cookie, sv, g => { g.sim.name = a.u; }, 'RENAME ' + a.u);
    if (fix.ok && fix.sv?.game) sv = fix.sv;
    else { S.fail++; note('RENAME ' + a.u + ' sim=' + sv.game.sim.name + ' ' + fix.status + ' ' + String(fix.body).slice(0, 120)); return; }
  }
  if (Number(sv.game.money) < MIN + FEE) {
    const old = Number(sv.game.money ?? 0);
    const pr = await sturdyPut(H, cookie, sv, g => {
      g.money = SEED;
      g.ledger = g.ledger || [];
      g.ledger.push({ id: Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), k: 'admin.seed', a: SEED - old, t: Date.now(), r: 'seed' });
      g.outbox = g.outbox || { notices: [], fx: [] };
    }, 'REPAIR ' + a.u);
    if (!pr.ok) {
      S.repairFail++; S.broke++;
      note('REPAIR ' + a.u + ' money=' + old + ' ' + pr.status + ' ' + String(pr.body).slice(0, 160));
      return;
    }
    S.repaired++; await sleep(100);
    sv = pr.sv || await get();
  }
  let amount = Math.floor(Number(sv.game.money ?? 0)) - FEE;
  if (amount < MIN) { S.broke++; note('STILLBROKE ' + a.u + ' money=' + sv.game.money); return; }
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
    if (S.done % 100 === 0) console.log(`${S.done}/${ledger.length} drained:${S.drained} ₦${S.total.toLocaleString()} repaired:${S.repaired} booted:${S.booted} broke:${S.broke} repairFail:${S.repairFail} fail:${S.fail}`);
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
  console.log(`DONE in ${((Date.now() - start) / 60000).toFixed(1)}min | drained:${S.drained} ₦${S.total.toLocaleString()} repaired:${S.repaired} booted:${S.booted} broke:${S.broke} repairFail:${S.repairFail} fail:${S.fail}`);
  console.log('ERRORS:\n' + ERR.join('\n'));
})();
