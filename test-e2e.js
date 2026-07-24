// e2e du Ban : deux clients ws jouent une vidéo en entier contre un vrai serveur.
// On vérifie la preview (fatal caché), la boucle chacun son tour, le scoring
// (clic honnête vs. dépassement au filet serveur), et la révélation en results.
// Lancer le serveur AVANT avec des délais courts :
//   PORT=8125 PREVIEW_MS=200 NEXT_TURN_MS=150 GRACE_S=0.3 node src/server.js
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 8125);
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };

function client() {
  const ws = new WebSocket(URL); const q = [], w = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); const r = w.shift(); r ? r(m) : q.push(m); });
  const next = () => new Promise((res) => { q.length ? res(q.shift()) : w.push(res); });
  return {
    ws, send: (o) => ws.send(JSON.stringify(o)), open: () => new Promise((r) => ws.on('open', r)),
    async until(pred) { for (;;) { const m = await next(); if (pred(m)) return m; } },
    async phase(p) { return this.until((m) => m.type === 'phase' && m.phase === p); },
  };
}

(async () => {
  const a = client(), b = client();
  await a.open(); await b.open();
  a.send({ action: 'join', name: 'Alice', avatar: '🦊' });
  const ra = await a.until((m) => m.type === 'room'); const idA = ra.you;
  b.send({ action: 'join', name: 'Bob', code: ra.code, avatar: '🐼' });
  const idB = (await b.until((m) => m.type === 'room')).you;

  a.send({ action: 'start', videos: 1 });

  // --- preview : fatal caché, on ne reçoit que `until` ---
  const pa = await a.phase('preview');
  check('preview : videoId présent', typeof pa.videoId === 'string');
  check('preview : `fatal` JAMAIS envoyé', pa.fatal === undefined);
  check('preview : `until` = le mot (un nombre)', typeof pa.until === 'number');

  // --- tour 1 : le joueur actif ---
  const t1a = await a.phase('player_turn');
  const t1b = await b.phase('player_turn');
  check('player_turn : un seul actif', (t1a.youActive ? 1 : 0) + (t1b.youActive ? 1 : 0) === 1);
  check('player_turn : `fatal` toujours caché', t1a.fatal === undefined && t1b.fatal === undefined);
  const active1 = t1a.youActive ? a : b;
  const passive1 = t1a.youActive ? b : a;
  const activeId1 = t1a.youActive ? idA : idB;

  // le non-actif tente de stopper → refusé
  passive1.send({ action: 'stop', time: 5 });
  const err = await passive1.until((m) => m.type === 'error');
  check('stop refusé à un non-actif', /ton tour/.test(err.message));

  // l'actif clique honnêtement AVANT le mot (fatal vid_01=6.4 ; on stoppe ~ tôt)
  // délais serveur très courts → le temps réel écoulé est petit : on annonce un
  // temps cohérent avec l'horloge serveur (sinon l'anti-triche recale).
  active1.send({ action: 'stop', time: 0.05 });
  const st1 = await a.until((m) => m.type === 'stopped');
  check('stopped : diffusé à tous après le tour', st1.id === activeId1);
  check('stopped : pas de dépassement (clic avant le mot)', st1.overshoot === false);
  check('stopped : `fatal` toujours pas révélé', st1.fatal === undefined);

  // --- tour 2 : l'autre joueur NE clique PAS → le filet serveur force (dépassement) ---
  const st2 = await a.until((m) => m.type === 'stopped' && m.id !== activeId1);
  check('tour 2 résolu sans clic (filet serveur)', !!st2);
  check('joueur inactif → dépassement + malus', st2.overshoot === true && st2.points < 0);

  // --- results : fatal révélé + classement ---
  const res = await a.phase('results');
  check('results : `fatal` enfin révélé', typeof res.fatal === 'number');
  check('results : classement complet (2 joueurs)', Array.isArray(res.ranking) && res.ranking.length === 2);
  check('results : le prudent devant le dépassé', res.ranking[0].overshoot === false);
  check('results : scoreboard présent', Array.isArray(res.scores) && res.scores.length === 2);

  // --- fin de partie (1 seule vidéo) ---
  const end = await a.phase('end');
  check('end : podium renvoyé', Array.isArray(end.podium) && end.podium.length === 2);

  a.ws.close(); b.ws.close();
  console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
  process.exit(f === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
