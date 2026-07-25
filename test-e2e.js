// e2e ws du Ban (piloté MJ). Deux clients ws jouent une vidéo :
// preview →(MJ next)→ tour1 →(MJ play)→ stop actif →(MJ next)→ tour2 →(MJ play)→
// filet serveur (dépassement) →(MJ next)→ results →(MJ next)→ end.
// Lancer le serveur AVANT, filet court :
//   PORT=8125 TURN_SAFETY_MS=600 VIDEOS_JSON='[{"id":"v","fatal":1.0,"startAt":0}]' node src/server.js
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 8125);
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };

function client() {
  const ws = new WebSocket(URL); const q = [], w = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); const r = w.shift(); r ? r(m) : q.push(m); });
  const next = () => new Promise((res) => { q.length ? res(q.shift()) : w.push(res); });
  return {
    ws, send: (o) => ws.send(JSON.stringify(o)), open: () => new Promise((r) => ws.on('open', r)),
    async until(p) { for (;;) { const m = await next(); if (p(m)) return m; } },
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

  // --- preview ---
  const pa = await a.phase('preview');
  check('preview : `fatal` jamais envoyé', pa.fatal === undefined);
  check('preview : until = un nombre', typeof pa.until === 'number');
  check('preview : ordre de passage (2 joueurs)', Array.isArray(pa.order) && pa.order.length === 2);
  check('preview : personne n\'a encore joué', pa.order.every((o) => !o.done));

  // un non-MJ ne peut pas avancer
  b.send({ action: 'next' });
  check('next refusé au non-MJ', (await b.until((m) => m.type === 'error')).message.includes('MJ'));

  // découverte : seul le MJ la lance
  b.send({ action: 'play' });
  check('découverte : play refusé au non-MJ', (await b.until((m) => m.type === 'error')).message.includes('MJ'));
  a.send({ action: 'play' });
  await a.until((m) => m.type === 'play');
  check('découverte : le MJ la lance', true);

  // --- MJ lance les tours ---
  a.send({ action: 'next' });
  const t1a = await a.phase('turn'); await b.phase('turn');
  check('turn : un seul actif', (t1a.youActive ? 1 : 0) + ((t1a.active === idB) ? 1 : 0) === 1 || t1a.active === idA || t1a.active === idB);
  check('turn : `fatal` toujours caché', t1a.fatal === undefined);
  const active1 = t1a.active === idA ? a : b;
  const passive1 = t1a.active === idA ? b : a;

  // stop AVANT le lancement → refusé
  active1.send({ action: 'stop', time: 0.1 });
  check('stop refusé avant le play', (await active1.until((m) => m.type === 'error')).message.includes('lancée'));

  // un joueur ni actif ni MJ ne peut pas lancer la vidéo (b n'est jamais MJ ici)
  if (passive1 === b) {
    b.send({ action: 'play' });
    check('play refusé à un joueur ni actif ni MJ', (await b.until((m) => m.type === 'error')).message.includes('actif'));
  }

  // LE JOUEUR ACTIF lance lui-même sa vidéo
  active1.send({ action: 'play' });
  await a.until((m) => m.type === 'play');
  check('le joueur actif lance sa propre vidéo', true);

  // non-actif tente de stopper → refusé
  passive1.send({ action: 'stop', time: 0.1 });
  check('stop refusé à un non-actif', (await passive1.until((m) => m.type === 'error')).message.includes('tour'));

  // l'actif stoppe honnêtement, tôt (avant le mot à 1.0)
  active1.send({ action: 'stop', time: 0.05 });
  const st1 = await a.until((m) => m.type === 'stopped');
  check('stopped tour 1 : pas de dépassement', st1.overshoot === false);
  check('stopped : `fatal` toujours caché', st1.fatal === undefined);

  // --- MJ passe au tour suivant ---
  a.send({ action: 'next' });
  const t2 = await a.phase('turn');
  check('tour 2 : ordre montre le 1er joueur « done »', t2.order.some((o) => o.done));

  // MJ lance ; l'actif 2 (client ws, pas de vidéo) ne stoppe pas → FILET serveur
  a.send({ action: 'play' });
  await a.until((m) => m.type === 'play');
  const st2 = await a.until((m) => m.type === 'stopped');
  check('tour 2 : filet serveur → dépassement + malus', st2.overshoot === true && st2.points < 0);

  // --- MJ → résultats ---
  a.send({ action: 'next' });
  const res = await a.phase('results');
  check('results : `fatal` enfin révélé', typeof res.fatal === 'number');
  check('results : classement 2 joueurs', res.ranking.length === 2);
  check('results : écart (delta) fourni', res.ranking.every((r) => 'delta' in r));
  check('results : le prudent devant le dépassé', res.ranking[0].overshoot === false);
  check('results : scoreboard présent', Array.isArray(res.scores) && res.scores.length === 2);

  // --- MJ → fin ---
  a.send({ action: 'next' });
  const end = await a.phase('end');
  check('end : podium (2 joueurs)', Array.isArray(end.podium) && end.podium.length === 2);

  a.ws.close(); b.ws.close();
  console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
  process.exit(f === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
