// Test du chargement du catalogue À DISTANCE : on sert un videos.json local,
// on lance le serveur avec CATALOGUE_URL dessus, et on vérifie qu'une partie
// utilise bien CE catalogue (l'id de la vidéo vient du JSON distant).
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const CATPORT = 8155, BANPORT = 8156;
const URL = 'ws://localhost:' + BANPORT;
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(URL); const q = [], w = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); const r = w.shift(); r ? r(m) : q.push(m); });
  const next = () => new Promise((res) => { q.length ? res(q.shift()) : w.push(res); });
  return { ws, send: (o) => ws.send(JSON.stringify(o)), open: () => new Promise((r) => ws.on('open', r)),
    async until(p) { for (;;) { const m = await next(); if (p(m)) return m; } } };
}

(async () => {
  // 1) un "GitHub Pages" local qui sert le catalogue
  let served = 0;
  const cat = http.createServer((_req, res) => {
    served++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'cat_distant', fatal: 5.0, startAt: 3.0 }]));
  });
  await new Promise((r) => cat.listen(CATPORT, r));

  // 2) le serveur de jeu pointé sur ce catalogue distant (pas de VIDEOS_JSON !)
  const srv = spawn('node', [path.join(__dirname, 'src/server.js')], {
    env: { ...process.env, PORT: String(BANPORT), PREVIEW_HOLD_MS: '100', NEXT_TURN_MS: '150', TURN_SAFETY_MS: '600',
      CATALOGUE_URL: `http://localhost:${CATPORT}` },
  });
  srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  await wait(900);
  check('catalogue fetché au boot (préchauffe)', served >= 1);

  // 3) une partie : la vidéo doit venir du catalogue distant
  const a = client(), b = client();
  await a.open(); await b.open();
  a.send({ action: 'join', name: 'A' }); const ra = await a.until((m) => m.type === 'room');
  b.send({ action: 'join', name: 'B', code: ra.code }); await b.until((m) => m.type === 'room');
  a.send({ action: 'start', videos: 1 });
  const pv = await a.until((m) => m.type === 'phase' && m.phase === 'preview');
  check('la partie utilise le catalogue distant (id)', pv.videoId === 'cat_distant');
  check('preview : démarre au startAt du JSON (from === 3.0)', pv.from === 3.0);
  check('preview : fatal toujours caché', pv.fatal === undefined);
  const res = await a.until((m) => m.type === 'phase' && m.phase === 'results');
  check('results : fatal du catalogue distant révélé (5.0)', res.fatal === 5.0);

  a.ws.close(); b.ws.close();
  cat.close(); srv.kill('SIGKILL');
  console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
  process.exit(f === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
