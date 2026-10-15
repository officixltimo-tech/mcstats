// Gemeinsame Logik: Konfiguration laden, Stats auswerten, Server anpingen.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');

// ---------- Konfiguration (config.json + Umgebungsvariablen) ----------
function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  const c = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const r = c.remote || {};
  const env = process.env;
  const remoteHost = env.FTP_HOST || r.host;
  return {
    serverName: env.SERVER_NAME || c.serverName || 'Mein Server',
    serverDir: path.resolve(__dirname, env.SERVER_DIR || c.serverDir || (remoteHost ? './mirror' : '../server')),
    port: Number(env.PORT || c.port || 8080),
    mcHost: env.MC_HOST || c.mcHost || remoteHost || '127.0.0.1',
    mcPort: Number(env.MC_PORT || c.mcPort || 0),
    hidden: (env.HIDDEN_PLAYERS ? env.HIDDEN_PLAYERS.split(',') : c.hidden || []).map((s) => s.trim().toLowerCase()).filter(Boolean),
    refreshSeconds: Number(env.REFRESH_SECONDS || c.refreshSeconds || (remoteHost ? 120 : 30)),
    lookupNames: c.lookupNames !== false,
    remote: remoteHost ? {
      protocol: (env.FTP_PROTOCOL || r.protocol || 'ftp').toLowerCase(),
      host: remoteHost,
      port: Number(env.FTP_PORT || r.port || 0),
      user: env.FTP_USER || r.user,
      password: env.FTP_PASSWORD || r.password,
      path: env.FTP_PATH || r.path || '/',
      secure: (env.FTP_SECURE || String(r.secure || 'false')) === 'true',
    } : null,
  };
}

const readJson = async (p, fb) => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fb; } };
const strip = (k) => k.replace(/^minecraft:/, '');
const sum = (obj, pred = () => true) => Object.entries(obj || {}).reduce((a, [k, v]) => (pred(strip(k)) ? a + v : a), 0);

function readProperties(dir) {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
  } catch { return {}; }
}

// ---------- Namen ----------
const nameCacheFile = path.join(__dirname, 'names-cache.json');
let nameCache = fs.existsSync(nameCacheFile) ? JSON.parse(fs.readFileSync(nameCacheFile, 'utf8')) : {};
async function resolveNames(cfg, uuids) {
  const usercache = await readJson(path.join(cfg.serverDir, 'usercache.json'), []);
  for (const e of usercache) if (e.uuid && e.name) nameCache[e.uuid] = e.name;
  const missing = uuids.filter((u) => !nameCache[u]);
  if (cfg.lookupNames && missing.length) {
    for (const u of missing.slice(0, 20)) {
      try {
        const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${u.replace(/-/g, '')}`);
        if (r.ok) { const j = await r.json(); if (j.name) nameCache[u] = j.name; }
      } catch { /* offline – egal */ }
    }
    fs.writeFileSync(nameCacheFile, JSON.stringify(nameCache));
  }
  return nameCache;
}

// ---------- Server List Ping ----------
function varint(n) { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); }
function readVarint(buf, off) { let n = 0, s = 0, b; do { if (off >= buf.length) return null; b = buf[off++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [n, off]; }
function pingServer(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let data = Buffer.alloc(0), done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeout, () => finish(null));
    sock.on('error', () => finish(null));
    sock.on('connect', () => {
      const h = Buffer.from(host, 'utf8');
      const p = Buffer.alloc(2); p.writeUInt16BE(port);
      const body = Buffer.concat([varint(0), varint(767), varint(h.length), h, p, varint(1)]);
      sock.write(Buffer.concat([varint(body.length), body, varint(1), varint(0)]));
    });
    sock.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const len = readVarint(data, 0); if (!len || data.length < len[1] + len[0]) return;
      const id = readVarint(data, len[1]); const sl = readVarint(data, id[1]);
      try { finish(JSON.parse(data.slice(sl[1], sl[1] + sl[0]).toString('utf8'))); } catch { finish(null); }
    });
  });
}

// ---------- Log-Events ----------
async function readEvents(cfg, names) {
  let txt = '';
  try { txt = await fsp.readFile(path.join(cfg.serverDir, 'logs', 'latest.log'), 'utf8'); } catch { return []; }
  const events = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})[^\]]*\](?: \[[^\]]+\])?: (.*)$/);
    if (!m) continue;
    const [, time, msg] = m;
    let e;
    if ((e = msg.match(/^(\w{3,16}) joined the game$/))) events.push({ time, type: 'join', player: e[1] });
    else if ((e = msg.match(/^(\w{3,16}) left the game$/))) events.push({ time, type: 'leave', player: e[1] });
    else if ((e = msg.match(/^(\w{3,16}) has (made the advancement|completed the challenge|reached the goal) \[(.+)\]$/)))
      events.push({ time, type: e[2].includes('challenge') ? 'challenge' : 'advancement', player: e[1], detail: e[3] });
  }
  const known = new Set(Object.values(names).map((n) => n.toLowerCase()));
  return events.filter((e) => known.has(e.player.toLowerCase()) && !cfg.hidden.includes(e.player.toLowerCase())).slice(-8).reverse();
}

// ---------- Bestenlisten ----------
const FOOD = new Set(('apple golden_apple enchanted_golden_apple melon_slice sweet_berries glow_berries chorus_fruit carrot golden_carrot potato baked_potato poisonous_potato beetroot beetroot_soup dried_kelp beef cooked_beef porkchop cooked_porkchop mutton cooked_mutton chicken cooked_chicken rabbit cooked_rabbit cod cooked_cod salmon cooked_salmon tropical_fish pufferfish bread cookie cake pumpkin_pie rotten_flesh spider_eye mushroom_stew rabbit_stew suspicious_stew honey_bottle').split(' '));
const DIST = /_one_cm$/;

const BOARDS = [
  { key: 'playtime', title: 'Dauerzocker', sub: 'Meiste Spielzeit', unit: 'hours' },
  { key: 'diamonds', title: 'Diamantenbank', sub: 'Meiste Diamanterze abgebaut', unit: 'count' },
  { key: 'deaths', title: 'Friedhof', sub: 'Hier liegen sie. Immer wieder.', unit: 'count' },
  { key: 'mined', title: 'Abrissbirne', sub: 'Meiste Blöcke abgebaut', unit: 'count' },
  { key: 'mobs', title: 'Monsterjäger', sub: 'Meiste Mobs erledigt', unit: 'count' },
  { key: 'distance', title: 'Weltenbummler', sub: 'Weiteste Strecke', unit: 'km' },
  { key: 'totems', title: 'Unsterblich', sub: 'Meiste Totems verbraucht', unit: 'count' },
  { key: 'damage', title: 'Kampfmaschine', sub: 'Meisten Schaden ausgeteilt', unit: 'hearts' },
  { key: 'food', title: 'Vielfraß', sub: 'Meiste Mahlzeiten verdrückt', unit: 'count' },
];

function summarize(s) {
  const c = s['minecraft:custom'] || {};
  const g = (k) => c['minecraft:' + k] || 0;
  return {
    playtime: (g('play_time') || g('play_one_minute')) / 72000,
    diamonds: sum(s['minecraft:mined'], (k) => k === 'diamond_ore' || k === 'deepslate_diamond_ore'),
    deaths: g('deaths'),
    mined: sum(s['minecraft:mined']),
    mobs: g('mob_kills'),
    distance: sum(c, (k) => DIST.test(k) && k !== 'fall_one_cm') / 100000,
    totems: sum(s['minecraft:used'], (k) => k === 'totem_of_undying'),
    damage: g('damage_dealt') / 20,
    food: sum(s['minecraft:used'], (k) => FOOD.has(k)),
  };
}

// Liest alles ein und gibt { snapshot, players } zurück. players: name(klein) -> Detaildaten
async function collect(cfg) {
  const props = readProperties(cfg.serverDir);
  const statsDir = path.join(cfg.serverDir, props['level-name'] || 'New World (4)', 'stats');
  let files = [];
  try { files = (await fsp.readdir(statsDir)).filter((f) => f.endsWith('.json')); }
  catch { console.warn(`[stats] Ordner nicht gefunden: ${statsDir}`); }

  const uuids = files.map((f) => f.slice(0, -5));
  const names = await resolveNames(cfg, uuids);
  const list = [];
  const players = {};
  for (const uuid of uuids) {
    const raw = await readJson(path.join(statsDir, uuid + '.json'), null);
    if (!raw || !raw.stats) continue;
    const name = names[uuid] || uuid.slice(0, 8);
    if (cfg.hidden.includes(name.toLowerCase())) continue;
    const summary = summarize(raw.stats);
    list.push({ uuid, name, summary });
    players[name.toLowerCase()] = { uuid, name, summary, stats: raw.stats };
  }

  const ping = await pingServer(cfg.mcHost, cfg.mcPort || Number(props['server-port'] || 25565));
  const motd = ping && (typeof ping.description === 'string' ? ping.description : (ping.description?.text || ''));
  const snapshot = {
    serverName: cfg.serverName,
    updated: new Date().toISOString(),
    refreshSeconds: cfg.refreshSeconds,
    server: ping
      ? { reachable: true, online: ping.players?.online || 0, max: ping.players?.max || 0,
          players: (ping.players?.sample || []).map((p) => p.name).filter((n) => !cfg.hidden.includes(n.toLowerCase())),
          version: ping.version?.name || '', motd }
      : { reachable: false, online: 0, max: 0, players: [] },
    totals: {
      players: list.length,
      hours: list.reduce((a, p) => a + p.summary.playtime, 0),
      deaths: list.reduce((a, p) => a + p.summary.deaths, 0),
    },
    events: await readEvents(cfg, names),
    boards: BOARDS.map((b) => ({
      ...b,
      entries: list.filter((p) => p.summary[b.key] > 0).sort((a, z) => z.summary[b.key] - a.summary[b.key]).slice(0, 10)
        .map((p) => ({ uuid: p.uuid, name: p.name, value: p.summary[b.key] })),
    })),
    players: list.map((p) => ({ uuid: p.uuid, name: p.name })).sort((a, z) => a.name.localeCompare(z.name)),
  };
  return { snapshot, players };
}

module.exports = { loadConfig, collect };
