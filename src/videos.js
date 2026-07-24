// Catalogue du Jeu du Ban. Le serveur ne connaît QUE l'id et le `fatal`
// (l'instant du mot interdit, en secondes). Les vidéos physiques vivent sur un
// CDN externe : c'est le front qui mappe id -> URL. `startAt` (optionnel) permet
// un « run-up » : au tour de chacun, la vidéo repart de là (défaut 0).
module.exports = [
  { id: 'vid_01', fatal: 6.400,  startAt: 0 },
  { id: 'vid_02', fatal: 11.900, startAt: 4 },
  { id: 'vid_03', fatal: 14.850, startAt: 8 },
  { id: 'vid_04', fatal: 3.250,  startAt: 0 },
  { id: 'vid_05', fatal: 22.100, startAt: 15 },
];
