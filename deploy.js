// Lädt die fertige Seite (Ordner dist/) per FTP, FTPS oder SFTP auf deinen Webspace,
// damit sie unter deiner eigenen Domain erreichbar ist.
// Es werden nur Dateien hochgeladen, die sich seit dem letzten Mal geändert haben.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const posix = path.posix;
const GH = !!process.env.GITHUB_ACTIONS;

function loadWebConfig() {
  const file = path.join(__dirname, 'config.json');
  const c = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).webspace || {}) : {};
  const e = process.env;
  const protocol = (e.WEB_FTP_PROTOCOL || c.protocol || 'ftp').toLowerCase();
  return {
    protocol,
    host: e.WEB_FTP_HOST || c.host,
    port: Number(e.WEB_FTP_PORT || c.port || (protocol === 'sftp' ? 22 : 21)),
    user: e.WEB_FTP_USER || c.user,
    password: e.WEB_FTP_PASSWORD || c.password,
    path: (e.WEB_FTP_PATH || c.path || '/').replace(/\/+$/, '') || '/',
  };
}

async function connect(w) {
  if (w.protocol === 'sftp') {
    const SftpClient = require('./need')('ssh2-sftp-client');
    const c = new SftpClient();
    await c.connect({ host: w.host, port: w.port, username: w.user, password: w.password, readyTimeout: 20000 });
    return {
      ensureDir: (d) => c.mkdir(d, true).catch(() => {}),
      list: async (d) => (await c.list(d)).map((f) => f.name),
      put: (local, remote) => c.fastPut(local, remote),
      close: () => c.end(),
    };
  }
  const { FtpClient } = require('./ftp');
  const c = new FtpClient(30000);
  await c.access({ host: w.host, port: w.port, user: w.user, password: w.password, secure: w.protocol === 'ftps' });
  return {
    ensureDir: (d) => c.ensureDir(d),
    list: async (d) => (await c.list(d)).map((f) => f.name).filter((n) => n !== '.' && n !== '..'),
    put: (local, remote) => c.uploadFrom(local, remote),
    close: async () => c.close(),
  };
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function deploy() {
  const w = loadWebConfig();
  if (!w.host) { console.log('[deploy] Kein Webspace eingestellt (WEB_FTP_HOST) – überspringe.'); return; }
  if (!w.user || !w.password) throw new Error('WEB_FTP_USER oder WEB_FTP_PASSWORD fehlt.');
  const dist = path.join(__dirname, 'dist');
  if (!fs.existsSync(dist)) throw new Error('Ordner dist/ fehlt – erst "node build.js" ausführen.');

  // Merkt sich, was schon oben ist (liegt im Cache-Ordner mirror/, damit GitHub es behält)
  const manFile = path.join(__dirname, 'mirror', '.deploy.json');
  fs.mkdirSync(path.dirname(manFile), { recursive: true });
  let man = {};
  try { man = JSON.parse(fs.readFileSync(manFile, 'utf8')); } catch {}
  const target = `${w.protocol}://${w.host}${w.path}`;
  if (man.target !== target) man = { target, files: {} }; // anderes Ziel → alles neu hochladen

  const files = walk(dist);
  const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(dist, f))).digest('hex');

  const t0 = Date.now();
  const conn = await connect(w);
  console.log(`[deploy] Verbunden mit ${w.host} (${w.protocol.toUpperCase()}), Zielordner ${w.path}`);
  let n = 0;
  try {
    // Nachsehen, was wirklich auf dem Webspace liegt. Fehlt etwas (z. B. weil ein Lauf
    // abgebrochen wurde oder jemand Dateien gelöscht hat), wird es neu hochgeladen.
    let remoteNames = [];
    try { remoteNames = await conn.list(w.path); } catch { /* Ordner gibt es noch nicht */ }
    console.log(`[deploy] Auf dem Webspace in ${w.path}: ${remoteNames.slice(0, 20).join(', ') || '(leer)'}`);
    const present = new Set(remoteNames);
    const missingTop = new Set(files.map((f) => f.split('/')[0]).filter((t) => !present.has(t)));
    if (missingTop.size) console.log(`[deploy] Fehlt auf dem Webspace: ${[...missingTop].join(', ')} – wird hochgeladen.`);

    const changed = files.filter((f) => missingTop.has(f.split('/')[0]) || man.files[f] !== hash(f));
    // Erst die Daten, zuletzt stats.json und index.html – so sieht nie jemand eine halbe Seite
    const rank = (f) => (f === 'index.html' ? 2 : f === 'data/stats.json' ? 1 : 0);
    changed.sort((a, z) => rank(a) - rank(z));
    if (!changed.length) { console.log('[deploy] Alles aktuell – nichts hochzuladen.'); return; }

    const made = new Set();
    for (const f of changed) {
      const remote = posix.join(w.path, f);
      const dir = posix.dirname(remote);
      if (dir !== '/' && dir !== '.' && !made.has(dir)) { await conn.ensureDir(dir); made.add(dir); }
      await conn.put(path.join(dist, f), remote);
      man.files[f] = hash(f); n++;
    }
  } finally {
    await conn.close().catch(() => {});
    fs.writeFileSync(manFile, JSON.stringify(man));
  }
  if (!n) return;
  const msg = `${n} Datei(en) auf ${w.host} hochgeladen (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
  console.log('[deploy] ' + msg);
  if (GH) console.log(`::notice title=Eigene Domain::${msg}`);
}

deploy().catch((e) => {
  console.error('[deploy] Fehler:', e.message);
  if (GH) console.log(`::error title=Hochladen auf eigene Domain::${e.message}`);
  process.exit(1);
});
