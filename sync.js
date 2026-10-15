// Holt die nötigen Dateien per FTP oder SFTP (z. B. von G-Portal) in einen lokalen Ordner.
// Geladen werden nur: server.properties, usercache.json, logs/latest.log, <welt>/stats/*.json
'use strict';
const fs = require('fs');
const path = require('path');

const posix = path.posix;

async function openFtp(r) {
  const { FtpClient } = require('./ftp');
  const c = new FtpClient(20000);
  await c.access({ host: r.host, port: r.port || 21, user: r.user, password: r.password, secure: r.secure });
  return {
    async list(dir) { return (await c.list(dir)).filter((f) => f.isFile); },
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
    async list(dir) { return (await c.list(dir)).filter((f) => f.type === '-').map((f) => ({ name: f.name, size: f.size, mtime: f.modifyTime })); },
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
  let loaded = 0;
  try {
    const remote = (p) => posix.join(r.path, p);
    const fetchFile = async (rel, info) => {
      const key = rel;
      const stamp = info ? `${info.size}|${info.mtime}` : null;
      if (stamp && manifest[key] === stamp && fs.existsSync(path.join(dest, rel))) return;
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      await conn.get(remote(rel), path.join(dest, rel));
      manifest[key] = stamp; loaded++;
    };
    const listing = async (dir) => { try { return await conn.list(remote(dir)); } catch { return []; } };

    const root = await listing('.');
    const byName = (arr, n) => arr.find((f) => f.name === n);
    for (const f of ['server.properties', 'usercache.json']) {
      if (byName(root, f)) await fetchFile(f, byName(root, f));
    }
    const logs = await listing('logs');
    if (byName(logs, 'latest.log')) await fetchFile('logs/latest.log', null); // ändert sich ständig – immer neu laden

    let level = 'world';
    try { level = (fs.readFileSync(path.join(dest, 'server.properties'), 'utf8').match(/^level-name=(.*)$/m) || [])[1]?.trim() || 'world'; } catch {}
    const stats = await listing(`${level}/stats`);
    if (!stats.length) console.warn(`[sync] Keine Stats gefunden unter ${remote(level + '/stats')} – stimmt der Pfad?`);
    for (const f of stats) if (f.name.endsWith('.json')) await fetchFile(`${level}/stats/${f.name}`, f);
  } finally {
    await conn.close().catch(() => {});
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  console.log(`[sync] ${loaded} Datei(en) von ${r.host} geladen (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

module.exports = { sync };

// Direkt aufrufbar zum Testen: node sync.js
if (require.main === module) {
  const { loadConfig } = require('./core');
  sync(loadConfig()).catch((e) => { console.error('[sync] Fehler:', e.message); process.exit(1); });
}
