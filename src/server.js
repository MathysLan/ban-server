// Serveur arbitre du Jeu du Ban. Node + ws, rien d'autre.
// Machine à états 100% pilotée serveur, avec setTimeout pour dicter le rythme
// ET couper le tour d'un joueur inactif/déconnecté (la partie ne bloque jamais).
//   lobby → preview → player_turn* (chacun son tour) → results → (vidéo suiv.) → … → end
//
// SÉCURITÉ (zéro confiance) : `fatal` (l'instant du mot) reste SECRET. Le serveur
// ne l'envoie JAMAIS aux clients avant `results`. Pendant un tour, il déduit la
// position réelle de la vidéo depuis SON horloge (top départ) : impossible de
// mentir sur son temps d'arrêt (cf. engine.authoritativeTime).
//
// Protocole texte (JSON) :
//   client  → { action:'join', name, code?, avatar? }
//   client  → { action:'start', videos? }                 host, lobby
//   client  → { action:'stop', time }                     JOUEUR ACTIF, phase player_turn
//   serveur → { type:'room', code, phase, you, players[] }
//   serveur → { type:'phase', phase:'preview', videoId, from, until, round, of }
//   serveur → { type:'phase', phase:'player_turn', videoId, from, active, activeName, youActive, round, of, graceMs }
//   serveur → { type:'stopped', id, name, time, points, overshoot }   (après chaque tour)
//   serveur → { type:'phase', phase:'results', videoId, fatal, ranking[], scores[], round, of }
//   serveur → { type:'phase', phase:'end', podium[] }
//   serveur → { type:'error', message }

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./engine-ban');
const VIDEOS = require('./videos');

const CONFIG = {
  MIN_PLAYERS: 2, MAX_PLAYERS: 10,
  DEFAULT_VIDEOS: 3,                                   // nb de vidéos par défaut si non précisé
  PREVIEW_MS: +process.env.PREVIEW_MS || 6000,        // durée d'affichage de la preview avant les tours
  GRACE_S: +process.env.GRACE_S || 1.5,               // filet : X s APRÈS le mot sans clic → le serveur coupe
  NEXT_TURN_MS: +process.env.NEXT_TURN_MS || 2200,    // petit répit entre deux passages
};

const rooms = new Map();
let nextId = 1;

const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ban-server OK\n'); });
const wss = new WebSocketServer({ server });

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join(''); } while (rooms.has(c)); return c; }

function createRoom(code) {
  return {
    code, phase: 'lobby',
    players: new Map(), hostId: null,
    videosToPlay: 0, videoNo: 0, usedVideos: [],
    r: null,          // état du round (engine.createRound) — UNE vidéo
    previewTimer: null,
  };
}

// ---------------------------------------------------------------- transport
wss.on('connection', (ws) => {
  ws.id = 'p' + nextId++;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return sendError(ws, 'JSON invalide'); }
    if (m.action === 'join') onJoin(ws, m);
    else if (m.action === 'start') onStart(ws, m);
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

function onStart(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le MJ peut lancer');
  if (room.phase !== 'lobby') return sendError(ws, 'partie déjà lancée');
  if (room.players.size < CONFIG.MIN_PLAYERS) return sendError(ws, `il faut au moins ${CONFIG.MIN_PLAYERS} joueurs`);
  for (const p of room.players.values()) p.score = 0;
  const asked = Math.trunc(+((msg && msg.videos)) || 0);
  room.videosToPlay = asked > 0 ? Math.min(VIDEOS.length, asked) : Math.min(CONFIG.DEFAULT_VIDEOS, VIDEOS.length);
  room.videoNo = 0; room.usedVideos = [];
  nextVideo(room);
}

// ---------------------------------------------------------------- machine à états
function nextVideo(room) {
  purge(room);
  if (room.videoNo >= room.videosToPlay) return endGame(room);
  room.videoNo++;
  const video = engine.pickVideo(VIDEOS, room.usedVideos);
  room.usedVideos.push(video.id);
  const order = engine.shuffle([...room.players.keys()]);   // ordre de passage tiré au hasard À CHAQUE vidéo
  room.r = engine.createRound(video, order);
  startPreview(room);
}

// Phase preview : découverte du contexte, coupée AVANT le mot. Puis, après un
// délai serveur, on enchaîne sur le premier tour (setTimeout = rythme dicté).
function startPreview(room) {
  const r = room.r;
  room.phase = 'preview';
  broadcastPhase(room, 'preview', {
    videoId: r.video.id,
    from: 0,
    until: engine.previewCut(r.video.fatal),   // ← ne révèle pas `fatal`, juste où couper
  });
  clearTimeout(room.previewTimer);
  room.previewTimer = setTimeout(() => startTurn(room), CONFIG.PREVIEW_MS);
}

// Lance le tour du joueur actif courant (saute les partis). Pose le filet.
function startTurn(room) {
  const r = room.r;
  const isPresent = (id) => room.players.has(id);
  const activeId = r.active === null ? engine.firstActive(r, isPresent) : r.active;
  if (!activeId) return showResults(room);   // plus personne à faire jouer

  r.active = activeId;
  r.goAt = Date.now();
  r.stopReceived = false;
  room.phase = 'player_turn';

  const active = room.players.get(activeId);
  broadcastPhase(room, 'player_turn', {
    videoId: r.video.id,
    from: r.video.startAt,
    active: activeId,
    activeName: active ? active.name : '?',
    // `youActive` est ajouté par joueur dans broadcastPhase
    graceMs: Math.round(((r.video.fatal - r.video.startAt) + CONFIG.GRACE_S) * 1000), // indicatif UI
  });

  // FILET SERVEUR : si aucun stop `GRACE_S` s APRÈS le mot, on force (= dépassement).
  clearTimeout(r.timer);
  const forceMs = ((r.video.fatal - r.video.startAt) + CONFIG.GRACE_S) * 1000;
  r.timer = setTimeout(() => forceStop(room, activeId), forceMs);
}

// Le joueur actif clique STOP.
function onStop(ws, clientTime) {
  const room = rooms.get(ws.room);
  if (!room || !room.r || room.phase !== 'player_turn') return;
  if (ws.id !== room.r.active) return sendError(ws, "ce n'est pas ton tour");
  if (room.r.stopReceived) return;              // déjà traité
  clearTimeout(room.r.timer);
  resolveTurn(room, ws.id, clientTime);
}

// Le filet se déclenche : le joueur n'a pas cliqué (ou s'est déconnecté).
function forceStop(room, playerId) {
  if (!room.r || room.r.active !== playerId || room.r.stopReceived) return;
  resolveTurn(room, playerId, null);            // null → autorité serveur → dépassement
}

// Résout le tour courant, diffuse l'issue, puis enchaîne (joueur suivant ou results).
function resolveTurn(room, playerId, clientTime) {
  const r = room.r;
  r.stopReceived = true;
  const serverTime = r.video.startAt + (Date.now() - r.goAt) / 1000;   // position réelle (horloge serveur)
  const outcome = engine.resolveTurn(r, clientTime, serverTime);       // { time, points, overshoot }
  engine.record(r, playerId, outcome);
  const p = room.players.get(playerId);
  if (p) p.score += outcome.points;
  roomBroadcast(room, { type: 'stopped', id: playerId, name: p ? p.name : '?', time: outcome.time, points: outcome.points, overshoot: outcome.overshoot });

  const isPresent = (id) => room.players.has(id);
  const next = engine.nextActive(r, isPresent);
  if (!next) { setTimeout(() => showResults(room), CONFIG.NEXT_TURN_MS); return; }
  r.active = next;
  setTimeout(() => startTurn(room), CONFIG.NEXT_TURN_MS);              // petit répit puis suivant
}

// Tout le monde a joué cette vidéo : on révèle `fatal` + le classement du round.
function showResults(room) {
  const r = room.r;
  room.phase = 'results';
  const ranking = engine.roundRanking(r).map((e) => {
    const p = room.players.get(e.id);
    return { id: e.id, name: p ? p.name : '?', avatar: p ? p.avatar : '🙂', time: e.time, points: e.points, overshoot: e.overshoot };
  });
  broadcastPhase(room, 'results', { videoId: r.video.id, fatal: r.video.fatal, ranking, scores: scoreboard(room) });
  // enchaînement automatique sur la vidéo suivante (rythme serveur)
  setTimeout(() => nextVideo(room), CONFIG.NEXT_TURN_MS + 2000);
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
  const wasActive = room.r && room.r.active === ws.id && room.phase === 'player_turn';
  room.players.delete(ws.id);
  if (room.players.size === 0) { purge(room); rooms.delete(room.code); return; }
  if (ws.id === room.hostId) room.hostId = room.players.keys().next().value;

  if (room.phase !== 'lobby' && room.players.size < CONFIG.MIN_PLAYERS) {
    purge(room); room.phase = 'lobby';
    roomBroadcast(room, { type: 'error', message: 'plus assez de joueurs - retour au lobby' });
    sendRoomState(room);
    return;
  }
  // si l'actif se casse en plein tour, on ne bloque pas : on résout tout de suite (dépassement)
  if (wasActive && room.r && !room.r.stopReceived) {
    clearTimeout(room.r.timer);
    return resolveTurn(room, ws.id, null);
  }
  sendRoomState(room);
}

// ---------------------------------------------------------------- helpers
function purge(room) {
  clearTimeout(room.previewTimer);
  if (room.r) { clearTimeout(room.r.timer); room.r.results.clear(); }
  room.r = null;
}
function scoreboard(room) { return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score })).sort((a, b) => b.score - a.score); }

function broadcastPhase(room, phase, extra) {
  const base = { type: 'phase', phase, round: room.videoNo, of: room.videosToPlay, ...extra };
  for (const p of room.players.values()) {
    const isHost = p.id === room.hostId;
    const youActive = phase === 'player_turn' && base.active === p.id;
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
server.listen(PORT, () => console.log(`ban-server à l'écoute sur :${PORT}`));
