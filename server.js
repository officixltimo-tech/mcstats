// Live-Modus: kleiner Webserver, der die Stats regelmäßig neu einliest.
// Läuft auf deinem PC, einem VPS o. Ä. Mit "remote" in der config.json holt er die Dateien per FTP/SFTP (z. B. G-Portal).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadConfig, collect } = require('./core');
const { sync } = require('./sync');

const cfg = loadConfig();
let snapshot = null, players = {};

async function refresh() {
  if (cfg.remote) {
    try { await sync(cfg); } catch (e) { console.error('[sync] Fehler:', e.message); }
  }
  ({ snapshot, players } = await collect(cfg));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, body, type = MIME['.json']) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const PUBLIC = path.join(__dirname, 'public');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/data/stats.json') return snapshot ? send(res, 200, JSON.stringify(snapshot)) : send(res, 503, '{"error":"lädt noch"}');
  const pm = decodeURIComponent(url.pathname).match(/^\/data\/spieler\/(\w{1,36})\.json$/);
  if (pm) {
    const p = players[pm[1].toLowerCase()];
    return p ? send(res, 200, JSON.stringify(p)) : send(res, 404, '{"error":"nicht gefunden"}');
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'verboten', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, b2) => send(res, 200, b2, MIME['.html']));
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}).listen(cfg.port, async () => {
  console.log(`[stats] Quelle: ${cfg.remote ? `${cfg.remote.protocol.toUpperCase()} ${cfg.remote.host}` : cfg.serverDir}`);
  console.log(`[stats] Läuft auf http://localhost:${cfg.port}`);
  await refresh().catch((e) => console.error(e));
  setInterval(() => refresh().catch((e) => console.error(e)), cfg.refreshSeconds * 1000);
});
