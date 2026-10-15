// Statischer Modus: erzeugt den Ordner dist/ mit fertiger Website + JSON-Daten.
// Gedacht für GitHub Pages (siehe .github/workflows/stats.yml) oder jeden normalen Webspace.
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, collect } = require('./core');
const { sync } = require('./sync');

(async () => {
  const cfg = loadConfig();
  if (cfg.remote) await sync(cfg);
  const { snapshot, players } = await collect(cfg);

  // Im Browser zusätzlich live nachsehen, wer online ist (über api.mcsrvstat.us)
  snapshot.static = true;
  snapshot.liveAddress = process.env.PUBLIC_ADDRESS || `${cfg.mcHost}${cfg.mcPort ? ':' + cfg.mcPort : ''}`;

  const out = path.join(__dirname, 'dist');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'data', 'spieler'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'public'), out, { recursive: true });
  fs.writeFileSync(path.join(out, 'data', 'stats.json'), JSON.stringify(snapshot));
  for (const [key, p] of Object.entries(players)) fs.writeFileSync(path.join(out, 'data', 'spieler', key + '.json'), JSON.stringify(p));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  const n = Object.keys(players).length;
  const summary = `${n} Spieler mit Stats, Minecraft-Server ${snapshot.server.reachable ? `online (${snapshot.server.online} Spieler)` : `nicht erreichbar unter ${cfg.mcHost}:${cfg.mcPort || 25565}`}`;
  console.log(`[build] dist/ erstellt: ${summary}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::${n ? 'notice' : 'warning'} title=Ergebnis::${summary}`);
})().catch((e) => { console.error('[build] Fehler:', e.message); process.exit(1); });
