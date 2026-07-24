// Test du comportement FRANC quand le catalogue est injoignable + de l'endpoint
// de diagnostic. On pointe CATALOGUE_URL sur un port mort : le fetch échoue,
// le repli est vide → l'endpoint dit ok:false, et lancer une partie renvoie une
// erreur claire (plutôt que de jouer une vraie vidéo avec un mauvais fatal).
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const BANPORT = 8160, DEADPORT = 8161; // rien n'écoute sur DEADPORT
const URL = 'ws://localhost:' + BANPORT;
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

(async () => {
  const srv = spawn('node', [path.join(__dirname, 'src/server.js')], {
    env: { ...process.env, PORT: String(BANPORT), CATALOGUE_URL: `http://localhost:${DEADPORT}/nope.json` },
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  await wait(1200); // laisse le fetch de boot échouer

  // endpoint de diagnostic
  const diag = await getJSON(`http://localhost:${BANPORT}/`);
  check('endpoint : ok=false quand catalogue vide', diag.ok === false);
  check('endpoint : 0 vidéo', diag.catalogueCount === 0);
  check('endpoint : source = repli', /repli/.test(diag.catalogueSource));
  check('endpoint : lastError renseigné', typeof diag.lastError === 'string' && diag.lastError.length > 0);

  // lancer une partie → erreur franche
  function client() {
    const ws = new WebSocket(URL); const q = [], w = [];
    ws.on('message', (raw) => { const m = JSON.parse(raw); const r = w.shift(); r ? r(m) : q.push(m); });
    const next = () => new Promise((res) => { q.length ? res(q.shift()) : w.push(res); });
    return { ws, send: (o) => ws.send(JSON.stringify(o)), open: () => new Promise((r) => ws.on('open', r)),
      async until(p) { for (;;) { const m = await next(); if (p(m)) return m; } } };
  }
  const a = client(), b = client(); await a.open(); await b.open();
  a.send({ action: 'join', name: 'A' }); const ra = await a.until((m) => m.type === 'room');
  b.send({ action: 'join', name: 'B', code: ra.code }); await b.until((m) => m.type === 'room');
  a.send({ action: 'start', videos: 1 });
  const e = await a.until((m) => m.type === 'error');
  check('start refusé avec un message clair (aucune vidéo)', /aucune vidéo/i.test(e.message));

  a.ws.close(); b.ws.close(); srv.kill('SIGKILL');
  console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
  process.exit(f === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
