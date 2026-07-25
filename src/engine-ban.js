// Moteur du Jeu du Ban. Fonctions PURES : un état/des nombres entrent, un
// résultat sort. Aucun socket, aucun setTimeout, aucune horloge lue ici — c'est
// le seul endroit où vivent les RÈGLES, et il reste 100% testable.
//
// Principe : une vidéo cache un mot interdit à `fatal` (secondes). Le joueur
// actif lance la vidéo et clique STOP le plus tard possible SANS atteindre le
// mot. Plus il frôle `fatal` sans le dépasser, plus il marque. S'il dépasse
// (le mot sort), c'est le malus.
//
// IMPORTANT — le serveur (server.js) garde `fatal` SECRET : il ne l'envoie
// jamais aux clients avant la phase `results`. Le moteur ne fait que calculer.

// --- réglages (exportés → tunables + testables) ----------------------------
// Barème RESSERRÉ au centième : le jeu se joue au frame près. On prend la 1re
// bande dont l'écart au mot (fatal - time, en secondes) est <=. Tunable.
const SCORING = {
  MALUS: -1,     // le mot est sorti (time >= fatal) : ça coûte un point
  BANDS: [
    { max: 0.10, pts: 3 },   // < 100 ms avant le mot : parfait
    { max: 0.25, pts: 2 },   // < 250 ms
    { max: 0.50, pts: 1 },   // < 500 ms
  ],
};

// Tolérance anti-triche (s) entre le temps annoncé par le client et le temps
// réellement écoulé côté serveur. Au-delà, on ne fait plus confiance au client.
const TOL = 0.5;

// Marge de la preview (s) : 0 = la découverte va JUSQU'AU mot (choix de Mathys).
// Augmente-la si tu veux couper un poil avant pour ne pas entendre le mot.
const PREVIEW_MARGIN = 0;

// --- état d'un round -------------------------------------------------------
// Un « round » = UNE vidéo jouée par TOUT LE MONDE, chacun son tour.
// `results` (Map playerId -> {time, points, overshoot}) stocke le round EN RAM ;
// elle est repartie à zéro à chaque vidéo → aucune accumulation mémoire.
function createRound(video, order) {
  return {
    video: { id: video.id, fatal: video.fatal, startAt: video.startAt || 0 },
    order: [...order],       // ordre de passage (tous les joueurs présents)
    turnIndex: 0,            // pointeur « chacun son tour »
    active: null,           // id du joueur dont c'est le tour
    previewPlaying: false,  // la découverte a-t-elle été lancée par le MJ ?
    playing: false,         // la vidéo du tour a-t-elle été lancée (MJ ou joueur actif) ?
    goAt: 0,                // Date.now() du top départ (posé par server.js)
    stopReceived: false,    // garde-fou : un seul stop traité par tour
    timer: null,            // handle du setTimeout filet (posé par server.js)
    results: new Map(),     // playerId -> { time, points, overshoot, skipped }
  };
}

// Vidéo non encore jouée (repli : catalogue complet si tout a été vu).
function pickVideo(videos, usedIds, rng = Math.random) {
  let pool = videos.filter((v) => !usedIds.includes(v.id));
  if (!pool.length) pool = videos;
  return pool[Math.floor(rng() * pool.length)];
}

// Mélange (Fisher-Yates) — rng injectable pour rester testable. Sert à tirer un
// ordre de passage aléatoire À CHAQUE vidéo, pour que l'avantage des derniers
// (qui ont entendu les tours précédents) ne retombe pas toujours sur les mêmes.
function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Où couper la preview : juste avant le mot, sans jamais le laisser sortir.
const previewCut = (fatal, margin = PREVIEW_MARGIN) => Math.max(0, +(fatal - margin).toFixed(3));

// --- cœur : temps qui fait foi + scoring -----------------------------------
// Le serveur ne possède pas la vidéo : il ne peut pas « voir » où elle en est.
// Mais il connaît l'instant du top départ (`goAt`) et l'instant du clic. Il en
// déduit `serverTime` = position réelle de la vidéo. On fait confiance au temps
// annoncé par le client TANT QU'il colle à cette réalité (à la latence près) ;
// au-delà, ou si le joueur n'a pas cliqué (clientTime null), c'est le serveur
// qui fait autorité. Impossible donc de « mentir » sur son temps d'arrêt.
function authoritativeTime(clientTime, serverTime, tol = TOL) {
  const t = Number(clientTime);
  if (!Number.isFinite(t)) return serverTime;              // pas de clic → dépassement
  if (Math.abs(t - serverTime) > tol) return serverTime;   // écart suspect → autorité serveur
  return Math.max(0, t);                                    // annonce crédible → on la garde
}

// Points d'un arrêt. Malus si le mot est sorti, sinon la 1re bande dont l'écart
// au mot (fatal - time) est <=. Plus tu es près, plus tu marques.
function scoreStop(fatal, time, cfg = SCORING) {
  if (time >= fatal) return cfg.MALUS;                     // le mot a été prononcé
  const ecart = fatal - time;
  for (const b of cfg.BANDS) if (ecart <= b.max) return b.pts;
  return 0;                                                // trop tôt : rien
}

// Résout le tour du joueur actif : renvoie le temps retenu, les points et le
// flag dépassement. PURE : on lui passe les deux horloges, elle tranche.
function resolveTurn(round, clientTime, serverTime, cfg = SCORING, tol = TOL) {
  const time = authoritativeTime(clientTime, serverTime, tol);
  const points = scoreStop(round.video.fatal, time, cfg);
  const overshoot = time >= round.video.fatal;
  return { time: +time.toFixed(3), points, overshoot };
}

// Enregistre le résultat d'un joueur pour ce round.
function record(round, playerId, outcome) {
  round.results.set(playerId, outcome);
}

// Avance au tour suivant en sautant les joueurs partis. Renvoie l'id du prochain
// joueur actif, ou null si tout le monde a joué (→ le round est fini).
function nextActive(round, isPresent) {
  round.turnIndex++;
  while (round.turnIndex < round.order.length && !isPresent(round.order[round.turnIndex])) {
    round.turnIndex++;
  }
  return round.turnIndex < round.order.length ? round.order[round.turnIndex] : null;
}

// Premier joueur actif du round (saute aussi les éventuels absents en tête).
function firstActive(round, isPresent) {
  round.turnIndex = 0;
  while (round.turnIndex < round.order.length && !isPresent(round.order[round.turnIndex])) {
    round.turnIndex++;
  }
  return round.turnIndex < round.order.length ? round.order[round.turnIndex] : null;
}

// Classement du round (points décroissants). server.js y ajoute name/avatar.
function roundRanking(round) {
  return [...round.results.entries()]
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => b.points - a.points);
}

module.exports = {
  SCORING, TOL, PREVIEW_MARGIN,
  createRound, pickVideo, shuffle, previewCut,
  authoritativeTime, scoreStop, resolveTurn, record,
  firstActive, nextActive, roundRanking,
};
