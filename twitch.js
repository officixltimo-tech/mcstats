// Fragt bei der offiziellen Twitch-Schnittstelle (Helix) nach, welche Kanäle gerade live sind.
// Die Kanäle stehen in public/twitch.json, die Zugangsdaten kommen aus TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET.
'use strict';
const fs = require('fs');
const path = require('path');

function readChannels() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'twitch.json'), 'utf8'));
    return (Array.isArray(list) ? list : [])
      .map((c) => ({ spieler: String(c.spieler || '').trim(), login: String(c.twitch || '').trim().toLowerCase().replace(/^.*twitch\.tv\//, '').replace(/[^a-z0-9_]/g, '') }))
      .filter((c) => c.login);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[twitch] public/twitch.json ist fehlerhaft:', e.message);
    return [];
  }
}

async function twitchStatus() {
  const channels = readChannels();
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  const base = { updated: new Date().toISOString(), configured: !!(id && secret), channels: channels.map((c) => ({ ...c, live: false })) };
  if (!channels.length) { console.log('[twitch] Keine Kanäle in public/twitch.json eingetragen.'); return base; }
  if (!base.configured) { console.log('[twitch] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET fehlen – Live-Status wird nicht abgefragt.'); return base; }

  // 1) App-Token holen (gilt ca. 60 Tage, wir holen pro Lauf einfach einen neuen)
  const tr = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  if (!tr.ok) throw new Error(`Twitch-Anmeldung fehlgeschlagen (${tr.status}) – Client-ID/Secret prüfen.`);
  const token = (await tr.json()).access_token;
  const h = { 'Client-Id': id, Authorization: `Bearer ${token}` };
  const q = (key) => channels.slice(0, 100).map((c) => `${key}=${encodeURIComponent(c.login)}`).join('&');

  // 2) Profile (Name, Bild) und laufende Streams
  const [ur, sr] = await Promise.all([
    fetch(`https://api.twitch.tv/helix/users?${q('login')}`, { headers: h }),
    fetch(`https://api.twitch.tv/helix/streams?${q('user_login')}&first=100`, { headers: h }),
  ]);
  if (!ur.ok || !sr.ok) throw new Error(`Twitch-Abfrage fehlgeschlagen (${ur.status}/${sr.status}).`);
  const users = Object.fromEntries((await ur.json()).data.map((u) => [u.login, u]));
  const streams = Object.fromEntries((await sr.json()).data.map((s) => [s.user_login, s]));

  base.channels = channels.map((c) => {
    const u = users[c.login], s = streams[c.login];
    if (!u) console.warn(`[twitch] Kanal "${c.login}" gibt es bei Twitch nicht – Schreibweise prüfen.`);
    return {
      ...c,
      exists: !!u,
      name: u?.display_name || c.login,
      avatar: u?.profile_image_url || '',
      live: !!s,
      title: s?.title || '',
      game: s?.game_name || '',
      viewers: s?.viewer_count || 0,
      started: s?.started_at || '',
      thumb: s ? s.thumbnail_url.replace('{width}', '640').replace('{height}', '360') : '',
    };
  });
  const live = base.channels.filter((c) => c.live).length;
  console.log(`[twitch] ${live} von ${channels.length} Kanälen live.`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Twitch::${live} von ${channels.length} Kanälen live`);
  return base;
}

module.exports = { twitchStatus };
