// Lädt ein npm-Paket und installiert es automatisch, falls es noch fehlt.
'use strict';
const path = require('path');
const { execSync } = require('child_process');

module.exports = function need(name) {
  try { return require(name); } catch { /* fehlt noch */ }
  console.log(`[setup] ${name} fehlt – wird jetzt installiert …`);
  try {
    execSync(`npm install --no-audit --no-fund ${name}`, { cwd: __dirname, stdio: 'inherit' });
  } catch {
    throw new Error(`Konnte ${name} nicht installieren. Bitte im mcstats-Ordner "npm install ${name}" ausführen.`);
  }
  try { return require(path.join(__dirname, 'node_modules', name)); }
  catch { throw new Error(`${name} konnte nicht installiert werden (keine Verbindung zu npm?). Bitte im mcstats-Ordner "npm install ${name}" ausführen.`); }
};
