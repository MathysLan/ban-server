# ban-server — Le Jeu du Ban

Serveur arbitre (Node + `ws`). Arrête la vidéo le plus près possible d'un mot
interdit **sans jamais le laisser sortir**. Le serveur ne connaît que le
`fatal_timestamp` de chaque vidéo (jamais le fichier) et le garde **secret**
jusqu'aux résultats.

## Lancer
```
npm install          # ws
npm start            # écoute sur :8080 (PORT modifiable)
```

## Tester
```
node test-engine.js  # règles pures (scoring, malus, anti-triche, boucle)
# puis, serveur lancé avec des délais courts :
PORT=8125 PREVIEW_MS=200 NEXT_TURN_MS=150 GRACE_S=0.3 node src/server.js
node test-e2e.js     # partie complète, 2 clients ws
```

## Architecture
- `src/engine-ban.js` : RÈGLES pures (aucun socket / timer). 100% testable.
- `src/server.js` : transport `ws` + machine à états + `setTimeout` (rythme et
  filet anti-blocage). C'est l'arbitre absolu.
- `src/videos.js` : catalogue `{ id, fatal, startAt? }`. Le front mappe id→URL (CDN).

## Réglages (env)
`PORT`, `PREVIEW_MS`, `NEXT_TURN_MS`, `GRACE_S`. Barème dans `engine-ban.js`
(`SCORING`, `TOL`, `PREVIEW_MARGIN`).
# ban-server
