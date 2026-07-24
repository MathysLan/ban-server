// Repli embarqué du Jeu du Ban — VOLONTAIREMENT VIDE.
//
// Le vrai catalogue vit dans le portfolio : games/ban/videos.json, que le
// serveur fetch depuis https://mathyslan.github.io/games/ban/videos.json (au
// boot et à chaque partie, cache 10 s).
//
// On garde ce repli vide EXPRÈS : si le fetch échoue, le serveur répond
// « aucune vidéo dans le catalogue » (erreur franche) au lieu de jouer une
// vraie vidéo avec un mauvais `fatal` en silence. Ne rien mettre ici.
module.exports = [];
