// Holt die nötigen Dateien per FTP oder SFTP (z. B. von G-Portal) in einen lokalen Ordner.
// Geladen werden nur: server.properties, usercache.json, logs/latest.log, <welt>/stats/*.json
'use strict';
const fs = require('fs');
const path = require('path');

const posix = path.posix;
const GH = !!process.env.GITHUB_ACTIONS;
// Warnungen erscheinen auf GitHub zusätzlich oben auf der Übersichtsseite des Laufs
const warn = (msg) => { console.warn('[sync] ' + msg); if (GH) console.log(`::warning title=Stats-Abruf::${msg}`); };

async function openFtp(r) {
  const { FtpClient } = require('./ftp');
  const c = new FtpClient(20000);
  await c.access({ host: r.host, port: r.port || 21, user: r.user, password: r.password, secure: r.secure });
  return {
    async list(dir) {
      return (await c.list(dir)).filter((f) => f.name !== '.' && f.name !== '..')
        .map((f) => ({ ...f, isDir: !f.isFile }));
    },
    async get(remote, local) { await c.downloadTo(local, remote); },
    async close() { c.close(); },
  };
}

async function openSftp(r) {
  let SftpClient;
  try { SftpClient = require('ssh2-sftp-client'); }
  catch { throw new Error('Für SFTP einmal "npm install ssh2-sftp-client" im mcstats-Ordner ausführen.'); }
  const c = new SftpClient();
  await c.connect({ host: r.host, port: r.port || 22, username: r.user, password: r.password, readyTimeout: 20000 });
  return {
    async list(dir) {
      return (await c.list(dir)).map((f) => ({ name: f.name, size: f.size, mtime: f.modifyTime, isFile: f.type === '-', isDir: f.type === 'd' }));
    },
    async get(remote, local) { await c.fastGet(remote, local); },
    async close() { await c.end(); },
  };
}

async function sync(cfg) {
  const r = cfg.remote;
  if (!r) return;
  if (!r.user || !r.password) throw new Error('FTP-Benutzer oder Passwort fehlt (config.json → remote oder FTP_USER/FTP_PASSWORD).');
  const dest = cfg.serverDir;
  const manifestFile = path.join(dest, '.sync.json');
  fs.mkdirSync(dest, { recursive: true });
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};

  const t0 = Date.now();
  const conn = r.protocol === 'sftp' ? await openSftp(r) : await openFtp(r);
  console.log(`[sync] Verbunden mit ${r.host} (${r.protocol.toUpperCase()})`);
  let loaded = 0, statCount = 0;
  try {
    const listing = async (dir) => {
      try { return await conn.list(dir); }
      catch (e) { console.log(`[sync] Ordner ${dir} nicht lesbar: ${e.message}`); return []; }
    };
    const show = (arr) => arr.slice(0, 25).map((f) => f.name + (f.isDir ? '/' : '')).join(', ') || '(leer)';
    const byName = (arr, n) => arr.find((f) => f.name === n);

    // 1) Server-Ordner finden: dort, wo server.properties liegt (eingestellter Pfad oder eine Ebene darunter)
    let base = r.path.replace(/\/+$/, '') || '/';
    let root = await listing(base);
    console.log(`[sync] Inhalt von ${base}: ${show(root)}`);
    if (!byName(root, 'server.properties')) {
      for (const d of root.filter((f) => f.isDir).slice(0, 20)) {
        const sub = await listing(posix.join(base, d.name));
        if (byName(sub, 'server.properties')) {
          base = posix.join(base, d.name); root = sub;
          console.log(`[sync] server.properties gefunden in ${base} – nehme diesen Ordner.`);
          break;
        }
      }
    }
    if (!byName(root, 'server.properties')) warn(`Keine server.properties in ${base} gefunden. Ist FTP_PATH richtig? Es muss der Ordner sein, in dem server.properties liegt.`);

    const remote = (p) => posix.join(base, p);
    const fetchFile = async (rel, info) => {
      const stamp = info ? `${info.size}|${info.mtime}` : null;
      if (stamp && manifest[rel] === stamp && fs.existsSync(path.join(dest, rel))) return;
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      await conn.get(remote(rel), path.join(dest, rel));
      manifest[rel] = stamp; loaded++;
    };

    for (const f of ['server.properties', 'usercache.json']) {
      if (byName(root, f)) await fetchFile(f, byName(root, f));
    }
    const logs = await listing(remote('logs'));
    if (byName(logs, 'latest.log')) await fetchFile('logs/latest.log', null); // ändert sich ständig – immer neu laden

    // 2) Welt-Ordner bestimmen
    let level = 'world';
    try { level = (fs.readFileSync(path.join(dest, 'server.properties'), 'utf8').match(/^level-name=(.*)$/m) || [])[1]?.trim() || 'world'; } catch {}
    let stats = (await listing(remote(`${level}/stats`))).filter((f) => f.isFile && f.name.endsWith('.json'));
    if (!stats.length) {
      // Fallback: irgendein Ordner mit stats/ darin
      for (const d of root.filter((f) => f.isDir && f.name !== level).slice(0, 20)) {
        const s = (await listing(remote(`${d.name}/stats`))).filter((f) => f.isFile && f.name.endsWith('.json'));
        if (s.length) { console.log(`[sync] Stats in ${d.name}/stats gefunden (statt ${level}/stats).`); level = d.name; stats = s; break; }
      }
    }
    // Lokale Kopie soll denselben Weltnamen nutzen wie gefunden
    {
      const pf = path.join(dest, 'server.properties');
      const p = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : '';
      const fixed = /^level-name=.*$/m.test(p) ? p.replace(/^level-name=.*$/m, `level-name=${level}`) : p + `\nlevel-name=${level}\n`;
      if (fixed !== p) { fs.writeFileSync(pf, fixed); delete manifest['server.properties']; }
    }

    if (!stats.length) {
      const w = await listing(remote(level));
      warn(`Keine Stats-Dateien in ${remote(level + '/stats')}. Inhalt von ${remote(level)}: ${show(w)}. ` +
        'Minecraft legt die Dateien erst an, wenn jemand gespielt hat und der Server gespeichert hat (/save-all).');
    }
    for (const f of stats) await fetchFile(`${level}/stats/${f.name}`, f);
    statCount = stats.length;
  } finally {
    await conn.close().catch(() => {});
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  console.log(`[sync] ${statCount} Spieler-Statistiken auf dem Server, ${loaded} Datei(en) neu geladen (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

module.exports = { sync };

// Direkt aufrufbar zum Testen: node sync.js
if (require.main === module) {
  const { loadConfig } = require('./core');
  sync(loadConfig()).catch((e) => { console.error('[sync] Fehler:', e.message); process.exit(1); });
}
