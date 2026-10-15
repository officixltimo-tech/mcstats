// Minimaler FTP-Client ohne Abhängigkeiten (passiver Modus, optional FTPS mit AUTH TLS).
// Kann genau das, was die Stats-Seite braucht: anmelden, Ordner auflisten, Dateien herunterladen.
'use strict';
const net = require('net');
const tls = require('tls');
const fs = require('fs');

class FtpClient {
  constructor(timeout = 20000) { this.timeout = timeout; this.buf = ''; this.waiters = []; this.replies = []; }

  _attach(sock) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.setTimeout(this.timeout, () => sock.destroy(new Error('FTP-Zeitüberschreitung')));
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => this._fail(e));
    sock.on('close', () => this._fail(new Error('FTP-Verbindung geschlossen')));
  }
  _fail(e) { const w = this.waiters; this.waiters = []; w.forEach((x) => x.reject(e)); this.dead = e; }
  _onData(d) {
    this.buf += d;
    let m;
    // vollständige Antwort: "123 Text" oder mehrzeilig "123-..." bis "123 ..."
    while ((m = this.buf.match(/^(\d{3})([ -])/))) {
      const code = m[1];
      let end;
      if (m[2] === ' ') end = this.buf.indexOf('\n');
      else { const re = new RegExp(`(^|\\n)${code} [^\\n]*\\n`); const mm = re.exec(this.buf); end = mm ? mm.index + mm[0].length - 1 : -1; }
      if (end < 0) break;
      const text = this.buf.slice(0, end + 1).trim();
      this.buf = this.buf.slice(end + 1);
      const reply = { code: Number(code), text };
      const w = this.waiters.shift();
      w ? w.resolve(reply) : this.replies.push(reply);
    }
  }
  _next() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async send(cmd, ok = [200, 299]) {
    this.sock.write(cmd + '\r\n');
    const r = await this._next();
    if (ok && (r.code < ok[0] || r.code > ok[1])) throw new Error(`FTP "${cmd.split(' ')[0]}" fehlgeschlagen: ${r.text}`);
    return r;
  }

  async access({ host, port = 21, user, password, secure = false }) {
    this.host = host; this.secure = secure;
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port }, resolve);
      s.once('error', reject);
      this._attach(s);
    });
    const hello = await this._next();
    if (hello.code !== 220) throw new Error('FTP-Begrüßung unerwartet: ' + hello.text);
    if (secure) {
      await this.send('AUTH TLS');
      this.sock.removeAllListeners('data'); this.sock.removeAllListeners('close'); this.sock.removeAllListeners('error');
      const t = tls.connect({ socket: this.sock, servername: host, rejectUnauthorized: false });
      await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
      this._attach(t);
    }
    const u = await this.send('USER ' + user, [200, 399]);
    if (u.code === 331) await this.send('PASS ' + password, [200, 299]).catch(() => { throw new Error('FTP-Login fehlgeschlagen – Benutzername/Passwort prüfen.'); });
    if (secure) { await this.send('PBSZ 0'); await this.send('PROT P'); }
    await this.send('TYPE I');
  }

  async _dataSocket() {
    let port, host = this.host;
    try {
      const r = await this.send('EPSV');
      port = Number(r.text.match(/\(\|\|\|(\d+)\|\)/)[1]);
    } catch {
      const r = await this.send('PASV');
      const n = r.text.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/).slice(1).map(Number);
      port = n[4] * 256 + n[5]; // IP aus PASV ignorieren (oft intern), Host der Steuerverbindung nehmen
    }
    const raw = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port }, () => resolve(s));
      s.once('error', reject);
      s.setTimeout(this.timeout, () => s.destroy(new Error('FTP-Datenverbindung: Zeitüberschreitung')));
    });
    if (!this.secure) return raw;
    const t = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false, session: this.sock.getSession && this.sock.getSession() });
    await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
    return t;
  }

  async _transfer(cmd, onData) {
    const data = await this._dataSocket();
    const done = new Promise((resolve, reject) => { data.on('data', onData); data.on('end', resolve); data.on('close', resolve); data.on('error', reject); });
    let start;
    try { start = await this.send(cmd, [100, 299]); } catch (e) { data.destroy(); throw e; }
    if (start.code >= 200) { await done; return; } // manche Server antworten gleich mit 226
    await done;
    const fin = await this._next();
    if (fin.code >= 400) throw new Error(`FTP "${cmd.split(' ')[0]}" fehlgeschlagen: ${fin.text}`);
  }

  // Liefert [{ name, size, mtime, isFile }]
  async list(dir) {
    let txt = '';
    try {
      await this._transfer('MLSD ' + dir, (d) => { txt += d; });
      return txt.split(/\r?\n/).filter(Boolean).map((line) => {
        const i = line.indexOf(' '); const facts = {};
        for (const f of line.slice(0, i).split(';')) { const [k, v] = f.split('='); if (k) facts[k.toLowerCase()] = v; }
        return { name: line.slice(i + 1), size: Number(facts.size || 0), mtime: facts.modify || '', isFile: facts.type === 'file' };
      });
    } catch (e) {
      if (!/^FTP "MLSD"/.test(e.message)) throw e;
    }
    txt = '';
    await this._transfer('LIST ' + dir, (d) => { txt += d; });
    return txt.split(/\r?\n/).filter(Boolean).map((line) => {
      // Unix-Format: -rw-r--r-- 1 user group 1234 Oct 14 23:12 name.json
      const m = line.match(/^([\-dl])\S*\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$/);
      if (m) return { name: m[4], size: Number(m[2]), mtime: m[3], isFile: m[1] === '-' };
      // Windows-Format: 10-14-26  11:12PM  1234 name.json
      const w = line.match(/^(\S+\s+\S+)\s+(<DIR>|\d+)\s+(.+)$/);
      if (w) return { name: w[3], size: w[2] === '<DIR>' ? 0 : Number(w[2]), mtime: w[1], isFile: w[2] !== '<DIR>' };
      return null;
    }).filter(Boolean);
  }

  async downloadTo(local, remote) {
    const tmp = local + '.part';
    const out = fs.createWriteStream(tmp);
    await this._transfer('RETR ' + remote, (d) => out.write(d));
    await new Promise((r) => out.end(r));
    fs.renameSync(tmp, local);
  }

  close() { try { this.sock.write('QUIT\r\n'); this.sock.end(); } catch {} }
}

module.exports = { FtpClient };
