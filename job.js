// 1. repo file: job.js — MODE=seed|drain, TO=target id, ACCS_JSON=secret
const API = 'https://lagoslife.eliysites.com/api';
const MODE = process.env.MODE || 'drain', TO = process.env.TO || '';
const ledger = JSON.parse(process.env.ACCS_JSON || '[]');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};
(async () => {
  let ok = 0, fail = 0, naira = 0;
  for (const a of ledger) {
    try {
      const lr = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: a.u, password: a.p }) });
      if (!lr.ok) { fail++; continue; }
      const H = { 'content-type': 'application/json', 'cookie': jar(lr) };
      const sv = await fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie: H.cookie } }).then(r => r.json());
      const g = sv.game || (sv.state && sv.state.game);
      if (!g) { fail++; continue; }
      if (MODE === 'seed') {
        g.money = 1000000; g.outbox = { notices: [], fx: [] };
        (await fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify({ game: g, base: sv.base || sv.updatedAt }) })).ok ? ok++ : fail++;
      } else {
        let amount = Math.floor(Number(g.money ?? 0)) - 50;
        if (amount < 100) continue;
        const sr = await fetch(`${API}/send`, { method: 'POST', headers: H, body: JSON.stringify({ to: TO, amount }) });
        if (sr.ok) { ok++; naira += amount; } else fail++;
      }
    } catch (e) { fail++; }
    if ((ok + fail) % 50 === 0) console.log(`${ok + fail}/${ledger.length} ok:${ok} fail:${fail} ₦${naira.toLocaleString()}`);
    await sleep(400);
  }
  console.log(`DONE ok:${ok} fail:${fail} ₦${naira.toLocaleString()}`);
})();
