# Konzertradar

Konzerte und Vorverkäufe, die zu deiner Musik passen – in deiner Nähe und dort,
wo sich die Reise lohnt.

Jeden Morgen holt GitHub deine Top-Künstler von **stats.fm** (also aus deinem
Spotify), sucht bei **Ticketmaster** nach ihren Terminen und nach allem anderen
in deiner Umgebung, und veröffentlicht das Ergebnis als Website. Kommt etwas Neues
dazu, bekommst du eine Benachrichtigung (als GitHub-Issue, das per Mail bzw. Push
in der GitHub-App ankommt).

## Was die Seite zeigt

- **In deiner Nähe** – deine Künstler im Umkreis deiner Orte
  (Standard: Idar-Oberstein, 150 km – Frankfurt, Mainz, Mannheim, Saarbrücken,
  Luxemburg und Köln liegen darin).
- **Lohnt die Reise** – deine Künstler weiter weg (Standard bis 1.500 km, also
  auch Göteborg, Stockholm, London, Amsterdam …), pro Künstler zuerst die
  nächstgelegenen Termine.
- **Entdecken** – andere Konzerte in der Nähe, die zu deinen Genres passen.
- **Neu**, **Vorverkauf startet** (inkl. Presales), **Merkliste** und
  **In Kalender** (.ics).

Mit `#demo` am Ende der Adresse gibt es eine Vorschau mit erfundenen Daten.

## Einrichtung (einmalig, ca. 5 Minuten)

1. **Ticketmaster-Schlüssel:** Auf
   <https://developer-acct.ticketmaster.com/user/register> kostenlos registrieren,
   unter *My Apps* den **Consumer Key** kopieren. Im Repo unter
   *Settings → Secrets and variables → Actions → New repository secret* anlegen:
   Name `TICKETMASTER_KEY`, Wert = der Key.
2. **stats.fm:** In `config.json` bei `"statsfm"` deinen Namen aus der
   Profiladresse eintragen (`stats.fm/name`; die ganze Adresse geht auch).
   In der stats.fm-App unter *Einstellungen → Privatsphäre* müssen die
   Top-Künstler öffentlich sein.
3. **Seite einschalten:** *Settings → Pages → Source:* „GitHub Actions“.
4. **Erster Suchlauf:** *Actions → Konzerte aktualisieren → Run workflow*.
   Nach 1–2 Minuten ist die Seite unter `https://<name>.github.io/konzertradar/`
   erreichbar.

Damit Benachrichtigungen ankommen: in der GitHub-App Push-Benachrichtigungen
erlauben bzw. unter <https://github.com/settings/notifications> E-Mails für
„Watching“ eingeschaltet lassen.

## config.json

| Feld | Bedeutung |
|------|-----------|
| `statsfm` | dein stats.fm-Name oder Profil-Link |
| `home` | Zuhause mit `lat`, `lon` und `radius` in km |
| `places` | weitere Orte, z. B. `{ "name": "Göteborg", "radius": 50 }` – ohne Koordinaten werden sie automatisch gesucht |
| `travelKm` | wie weit weg deine Künstler noch angezeigt werden |
| `monthsAhead` | wie weit im Voraus gesucht wird |
| `maxArtists` | wie viele deiner Top-Künstler einzeln gesucht werden |
| `artists` | Künstler, die immer dabei sein sollen, z. B. `["Swedish House Mafia"]` |
| `notify` | `false` schaltet die Benachrichtigungen ab |

Nach einer Änderung an `config.json` läuft die Suche sofort neu.

## Grenzen

- Ticketmaster kennt nicht jedes Konzert. Viele deutsche Konzerte laufen nur
  über Eventim, das keine offene Schnittstelle hat. In der Künstlerliste gibt
  es deshalb zu jedem Künstler einen Eventim-Suchlink.
- Das Repo ist öffentlich (sonst geht GitHub Pages im kostenlosen Plan nicht),
  damit sind auch die Seite und deine Top-Künstler öffentlich – genau wie dein
  stats.fm-Profil. Der Ticketmaster-Schlüssel bleibt geheim.

## Aufbau

| Datei | Zweck |
|-------|-------|
| `scripts/update.mjs` | Suchlauf bei GitHub: stats.fm → Ticketmaster → `_site/data.json`, Benachrichtigung |
| `core.js` | gemeinsamer Kern für Suchlauf und Seite: Namen abgleichen, Entfernungen, Genres, Einordnen |
| `index.html`, `app.js`, `style.css` | die Seite |
| `demo.js` | erfundene Beispieldaten für `#demo` |
| `.github/workflows/update.yml` | täglicher Lauf und Veröffentlichung |

Lokal ausprobieren (Node 20+):

```sh
TICKETMASTER_KEY=… node scripts/update.mjs
python3 -m http.server 8080 --directory _site
```
