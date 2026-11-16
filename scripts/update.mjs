#!/usr/bin/env node
/*
 * Sucht die Konzerte und baut die Seite.
 *
 * Läuft jeden Morgen bei GitHub (siehe .github/workflows/update.yml):
 *   1. Holt deine Top-Künstler und -Songs von stats.fm (öffentliches Profil, kein Login).
 *   2. Sucht bei Ticketmaster nach ihren Terminen und nach allem in der Nähe deiner Orte.
 *   3. Schreibt _site/data.json und kopiert die Seite nach _site/.
 *   4. Gibt es neue Konzerte für dich, legt es ein GitHub-Issue an – das kommt
 *      als Mail bzw. als Push in der GitHub-App bei dir an.
 *
 * Lokal:  TICKETMASTER_KEY=… node scripts/update.mjs   (danach _site/ ansehen)
 */

import { copyFile, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  addMonths, classify, fromEventim, geohash, haversine, isoNoMs, linksOf, norm, toEvent, todayISO,
} from '../core.js';
import { CITIES } from './cities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, process.env.OUT_DIR || '_site');
const SITE_FILES = ['index.html', 'app.js', 'core.js', 'demo.js', 'style.css', 'icon.svg', 'manifest.webmanifest'];

const STATSFM_API = process.env.STATSFM_API || 'https://api.stats.fm/api/v1';
const TM_API = process.env.TM_API || 'https://app.ticketmaster.com/discovery/v2/events.json';
const EVENTIM_API = process.env.EVENTIM_API || 'https://public-api.eventim.com/websearch/search/api/exploration/v1/products';
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const GEOCODER = process.env.GEOCODER || 'https://nominatim.openstreetmap.org/search';
const TM_KEY = (process.env.TICKETMASTER_KEY || '').trim();
const REPO = process.env.GITHUB_REPOSITORY || '';
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const log = (...args) => console.log(...args);
const warn = (text) => { errors.push(text); console.warn(`⚠ ${text}`); };

/* ================================================================ Einstellungen */

const DEFAULTS = {
  statsfm: '',
  home: { name: 'Idar-Oberstein', lat: 49.7117, lon: 7.3127, radius: 150 },
  places: [],
  travelKm: 1500,
  monthsAhead: 12,
  maxArtists: 60,
  artists: [],
  notify: true,
};

const config = { ...DEFAULTS, ...JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8')) };
config.home = { ...DEFAULTS.home, ...config.home };
config.places = Array.isArray(config.places) ? config.places : [];
config.artists = Array.isArray(config.artists) ? config.artists.filter((a) => typeof a === 'string' && a.trim()) : [];
const statsfmUser = parseStatsfmUser(config.statsfm);

function pagesUrl() {
  if (process.env.PAGES_URL) return process.env.PAGES_URL.replace(/\/?$/, '/');
  if (!REPO.includes('/')) return null;
  const [owner, name] = REPO.split('/');
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

function parseStatsfmUser(value) {
  const v = String(value || '').trim();
  if (!v || /DEIN|HIER|<|beispiel/i.test(v)) return '';
  // Erlaubt: "name", "stats.fm/name", "https://stats.fm/user/name"
  const m = /stats\.fm\/(?:user\/)?([^/?#\s]+)/i.exec(v);
  return decodeURIComponent(m ? m[1] : v.replace(/^@/, ''));
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/* ================================================================ Netz */

async function getJson(url, { headers = {}, tries = 3, what = url } = {}) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`${what}: Fehler ${response.status}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        const error = new Error(`${what}: Fehler ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.status) throw error;
      last = error;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw last;
}

/* ================================================================ Orte */

async function resolvePlace(place, label) {
  if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) return { radius: 50, ...place };
  if (!place.name) return null;
  try {
    const url = `${GEOCODER}?format=jsonv2&limit=1&accept-language=de&q=${encodeURIComponent(place.name)}`;
    const [hit] = await getJson(url, { headers: { 'User-Agent': 'konzertradar/1.0' }, what: 'Ortssuche' });
    if (!hit) throw new Error('nicht gefunden');
    log(`Ort ${place.name} → ${Number(hit.lat).toFixed(3)}, ${Number(hit.lon).toFixed(3)}`);
    return { radius: 50, ...place, lat: Number(hit.lat), lon: Number(hit.lon) };
  } catch (error) {
    warn(`${label} „${place.name}“ konnte nicht gefunden werden (${error.message}). Trag lat und lon in config.json ein.`);
    return null;
  }
}

/* ================================================================ stats.fm */

const RANGES = [
  ['weeks', 1, 'letzte 4 Wochen'],
  ['months', 0.85, 'letzte 6 Monate'],
  ['lifetime', 0.65, 'insgesamt'],
];

async function loadTaste() {
  const map = new Map();
  let profile = null;

  function add(artist, weight, reason) {
    if (!artist?.name) return;
    const key = artist.id ? `sfm:${artist.id}` : `n:${norm(artist.name)}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { key, name: artist.name, norm: norm(artist.name), spotifyId: null, image: null, genres: [], raw: 0, reasons: [] };
      map.set(key, entry);
    }
    entry.raw += weight;
    entry.spotifyId ||= artist.externalIds?.spotify?.[0] || null;
    entry.image ||= artist.image || null;
    for (const g of artist.genres || []) if (!entry.genres.includes(g)) entry.genres.push(g);
    if (reason) entry.reasons.push({ w: weight, text: reason });
  }

  if (statsfmUser) {
    const base = `${STATSFM_API}/users/${encodeURIComponent(statsfmUser)}`;
    try {
      profile = (await getJson(base, { what: 'stats.fm-Profil' })).item || null;
      log(`stats.fm: ${profile?.displayName || statsfmUser}`);
    } catch (error) {
      warn(error.status === 404
        ? `stats.fm-Profil „${statsfmUser}“ gibt es nicht. Prüf den Namen in config.json (steht in der Adresse deines Profils: stats.fm/…).`
        : `stats.fm-Profil „${statsfmUser}“ nicht abrufbar (${error.message}).`);
      if (error.status === 404) return finish(map, null);
    }
    const id = profile?.id || statsfmUser;
    const userUrl = `${STATSFM_API}/users/${encodeURIComponent(id)}`;
    let gotAny = false;
    for (const [range, weight, label] of RANGES) {
      try {
        const json = await getJson(`${userUrl}/top/artists?range=${range}&limit=50`, { what: `stats.fm Top-Künstler (${label})` });
        (json.items || []).forEach((item, i) => {
          const pos = item.position || i + 1;
          const streams = item.streams ? ` · ${item.streams.toLocaleString('de-DE')} Streams` : '';
          add(item.artist, weight * (1 - i / 70), `#${pos} deiner Top-Künstler (${label})${streams}`);
        });
        if (json.items?.length) gotAny = true;
      } catch (error) {
        if (range === 'weeks') {
          warn(error.status === 403
            ? 'stats.fm gibt deine Top-Künstler nicht heraus – stell in der stats.fm-App unter Einstellungen → Privatsphäre „Top-Künstler“ auf öffentlich.'
            : error.message);
          if (error.status === 403 || error.status === 404) break;
        } else {
          log(`  (${error.message} – wird übersprungen)`);
        }
      }
      try {
        const json = await getJson(`${userUrl}/top/tracks?range=${range}&limit=50`, { what: `stats.fm Top-Songs (${label})` });
        (json.items || []).forEach((item, i) => {
          (item.track?.artists || []).forEach((a, j) => add(a, weight * (j === 0 ? 0.3 : 0.12) * (1 - i / 70), `in deinen Top-Songs (${label})`));
        });
      } catch {
        // Top-Songs sind nur ein Zusatz.
      }
      await sleep(300);
    }
    if (profile && !gotAny) warn('stats.fm hat keine Top-Künstler geliefert. Ist dein Profil öffentlich und hat stats.fm schon Daten von dir?');
  } else {
    warn('Kein stats.fm-Name in config.json eingetragen – es zählen nur die Künstler unter "artists".');
  }
  return finish(map, profile);
}

/** Gewichte auf 0..1 bringen und die eigenen Künstler aus config.json dazunehmen. */
function finish(map, profile) {
  const artists = [...map.values()];
  const max = Math.max(0.0001, ...artists.map((a) => a.raw));
  for (const a of artists) {
    a.score = Math.round((a.raw / max) * 1000) / 1000;
    a.reasons.sort((x, y) => y.w - x.w);
    a.why = a.reasons[0]?.text || '';
    a.url = a.spotifyId ? `https://open.spotify.com/artist/${a.spotifyId}` : null;
    delete a.raw;
    delete a.reasons;
  }
  for (const name of config.artists) {
    const n = norm(name);
    const existing = artists.find((a) => a.norm === n);
    if (existing) {
      existing.score = Math.max(existing.score, 0.8);
      existing.manual = true;
    } else {
      artists.push({ key: `n:${n}`, name: name.trim(), norm: n, spotifyId: null, image: null, genres: [], url: null, score: 0.8, why: 'von dir eingetragen', manual: true });
    }
  }
  artists.sort((a, b) => b.score - a.score);
  return {
    artists,
    profile: profile ? {
      name: profile.displayName || statsfmUser,
      url: `https://stats.fm/${encodeURIComponent(profile.customId || statsfmUser)}`,
      image: profile.image || null,
    } : null,
  };
}

/* ================================================================ Ticketmaster */

let lastTmCall = 0;
let tmCalls = 0;

async function tmEvents(params) {
  const query = new URLSearchParams({
    apikey: TM_KEY,
    locale: '*', // sonst fehlen Konzerte, die nur auf Deutsch oder Schwedisch eingetragen sind
    size: '100',
    sort: 'date,asc',
    startDateTime: isoNoMs(new Date()),
    endDateTime: isoNoMs(addMonths(new Date(), config.monthsAhead)),
    ...params,
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = 250 - (Date.now() - lastTmCall); // Ticketmaster erlaubt 5 Anfragen pro Sekunde
    if (wait > 0) await sleep(wait);
    lastTmCall = Date.now();
    tmCalls += 1;
    let response;
    try {
      response = await fetch(`${TM_API}?${query}`);
    } catch {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (response.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (response.status === 401 || response.status === 403) {
      const error = new Error('Ticketmaster lehnt den Schlüssel ab. Prüf das Secret TICKETMASTER_KEY (Settings → Secrets and variables → Actions).');
      error.fatal = true;
      throw error;
    }
    if (!response.ok) throw new Error(`Ticketmaster: Fehler ${response.status}`);
    const json = await response.json();
    return { events: json._embedded?.events || [], page: json.page || {} };
  }
  throw new Error('Ticketmaster nicht erreichbar.');
}

async function searchTicketmaster(toQuery, places) {
  const raw = new Map();
  let worked = false;

  for (const [i, artist] of toQuery.entries()) {
    try {
      const { events } = await tmEvents({ keyword: artist.name, classificationName: 'music' });
      worked = true;
      for (const ev of events) raw.set(ev.id, ev);
      if (events.length) log(`  ${String(i + 1).padStart(3)}. ${artist.name}: ${events.length} Treffer`);
    } catch (error) {
      if (error.fatal) throw error;
      warn(`${artist.name}: ${error.message}`);
    }
  }

  for (const place of places) {
    for (let page = 0; page < 3; page += 1) {
      try {
        const result = await tmEvents({
          geoPoint: geohash(place.lat, place.lon, 9),
          radius: String(Math.round(place.radius)),
          unit: 'km',
          classificationName: 'music',
          size: '200',
          page: String(page),
        });
        worked = true;
        for (const ev of result.events) raw.set(ev.id, ev);
        log(`  Umgebung ${place.name}, Seite ${page + 1}: ${result.events.length} Konzerte`);
        if (page + 1 >= (Number(result.page.totalPages) || 1)) break;
      } catch (error) {
        if (error.fatal) throw error;
        warn(`Umgebung ${place.name}: ${error.message}`);
        break;
      }
    }
  }
  if (!worked && (toQuery.length || places.length)) throw new Error('Ticketmaster hat auf keine Anfrage geantwortet.');
  return [...raw.values()].map(toEvent).filter(Boolean);
}

/* ================================================================ Eventim */

// Eventim hat keine offizielle Schnittstelle. Die Suche unten ist dieselbe, die
// eventim.de selbst benutzt – öffentlich und ohne Schlüssel, kann sich aber ohne
// Vorwarnung ändern. Fällt sie aus, läuft alles andere normal weiter.

let lastEventimCall = 0;
let eventimCalls = 0;
let eventimSampleLogged = false;

async function eventimProducts(params) {
  const query = new URLSearchParams({ webId: 'web__eventim-de', language: 'de', page: '1', sort: 'DateAsc', top: '50' });
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) { query.delete(key); for (const v of value) query.append(key, v); } else query.set(key, value);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wait = 400 - (Date.now() - lastEventimCall); // höchstens 2–3 Anfragen pro Sekunde
    if (wait > 0) await sleep(wait);
    lastEventimCall = Date.now();
    eventimCalls += 1;
    let response;
    try {
      response = await fetch(`${EVENTIM_API}?${query}`, {
        headers: { Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', 'User-Agent': 'konzertradar/1.0' },
      });
    } catch {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (response.status === 429 || response.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`Eventim blockiert die Abfrage (${response.status}).`);
      error.fatal = true;
      throw error;
    }
    if (!response.ok) throw new Error(`Eventim: Fehler ${response.status}`);
    const json = await response.json();
    const products = Array.isArray(json.products) ? json.products : [];
    if (!eventimSampleLogged && products.length) {
      eventimSampleLogged = true;
      log(`  Eventim-Beispiel: ${JSON.stringify(products[0]).slice(0, 1500)}`);
    }
    return { products, totalPages: Number(json.totalPages) || 1, total: Number(json.totalResults) || products.length };
  }
  throw new Error('Eventim nicht erreichbar.');
}

/** Städte (wie Eventim sie schreibt) im Umkreis deiner Orte. */
function citiesNear(places) {
  const names = new Set();
  for (const city of CITIES) {
    if (places.some((p) => haversine(p, city) <= p.radius)) for (const n of city.names) names.add(n);
  }
  return [...names];
}

async function searchEventim(toQuery, places) {
  const raw = new Map();
  let worked = false;
  let failed = 0;
  let firstError = '';
  const start = new Date();
  const end = addMonths(start, config.monthsAhead);
  const range = { date_from: todayISO(start), date_to: todayISO(end) };

  for (const [i, artist] of toQuery.entries()) {
    try {
      const { products } = await eventimProducts({ search_term: artist.name, ...range });
      worked = true;
      for (const p of products) raw.set(p.productId, p);
      if (products.length) log(`  ${String(i + 1).padStart(3)}. ${artist.name}: ${products.length} Treffer`);
    } catch (error) {
      if (error.fatal) throw error;
      failed += 1;
      firstError ||= error.message;
      if (!worked && failed >= 3) throw new Error(`Eventim antwortet nicht (${firstError}).`);
    }
  }

  // Umgebung: alle Konzerte in den Städten rund um deine Orte, in Zwei-Monats-Stücken,
  // weil Eventim pro Suche nur begrenzt viele Treffer liefert.
  const cities = citiesNear(places);
  if (cities.length) log(`  Eventim-Umgebung: ${cities.length} Städte`);
  for (let from = new Date(start); from < end; from = addMonths(from, 2)) {
    const to = new Date(Math.min(addMonths(from, 2).getTime() - 864e5, end.getTime()));
    for (let c = 0; c < cities.length; c += 15) {
      const chunk = cities.slice(c, c + 15);
      for (let page = 1; page <= 2; page += 1) {
        try {
          const result = await eventimProducts({
            city_names: chunk, categories: ['Konzerte', 'Festivals'],
            date_from: todayISO(from), date_to: todayISO(to), page: String(page),
          });
          worked = true;
          for (const p of result.products) raw.set(p.productId, p);
          if (page >= result.totalPages) break;
        } catch (error) {
          if (error.fatal) throw error;
          failed += 1;
          firstError ||= error.message;
          break;
        }
      }
    }
  }
  if (failed) warn(`Eventim: ${failed} Suchen fehlgeschlagen (${firstError}).`);
  if (!worked && (toQuery.length || cities.length)) throw new Error('Eventim hat auf keine Anfrage geantwortet.');
  return [...raw.values()].map(fromEventim).filter(Boolean);
}

/* ================================================================ Benachrichtigung */

const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtSale = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

function line(ev) {
  const who = ev.artist?.name || ev.attractions[0]?.name || ev.name;
  const day = ev.date ? fmtDay.format(new Date(`${ev.date}T12:00:00Z`)) : 'Datum folgt';
  const where = [ev.venue, ev.city, ev.country !== 'DE' ? ev.countryName : ''].filter(Boolean).join(', ');
  const atPlace = ev.near && ev.near.place !== config.home && ev.near.place.name !== config.home.name;
  const dist = atPlace ? ` (bei ${ev.near.place.name})` : ev.dHome != null ? ` (${Math.round(ev.dHome).toLocaleString('de-DE')} km)` : '';
  const sale = ev.sale.upcoming ? ` · Vorverkauf ab ${fmtSale.format(new Date(ev.sale.upcoming))}` : '';
  const links = linksOf(ev);
  const link = links.length ? ` · ${links.map((l) => `[${l.source}](${l.url})`).join(' · ')}` : '';
  return `- **${who}** – ${day} · ${where}${dist}${sale}${link}`;
}

function digest(list, site) {
  const groups = [
    ['near', 'In deiner Nähe'],
    ['travel', 'Lohnt die Reise'],
    ['discover', 'Entdecken'],
  ];
  let body = '';
  for (const [section, title] of groups) {
    const items = list.filter((e) => e.section === section).sort((a, b) => b.score - a.score).slice(0, 15);
    if (items.length) body += `\n**${title}**\n${items.map(line).join('\n')}\n`;
  }
  if (site) body += `\nAlles auf einen Blick: ${site}\n`;
  return body;
}

async function github(path, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function notify(fresh, site) {
  if (!fresh.length || config.notify === false) return;
  if (!GH_TOKEN || !REPO) { log('(Keine Benachrichtigung – läuft nicht bei GitHub.)'); return; }
  const names = [...new Set(fresh.map((e) => e.artist?.name || e.attractions[0]?.name || e.name))];
  const title = `🎫 ${fresh.length} neue${fresh.length === 1 ? 's Konzert' : ' Konzerte'}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''}`;
  try {
    // Ältere Hinweise schließen, damit nur der aktuelle offen ist.
    const open = await github(`/repos/${REPO}/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}&per_page=50`);
    for (const issue of open || []) {
      if (issue.title.startsWith('🎫')) await github(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    }
    const body = `Seit dem letzten Suchlauf neu angekündigt:\n${digest(fresh, site)}\n<sub>Automatisch vom Konzertradar. Abschalten: in config.json "notify": false.</sub>`;
    const issue = await github(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title: title.slice(0, 250), body }) });
    log(`Benachrichtigung: ${issue.html_url}`);
  } catch (error) {
    warn(`Benachrichtigung ging nicht raus (${error.message}).`);
  }
}

/* ================================================================ Ablauf */

async function previousData(site) {
  if (process.env.PREV_DATA) {
    try { return JSON.parse(await readFile(process.env.PREV_DATA, 'utf8')); } catch { return null; }
  }
  if (!site) return null;
  try {
    const response = await fetch(`${site}data.json`, { headers: { 'Cache-Control': 'no-cache' } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const now = Date.now();
  const site = pagesUrl();
  await mkdir(OUT, { recursive: true });
  for (const file of SITE_FILES) await copyFile(join(ROOT, file), join(OUT, file));

  const home = (await resolvePlace(config.home, 'Zuhause')) || DEFAULTS.home;
  const places = [];
  for (const p of config.places) {
    const resolved = await resolvePlace(p, 'Ort');
    if (resolved) places.push(resolved);
  }
  const allPlaces = [home, ...places];
  const configHash = hash(JSON.stringify([statsfmUser, home, places, config.maxArtists, config.monthsAhead, config.artists]));

  const prev = await previousData(site);
  const sameScope = prev && prev.configHash === configHash;
  const baseline = sameScope && prev.baseline ? prev.baseline : now;
  const firstSeen = new Map((sameScope ? prev.events : []).map((e) => [e.id, e.firstSeen]));

  log('Lade deinen Geschmack von stats.fm …');
  const { artists, profile } = await loadTaste();
  log(`${artists.length} Künstler, gesucht werden die obersten ${Math.min(artists.length, config.maxArtists)}.`);

  const toQuery = artists.slice(0, config.maxArtists);
  const searched = toQuery.length;
  const sources = [];
  const prevEvents = prev?.events || [];

  async function runSource(name, search) {
    log(`Suche Konzerte bei ${name} …`);
    try {
      const found = await search();
      sources.push({ name, ok: true, found: found.length });
      return found;
    } catch (error) {
      warn(`${name}: ${error.message}`);
      // Lieber die Konzerte vom letzten Mal zeigen als gar keine.
      const old = prevEvents.filter((e) => (e.source || 'Ticketmaster') === name);
      if (old.length) warn(`${name}: Es werden die Konzerte vom letzten erfolgreichen Suchlauf gezeigt.`);
      sources.push({ name, ok: false, found: old.length, reused: old.length > 0 });
      return old;
    }
  }

  let found = [];
  if (TM_KEY) {
    found = found.concat(await runSource('Ticketmaster', () => searchTicketmaster(toQuery, allPlaces)));
  } else {
    warn('Der Ticketmaster-Schlüssel fehlt. Leg ihn als Secret TICKETMASTER_KEY an (Settings → Secrets and variables → Actions).');
    sources.push({ name: 'Ticketmaster', ok: false, found: 0 });
  }
  if (config.eventim !== false) found = found.concat(await runSource('Eventim', () => searchEventim(toQuery, allPlaces)));

  // Nur behalten, was überhaupt in Frage kommt: deine Künstler (egal wo) oder in der Nähe eines Ortes.
  const names = new Set(artists.map((a) => a.norm));
  const ids = new Set(artists.map((a) => a.spotifyId).filter(Boolean));
  const today = todayISO();
  const events = [];
  const kept = new Set();
  for (const ev of found) {
    if (kept.has(ev.id) || (ev.date && ev.date < today)) continue;
    const mine = ev.attractions.some((a) => names.has(norm(a.name)) || (a.spotifyId && ids.has(a.spotifyId)))
      || names.has(norm(String(ev.name).split(/\s[-–—:|@]\s|:\s/)[0]));
    const near = ev.lat != null && allPlaces.some((p) => haversine(p, ev) <= p.radius);
    if (!mine && !near) continue;
    ev.firstSeen = firstSeen.get(ev.id) || ev.firstSeen || now;
    kept.add(ev.id);
    events.push(ev);
  }
  for (const src of sources) src.kept = events.filter((e) => (e.source || 'Ticketmaster') === src.name).length;
  log(`Quellen: ${sources.map((s) => `${s.name} ${s.ok ? `${s.kept} Konzerte` : 'ausgefallen'}`).join(', ')}`);

  const data = {
    version: 1,
    ts: now,
    baseline,
    configHash,
    source: profile ? { statsfm: profile } : {},
    settings: { home, places, travelKm: config.travelKm, monthsAhead: config.monthsAhead, maxArtists: config.maxArtists },
    artists,
    events,
    errors,
    stats: { searched, tmCalls, eventimCalls, sources },
  };
  await writeFile(join(OUT, 'data.json'), JSON.stringify(data));

  const list = classify(data, { home, places, travelKm: config.travelKm, now });
  // Gemeldet wird nur, was in diesem Lauf zum ersten Mal auftaucht – sonst käme
  // dasselbe Konzert zwei Wochen lang jeden Morgen wieder.
  const fresh = list.filter((e) => e.firstSeen === now && now > baseline && (e.section !== 'discover' || e.disc.score >= 0.7));
  const count = (s) => list.filter((e) => e.section === s).length;
  const summary = `## Konzertradar\n\n${list.length} Konzerte für dich – ${count('near')} in der Nähe, ${count('travel')} weiter weg, ${count('discover')} zum Entdecken. ${fresh.length} davon neu.\n${fresh.length ? digest(fresh, site) : ''}${errors.length ? `\n**Hinweise**\n${errors.map((e) => `- ${e}`).join('\n')}\n` : ''}`;
  log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);

  await notify(fresh, site);
}

await main();
