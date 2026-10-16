// probe2.js — diagnose save PUT 409s. env: U, P, SEED (default 10000000)
// run: U=ibrahimnwankwo P=<pass> node probe2.js
const API = 'https://lagoslife.eliysites.com/api';
const SITE = 'https://lagoslife.eliysites.com';
const SEED = Number(process.env.SEED || 10000000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jar = res => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0]).join('; ');
};
const show409 = async (label, r) => {
  const t = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(t); } catch {}
  console.log(`--- [${label}] ->`, r.status);
  if (j) {
    console.log('    error:', j.error, '| code:', j.code, '| refused:', JSON.stringify(j.refused)?.slice(0, 500));
    console.log('    409 updatedAt:', j.updatedAt, '| game.version:', j.game?.version, '| money:', j.game?.money, '| sim:', j.game?.sim?.name);
  } else console.log('    (non-json)', t.slice(0, 300));
  return j;
};
(async () => {
  const lr = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.U, password: process.env.P }) });
  console.log('login:', lr.status);
  if (!lr.ok) { console.log((await lr.text()).slice(0, 200)); return; }
  const cookie = jar(lr);
  const H = { 'content-type': 'application/json', cookie };
  const get = async () => fetch(`${API}/save?t=${Date.now()}`, { headers: { cookie } }).then(r => r.json());
  const sv = await get();
  const g0 = sv.game;
  console.log('GET updatedAt:', sv.updatedAt, '| now:', sv.now, '| base:', JSON.stringify(sv.base));
  console.log('GET game.version:', g0?.version, '| phase:', g0?.phase, '| money:', g0?.money, '| sim:', g0?.sim?.name, '| game keys:', g0 ? Object.keys(g0).join(',') : '(none)');

  // 1) harmless write, 5 base variants — finds the token the server actually wants
  const clone = () => { const g = JSON.parse(JSON.stringify(sv.game)); g.visited = g.visited || []; if (!g.visited.includes('__probe2')) g.visited.push('__probe2'); return g; };
  let winner = null;
  for (const [name, base] of [['updatedAt', sv.updatedAt], ['now', sv.now], ['game.version', sv.game?.version], ['null', null], ['omitted', undefined]]) {
    const body = { game: clone() };
    if (base !== undefined) body.base = base;
    const r = await fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
    if (r.ok) { console.log(`--- [harmless base=${name}] -> 200 WINNER`); winner = name; break; }
    await show409(`harmless base=${name} (${JSON.stringify(base)})`, r);
    await sleep(600);
  }
  if (!winner) console.log('no harmless base won — server may also be validating content, see refused above');

  // 2) money seed with winner (or updatedAt fallback) — tests if the delta itself is refused
  await sleep(600);
  const g2 = (await get()).game || clone();
  g2.money = SEED;
  const seedBody = { game: g2, base: winner === 'now' ? (await get()).now : (await get()).updatedAt };
  const r2 = await fetch(`${API}/save`, { method: 'PUT', headers: H, body: JSON.stringify(seedBody) });
  if (r2.ok) console.log(`--- [seed ${SEED}] -> 200 money write accepted`);
  else await show409(`seed ${SEED}`, r2);

  // 3) how does the real client call PUT? grep bundled js for the save call
  try {
    const html = await fetch(SITE + '/').then(r => r.text());
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).slice(0, 12);
    console.log('scripts:', srcs.join(' | ') || '(none found)');
    for (const s of srcs) {
      const url = s.startsWith('http') ? s : SITE + (s.startsWith('/') ? s : '/' + s);
      const js = await fetch(url).then(r => r.text()).catch(() => '');
      const i = js.indexOf('api/save');
      if (i >= 0) console.log(`save call in ${s}: ...${js.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, ' ')}...`);
      await sleep(300);
    }
  } catch (e) { console.log('client-js grep failed:', e.message); }
})();
