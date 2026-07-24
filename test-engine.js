// Test du moteur du Ban : purement synchrone, aucun serveur requis.
const e = require('./src/engine-ban');
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };

const FATAL = 14.850;
const cfg = e.SCORING;

// --- scoring ---------------------------------------------------------------
check('dépassement pile sur le mot = malus', e.scoreStop(FATAL, 14.850) === cfg.MALUS);
check('dépassement après le mot = malus', e.scoreStop(FATAL, 15.2) === cfg.MALUS);
check('frôlé (écart ~0) ≈ MAX', e.scoreStop(FATAL, 14.849) >= cfg.MAX - 1);
check('arrêt très prudent (écart >= WINDOW) = MIN', e.scoreStop(FATAL, 14.850 - cfg.WINDOW - 3) === cfg.MIN);
// proportionnalité : plus on est près, plus on marque
const near = e.scoreStop(FATAL, 14.850 - 0.5);
const far = e.scoreStop(FATAL, 14.850 - 3.0);
check('plus près = plus de points', near > far);
check('score dans la fenêtre borné [MIN..MAX]', near <= cfg.MAX && far >= cfg.MIN);
// point milieu de la fenêtre ≈ moitié de l'amplitude
const mid = e.scoreStop(FATAL, FATAL - cfg.WINDOW / 2);
check('milieu de fenêtre ≈ moitié du barème', Math.abs(mid - (cfg.MIN + (cfg.MAX - cfg.MIN) / 2)) <= 1);

// --- temps qui fait foi (anti-triche) --------------------------------------
check('annonce crédible (latence) → on garde le client', e.authoritativeTime(14.30, 14.55) === 14.30);
check('annonce trop basse (triche) → autorité serveur', e.authoritativeTime(10.0, 15.1) === 15.1);
check('pas de clic (null) → autorité serveur (dépassement)', e.authoritativeTime(null, 16.4) === 16.4);
check('NaN → autorité serveur', e.authoritativeTime('pouet', 16.4) === 16.4);
check('mentir en prétendant la vidéo plus loin → recalé', e.authoritativeTime(20, 14.6) === 14.6);

// resolveTurn : cohérence temps/points/overshoot
const round = e.createRound({ id: 'vid_03', fatal: FATAL, startAt: 0 }, ['pA', 'pB', 'pC']);
let out = e.resolveTurn(round, 14.30, 14.45);  // honnête, sous le mot
check('resolveTurn honnête : pas de dépassement', out.overshoot === false && out.points > 0);
out = e.resolveTurn(round, null, 16.0);        // timeout serveur
check('resolveTurn timeout : dépassement + malus', out.overshoot === true && out.points === cfg.MALUS);

// --- boucle chacun son tour -------------------------------------------------
const all = new Set(['pA', 'pB', 'pC']);
const present = (id) => all.has(id);
check('premier actif = pA', e.firstActive(round, present) === 'pA');
e.record(round, 'pA', e.resolveTurn(round, 14.2, 14.3));
check('2e actif = pB', e.nextActive(round, present) === 'pB');
e.record(round, 'pB', e.resolveTurn(round, null, 15.9));   // pB dépasse
// pC se déconnecte avant son tour → on doit le sauter et finir le round
all.delete('pC');
check('pC parti → round fini (null)', e.nextActive(round, present) === null);

// classement du round
e.record(round, 'pC', { time: 0, points: 0, overshoot: false }); // (au cas où)
const rank = e.roundRanking(round);
check('classement trié par points décroissants', rank[0].points >= rank[rank.length - 1].points);
check('pA (frôlé) devant pB (dépassement)',
  rank.findIndex((r) => r.id === 'pA') < rank.findIndex((r) => r.id === 'pB'));

// --- sélection de vidéo + preview ------------------------------------------
const cat = [{ id: 'v1', fatal: 5 }, { id: 'v2', fatal: 9 }];
check('pickVideo évite les déjà vues', e.pickVideo(cat, ['v1']).id === 'v2');
check('pickVideo repli si tout vu', ['v1', 'v2'].includes(e.pickVideo(cat, ['v1', 'v2']).id));
check('previewCut = le mot (marge 0 : on va jusqu\'au fatal)', e.previewCut(14.850) === 14.850);
check('previewCut jamais négatif', e.previewCut(0.2) >= 0);

// --- ordre aléatoire --------------------------------------------------------
const base = ['pA', 'pB', 'pC', 'pD'];
const mixed = e.shuffle(base);
check('shuffle : mêmes joueurs, aucun perdu', [...mixed].sort().join() === [...base].sort().join());
check('shuffle : ne mute pas le tableau source', base.join() === 'pA,pB,pC,pD');
// sur 200 tirages, la 1re position n'est pas toujours la même (ordre bien brassé)
const firsts = new Set(Array.from({ length: 200 }, () => e.shuffle(base)[0]));
check('shuffle : le 1er passage varie', firsts.size >= 3);

console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
process.exit(f === 0 ? 0 : 1);
