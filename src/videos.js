// Catalogue de REPLI du Jeu du Ban (embarqué). En prod, le serveur charge le
// vrai catalogue depuis le portfolio : https://mathyslan.github.io/games/ban/videos.json
// (refetché à chaque partie). Ce fichier ne sert que si le fetch échoue au boot.
//
// Le serveur ne connaît QUE l'id et le `fatal` (l'instant du mot interdit, en
// secondes). Les vidéos physiques vivent sur R2 : le front mappe id -> URL
// (<id>.mp4). `startAt` (optionnel) = « run-up » : au tour de chacun, la vidéo
// repart de là (défaut 0).
module.exports = [
  { id: 'vid_01', fatal: 6.400,  startAt: 0 },
  { id: 'vid_02', fatal: 11.900, startAt: 4 },
  { id: 'vid_03', fatal: 14.850, startAt: 8 },
  { id: 'vid_04', fatal: 3.250,  startAt: 0 },
  { id: 'vid_05', fatal: 22.100, startAt: 15 },
];
