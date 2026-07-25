// Serveur arbitre du Jeu du Ban. Node + ws, rien d'autre.
// Machine à états PILOTÉE PAR LE MJ (host) : il lance la vidéo quand il veut,
// passe/avance quand il veut. Aucun timer de rythme ; juste un FILET anti-blocage
// une fois la vidéo lancée (si le client actif ne répond jamais).
//   lobby → preview → turn* (chacun son tour) → results → (vidéo suiv.) → … → end
//
// SÉCURITÉ (zéro confiance) : `fatal` (l'instant du mot) n'est envoyé qu'en
// `results`. Pendant un tour, le serveur déduit la position réelle depuis SON
// horloge (top départ = quand le MJ lance) : impossible de mentir sur son temps.
//
// Protocole (JSON) :
//   client → { action:'join', name, code?, avatar? }
//   client → { action:'start', videos? }        host, lobby
//   client → { action:'next' }                  host : avance (preview→tours, tour suivant, vidéo suivante)
//   client → { action:'play' }                  host : lance la vidéo du tour courant
//   client → { action:'skip' }                  host : passe le joueur actif
//   client → { action:'stop', time }            JOUEUR ACTIF, une fois la vidéo lancée
//   serveur → { type:'room', code, phase, you, players[] }
//   serveur → { type:'phase', phase:'preview', videoId, from, until, order[], round, of, isHost }
//   serveur → { type:'phase', phase:'turn', videoId, from, active, activeName, youActive, order[], round, of, isHost }
//   serveur → { type:'play' }                                              (le MJ a lancé la vidéo)
//   serveur → { type:'stopped', id, name, time, points, overshoot, skipped }
//   serveur → { type:'phase', phase:'results', videoId, fatal, ranking[], scores[], round, of, isHost }
//   serveur → { type:'phase', phase:'end', podium[] }
//   serveur → { type:'error', message }

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./engine-ban');

// --- catalogue de vidéos ---------------------------------------------------
// Priorité : VIDEOS_JSON (env inline — staging/tests) > CATALOGUE_URL (le
// videos.json du portfolio, PUBLIC, refetché à chaque partie) > ./videos.js (vide).
const CATALOGUE_URL = process.env.CATALOGUE_URL || 'https://mathyslan.github.io/games/ban/videos.json';
const CATALOGUE_TTL = 10000; // ms : on ne refetch pas plus d'une fois par 10 s
let catalogue = sanitizeCatalogue(require('./videos'));
let catalogueAt = 0;
let catalogueSource = 'repli (videos.js)';
let catalogueError = null;

function sanitizeCatalogue(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((v) => ({ id: String((v && v.id) || '').trim(), fatal: Number(v && v.fatal), startAt: Number(v && v.startAt) || 0 }))
    .filter((v) => v.id && Number.isFinite(v.fatal) && v.fatal > 0);
}

async function refreshCatalogue() {
  if (process.env.VIDEOS_JSON) {
    catalogue = sanitizeCatalogue(JSON.parse(process.env.VIDEOS_JSON));
    catalogueSource = 'VIDEOS_JSON (env)'; catalogueError = null; return;
  }
  if (Date.now() - catalogueAt < CATALOGUE_TTL) return;
  if (typeof fetch !== 'function') { catalogueError = 'fetch indisponible (Node < 18 ?)'; console.error('catalogue:', catalogueError); return; }
  try {
    const res = await fetch(CATALOGUE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const clean = sanitizeCatalogue(await res.json());
    if (!clean.length) throw new Error('JSON vide ou invalide (id + fatal>0 requis)');
    catalogue = clean; catalogueAt = Date.now();
    catalogueSource = CATALOGUE_URL; catalogueError = null;
    console.log(`catalogue: ${clean.length} vidéo(s) depuis ${CATALOGUE_URL}`);
  } catch (e) {
    catalogueError = e.message;
    console.error(`catalogue: fetch KO (${CATALOGUE_URL}) — ${e.message} — catalogue conservé (${catalogue.length})`);
  }
}

const CONFIG = {
  MIN_PLAYERS: 2, MAX_PLAYERS: 10,
  DEFAULT_VIDEOS: 3,
  TURN_SAFETY_MS: +process.env.TURN_SAFETY_MS || 60000,   // filet APRÈS lancement : coupe si le client reste muet
};

const rooms = new Map();
let nextId = 1;

// Endpoint de diagnostic : catalogue réellement chargé (source + fatal).
const server = http.createServer((_req, res) => {
  const body = {
    ok: catalogue.length > 0, catalogueSource, catalogueUrl: CATALOGUE_URL,
    catalogueCount: catalogue.length, lastError: catalogueError, videos: catalogue,
    hint: catalogue.length ? 'ok' : 'catalogue vide : videos.json injoignable/invalide ?',
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
});
const wss = new WebSocketServer({ server });

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join(''); } while (rooms.has(c)); return c; }

function createRoom(code) {
  return { code, phase: 'lobby', players: new Map(), hostId: null, videosToPlay: 0, videoNo: 0, usedVideos: [], r: null };
}

// ---------------------------------------------------------------- transport
wss.on('connection', (ws) => {
  ws.id = 'p' + nextId++;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return sendError(ws, 'JSON invalide'); }
    if (m.action === 'join') onJoin(ws, m);
    else if (m.action === 'start') onStart(ws, m);
    else if (m.action === 'next') onNext(ws);
    else if (m.action === 'play') onPlay(ws);
    else if (m.action === 'skip') onSkip(ws);
    else if (m.action === 'stop') onStop(ws, m.time);
    else sendError(ws, 'action inconnue');
  });
  ws.on('close', () => onLeave(ws));
});

// ---------------------------------------------------------------- lobby
function onJoin(ws, { name, code, avatar }) {
  if (ws.room) return sendError(ws, 'déjà dans une room');
  const cleanName = String(name || '').trim().slice(0, 16);
  if (!cleanName) return sendError(ws, 'il faut un pseudo');
  let room;
  if (code === undefined) { room = createRoom(newCode()); rooms.set(room.code, room); room.hostId = ws.id; }
  else {
    room = rooms.get(String(code).trim().toUpperCase());
    if (!room) return sendError(ws, 'room introuvable');
    if (room.phase !== 'lobby') return sendError(ws, 'partie en cours');
    if (room.players.size >= CONFIG.MAX_PLAYERS) return sendError(ws, 'room pleine');
  }
  ws.room = room.code;
  room.players.set(ws.id, { id: ws.id, name: cleanName, avatar: String(avatar || '🙂').slice(0, 4), ws, score: 0 });
  sendRoomState(room);
}

async function onStart(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ peut lancer');
  if (room.phase !== 'lobby') return sendError(ws, 'partie déjà lancée');
  if (room.players.size < CONFIG.MIN_PLAYERS) return sendError(ws, `il faut au moins ${CONFIG.MIN_PLAYERS} joueurs`);
  for (const p of room.players.values()) p.score = 0;
  room.phase = 'starting';
  await refreshCatalogue();
  if (!catalogue.length) { room.phase = 'lobby'; return sendError(ws, 'aucune vidéo dans le catalogue'); }
  const asked = Math.trunc(+((msg && msg.videos)) || 0);
  room.videosToPlay = asked > 0 ? Math.min(catalogue.length, asked) : Math.min(CONFIG.DEFAULT_VIDEOS, catalogue.length);
  room.videoNo = 0; room.usedVideos = [];
  nextVideo(room);
}

// ---------------------------------------------------------------- MJ pilote
function onNext(ws) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ pilote');
  if (room.phase === 'preview') return startFirstTurn(room);
  if (room.phase === 'turn') {
    if (!room.r.stopReceived) return sendError(ws, 'lance la vidéo (ou passe) avant');
    return advanceAfterTurn(room);
  }
  if (room.phase === 'results') return nextVideo(room);
  return sendError(ws, 'rien à faire ici');
}

// Lancement de la vidéo (top départ commun à tous).
//  - phase preview : le MJ lance la découverte
//  - phase turn    : LE JOUEUR ACTIF lance sa vidéo (le MJ peut aussi, filet)
function onPlay(ws) {
  const room = rooms.get(ws.room);
  if (!room || !room.r) return;
  const r = room.r;

  if (room.phase === 'preview') {
    if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ lance la découverte');
    if (r.previewPlaying) return;
    r.previewPlaying = true;
    roomBroadcast(room, { type: 'play' });
    console.log('[preview] MJ lance la découverte');
    return;
  }

  if (room.phase !== 'turn') return;
  if (ws.id !== r.active && ws.id !== room.hostId) return sendError(ws, 'seul le joueur actif lance sa vidéo');
  if (r.playing || r.stopReceived) return;
  r.playing = true; r.goAt = Date.now();
  roomBroadcast(room, { type: 'play' });
  clearTimeout(r.timer);
  r.timer = setTimeout(() => forceStop(room, r.active), CONFIG.TURN_SAFETY_MS);
  console.log(`[turn] vidéo lancée par ${ws.id === r.active ? 'le joueur actif' : 'le MJ'} (actif=${r.active})`);
}

// Le MJ passe le joueur actif (0 point, pas de malus).
function onSkip(ws) {
  const room = rooms.get(ws.room);
  if (!room || room.phase !== 'turn' || !room.r) return;
  if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ passe');
  const r = room.r;
  if (r.stopReceived) return;
  clearTimeout(r.timer);
  r.stopReceived = true;
  const outcome = { time: null, points: 0, overshoot: false, skipped: true };
  engine.record(r, r.active, outcome);
  const p = room.players.get(r.active);
  roomBroadcast(room, { type: 'stopped', id: r.active, name: p ? p.name : '?', ...outcome });
  console.log(`[turn] MJ passe ${r.active}`);
}

// Le joueur actif clique STOP (ou son front l'envoie en fin de vidéo).
function onStop(ws, clientTime) {
  const room = rooms.get(ws.room);
  if (!room || room.phase !== 'turn' || !room.r) return;
  if (ws.id !== room.r.active) return sendError(ws, "ce n'est pas ton tour");
  if (!room.r.playing) return sendError(ws, "la vidéo n'a pas encore été lancée");
  if (room.r.stopReceived) return;
  clearTimeout(room.r.timer);
  resolveTurn(room, ws.id, clientTime);
}

// ---------------------------------------------------------------- machine à états
function nextVideo(room) {
  purge(room);
  if (room.videoNo >= room.videosToPlay) return endGame(room);
  room.videoNo++;
  const video = engine.pickVideo(catalogue, room.usedVideos);
  room.usedVideos.push(video.id);
  const order = engine.shuffle([...room.players.keys()]);   // ordre de passage tiré au hasard À CHAQUE vidéo
  room.r = engine.createRound(video, order);
  startPreview(room);
}

// Découverte : de startAt JUSQU'AU mot. Le MJ enchaîne avec `next`.
function startPreview(room) {
  const r = room.r;
  room.phase = 'preview';
  const until = engine.previewCut(r.video.fatal);
  broadcastPhase(room, 'preview', { videoId: r.video.id, from: r.video.startAt, until, order: standings(room) });
  console.log(`[preview] ${r.video.id} : ${r.video.startAt}s → ${until}s`);
}

function startFirstTurn(room) {
  const first = engine.firstActive(room.r, (id) => room.players.has(id));
  if (!first) return showResults(room);
  room.r.active = first;
  emitTurn(room);
}

function advanceAfterTurn(room) {
  const next = engine.nextActive(room.r, (id) => room.players.has(id));
  if (!next) return showResults(room);
  room.r.active = next;
  emitTurn(room);
}

// Annonce le tour courant (vidéo À L'ARRÊT : c'est le MJ qui la lancera).
function emitTurn(room) {
  const r = room.r;
  r.playing = false; r.stopReceived = false; r.goAt = 0;
  clearTimeout(r.timer);
  room.phase = 'turn';
  const active = room.players.get(r.active);
  broadcastPhase(room, 'turn', {
    videoId: r.video.id, from: r.video.startAt,
    active: r.active, activeName: active ? active.name : '?',
    order: standings(room),
  });
  console.log(`[turn] actif=${r.active} (${active ? active.name : '?'})`);
}

// Filet anti-blocage : le client actif n'a jamais répondu → dépassement forcé.
function forceStop(room, playerId) {
  const r = room.r;
  if (!r || r.active !== playerId || r.stopReceived) return;
  r.stopReceived = true;
  const serverTime = r.video.startAt + (Date.now() - r.goAt) / 1000;
  const outcome = { time: +serverTime.toFixed(3), points: engine.SCORING.MALUS, overshoot: true };
  engine.record(r, playerId, outcome);
  const p = room.players.get(playerId);
  if (p) p.score += outcome.points;
  roomBroadcast(room, { type: 'stopped', id: playerId, name: p ? p.name : '?', ...outcome });
  console.log(`[turn] FILET → ${playerId} dépassement forcé (${outcome.time}s)`);
}

// Résout un stop CLIENT (clic ou fin de vidéo). PAS d'avance auto : le MJ enchaîne.
function resolveTurn(room, playerId, clientTime) {
  const r = room.r;
  r.stopReceived = true;
  const serverTime = r.video.startAt + (Date.now() - r.goAt) / 1000;
  const outcome = engine.resolveTurn(r, clientTime, serverTime);
  engine.record(r, playerId, outcome);
  const p = room.players.get(playerId);
  if (p) p.score += outcome.points;
  roomBroadcast(room, { type: 'stopped', id: playerId, name: p ? p.name : '?', ...outcome });
  console.log(`[turn] ${playerId} stop@${outcome.time}s pts=${outcome.points} dépassé=${outcome.overshoot}`);
}

// Résultats de la vidéo : le `fatal` est révélé + le classement (avec écarts).
function showResults(room) {
  const r = room.r;
  room.phase = 'results';
  clearTimeout(r.timer);
  const fatal = r.video.fatal;
  const ranking = engine.roundRanking(r).map((e) => {
    const p = room.players.get(e.id);
    return {
      id: e.id, name: p ? p.name : '?', avatar: p ? p.avatar : '🙂',
      time: e.time, points: e.points, overshoot: e.overshoot, skipped: !!e.skipped,
      delta: (e.time == null ? null : +(e.time - fatal).toFixed(3)),   // <0 = avant le mot (bien), >0 = dépassé
    };
  });
  // classement : les plus proches d'abord ; dépassés/passés en bas.
  ranking.sort((a, b) => rankKey(a, fatal) - rankKey(b, fatal));
  broadcastPhase(room, 'results', { videoId: r.video.id, fatal, ranking, scores: scoreboard(room) });
  console.log(`[results] ${r.video.id} fatal=${fatal}s`);
}
function rankKey(e, fatal) {
  if (e.skipped) return 1e9;
  if (e.overshoot || e.time == null) return 1e8;
  return fatal - e.time;   // écart : plus petit = meilleur
}

function endGame(room) {
  purge(room);
  room.phase = 'lobby';
  roomBroadcast(room, { type: 'phase', phase: 'end', podium: scoreboard(room) });
  sendRoomState(room);
}

// ---------------------------------------------------------------- départs
function onLeave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  const wasActive = room.r && room.r.active === ws.id && room.phase === 'turn';
  const wasPlaying = wasActive && room.r.playing && !room.r.stopReceived;
  room.players.delete(ws.id);
  if (room.players.size === 0) { purge(room); rooms.delete(room.code); return; }
  if (ws.id === room.hostId) room.hostId = room.players.keys().next().value;

  if (room.phase !== 'lobby' && room.players.size < CONFIG.MIN_PLAYERS) {
    purge(room); room.phase = 'lobby';
    roomBroadcast(room, { type: 'error', message: 'plus assez de joueurs - retour au lobby' });
    sendRoomState(room);
    return;
  }
  // l'actif se casse pendant que la vidéo tourne → dépassement forcé (le MJ enchaînera)
  if (wasPlaying) { clearTimeout(room.r.timer); forceStop(room, ws.id); }
  sendRoomState(room);
}

// ---------------------------------------------------------------- helpers
function purge(room) { if (room.r) { clearTimeout(room.r.timer); room.r.results.clear(); } room.r = null; }
function scoreboard(room) { return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score })).sort((a, b) => b.score - a.score); }

// Ordre de passage de la vidéo courante + le temps de chacun (rempli au fur et à mesure).
function standings(room) {
  const r = room.r;
  return r.order.filter((id) => room.players.has(id)).map((id, i) => {
    const p = room.players.get(id);
    const res = r.results.get(id);
    return {
      id, n: i + 1, name: p.name, avatar: p.avatar,
      time: res ? res.time : null, overshoot: res ? !!res.overshoot : false,
      skipped: res ? !!res.skipped : false, done: !!res, active: id === r.active,
    };
  });
}

function broadcastPhase(room, phase, extra) {
  const base = { type: 'phase', phase, round: room.videoNo, of: room.videosToPlay, ...extra };
  for (const p of room.players.values()) {
    const isHost = p.id === room.hostId;
    const youActive = phase === 'turn' && base.active === p.id;
    sendJson(p.ws, { ...base, isHost, youActive });
  }
}

function sendRoomState(room) {
  const players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, host: p.id === room.hostId }));
  for (const p of room.players.values()) sendJson(p.ws, { type: 'room', code: room.code, phase: room.phase, you: p.id, players });
}
function roomBroadcast(room, obj) { for (const p of room.players.values()) sendJson(p.ws, obj); }
function sendJson(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
const sendError = (ws, message) => sendJson(ws, { type: 'error', message });

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`ban-server à l'écoute sur :${PORT}`);
  refreshCatalogue().then(() => console.log(`catalogue : ${catalogue.length} vidéo(s)`));
});
