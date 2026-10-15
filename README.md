# Minecraft Stats-Website (auch für G-Portal)

Eine Stats-Seite im Stil von craftattack.one/stats. Die Zahlen kommen direkt aus deinem Minecraft-Server:
Spielzeit, Tode, Diamanten, Blöcke, Mobs, Strecke, Totems, Schaden, Essen – plus Online-Liste, letzte Events und eine Seite pro Spieler.

## Warum das mit G-Portal etwas anders läuft

Auf einem G-Portal-Server kannst du **keine eigenen Programme** laufen lassen. Du kommst aber per **FTP** an die Dateien –
und genau da liegen die Stats (`world/stats/*.json`). Die Seite läuft deshalb *woanders* und holt sich die Dateien regelmäßig per FTP:

```
G-Portal-Server  ──FTP──▶  Stats-Seite (GitHub Pages / dein PC / VPS)  ──▶  Besucher
                 ──Ping──▶  (wer gerade online ist)
```

Es werden nur gelesen: `server.properties`, `usercache.json`, `logs/latest.log` und `world/stats/`. Am Server wird nichts verändert.

---

## Schritt 1: FTP-Daten bei G-Portal holen

1. Bei g-portal.com einloggen → **Meine Server** → deinen Minecraft-Server anklicken.
2. Auf der **Status**-Seite stehen die **FTP-Zugangsdaten**: Host/IP, Port, Benutzername, Passwort.
   (Steht dort „SFTP“, nimm SFTP – siehe unten.)
3. Notier dir außerdem die **Server-IP und den Port**, mit denen man sich in Minecraft verbindet.

Test (optional): Mit FileZilla verbinden und nachsehen, ob es den Ordner `world/stats` gibt.
Heißt deine Welt anders, steht der Name in `server.properties` bei `level-name` – das wird automatisch erkannt.

---

## Weg A: Kostenlos mit GitHub Pages (empfohlen, kein eigener Server nötig)

GitHub holt alle 10 Minuten die Stats von G-Portal und veröffentlicht die Seite unter
`https://deinname.github.io/repo-name/`.

1. Kostenlosen Account auf github.com anlegen.
2. Neues **öffentliches** Repository erstellen (z. B. `mcstats`).
3. Alle Dateien aus diesem Ordner hochladen – **auch den Ordner `.github`** (der ist versteckt; am einfachsten per „Add file → Upload files“ den ganzen Ordner reinziehen).
   **Keine** `config.json` mit Passwort hochladen!
4. Im Repository: **Settings → Secrets and variables → Actions → New repository secret** und diese Secrets anlegen:

   | Name | Wert |
   |---|---|
   | `FTP_HOST` | FTP-Host von G-Portal |
   | `FTP_PORT` | FTP-Port (meist 21) |
   | `FTP_USER` | FTP-Benutzername |
   | `FTP_PASSWORD` | FTP-Passwort |
   | `MC_HOST` | Server-IP für Minecraft |
   | `MC_PORT` | Minecraft-Port (z. B. 25565) |
   | `FTP_PROTOCOL` | nur wenn G-Portal SFTP zeigt: `sftp` |

   Unter dem Reiter **Variables** kannst du `SERVER_NAME` (z. B. „BotyCraft“) und `HIDDEN_PLAYERS` (z. B. `Admin1,Admin2`) setzen.
5. **Settings → Pages → Source: „GitHub Actions“** auswählen.
6. **Actions → „Stats aktualisieren“ → Run workflow** klicken. Nach ca. 1 Minute ist die Seite online.

Gut zu wissen:
- Die Bestenlisten aktualisieren sich etwa alle 10 Minuten (GitHub startet geplante Läufe manchmal etwas später).
- „Gerade online“ wird zusätzlich live im Browser über api.mcsrvstat.us abgefragt.
- GitHub pausiert geplante Läufe, wenn 60 Tage lang nichts am Repository geändert wurde. Dann einfach unter Actions wieder aktivieren.

---

## Weg B: Auf deinem PC oder einem VPS

Braucht Node.js 18 oder neuer (nodejs.org). Aktualisiert sich alle 2 Minuten.

1. `config.example.json` kopieren und in `config.json` umbenennen.
2. Die G-Portal-Daten eintragen (`remote` = FTP-Daten, `mcHost`/`mcPort` = Minecraft-Adresse).
3. Im Ordner ausführen:
   ```
   node sync.js      # Test: lädt die Dateien von G-Portal
   node server.js    # startet die Seite
   ```
4. Öffnen: `http://localhost:8080`

Damit andere die Seite sehen, muss der Rechner laufen und erreichbar sein. Auf einem VPS dauerhaft starten:
```
npm install -g pm2
pm2 start server.js --name mcstats && pm2 save && pm2 startup
```

Alternativ `node build.js` – erzeugt den Ordner `dist/`, den du auf jeden normalen Webspace hochladen kannst.

---

## SFTP statt FTP

Zeigt G-Portal SFTP an: `"protocol": "sftp"` (bzw. Secret `FTP_PROTOCOL=sftp`) setzen und – nur bei Weg B – einmal
`npm install ssh2-sftp-client` ausführen. Bei GitHub passiert das automatisch.

## Probleme?

| Meldung | Lösung |
|---|---|
| `FTP-Login fehlgeschlagen` | Benutzer/Passwort von der G-Portal-Statusseite nochmal kopieren |
| `Keine Stats gefunden unter …` | Mit FileZilla prüfen, wo `world/stats` liegt, und `path` bzw. `FTP_PATH` anpassen |
| „Server gerade offline“, obwohl er läuft | `MC_HOST`/`MC_PORT` müssen die Minecraft-Adresse sein, nicht die FTP-Adresse |
| Zahlen hängen hinterher | Minecraft speichert Stats nur beim Autosave (~5 Min) oder Ausloggen |

## Hinweise

- „Diamantenbank“ zählt abgebaute Diamanterze. Wie viele Diamanten jemand besitzt, steht nicht in den Vanilla-Stats.
- Bestenlisten ändern: in `core.js` die Liste `BOARDS` und die Funktion `summarize()`.
