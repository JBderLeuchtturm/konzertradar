/*
 * Gemeinsamer Kern: läuft im Browser (app.js) und bei GitHub (scripts/update.mjs).
 *
 * Hier steht alles, was Konzerte versteht: Namen vergleichen, Entfernungen
 * rechnen, Ticketmaster-Daten eindampfen, Genres zuordnen und jedes Konzert
 * einem der drei Bereiche zuweisen.
 */

export const DAY = 864e5;
export const NEW_FOR = 14 * DAY; // so lange gilt ein Konzert als "neu"

/* ================================================================ Helfer */

/** Vergleichbarer Name: ohne Akzente, ohne "The", ohne Satzzeichen. */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

export function haversine(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Ticketmaster möchte den Ort als Geohash. */
export function geohash(lat, lon, precision = 9) {
  const chars = '0123456789bcdefghjkmnpqrstuvwxyz';
  const latR = [-90, 90];
  const lonR = [-180, 180];
  let hash = '';
  let bits = 0;
  let idx = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lonR : latR;
    const value = even ? lon : lat;
    const mid = (range[0] + range[1]) / 2;
    if (value > mid) { idx = idx * 2 + 1; range[0] = mid; } else { idx *= 2; range[1] = mid; }
    even = !even;
    if (++bits === 5) { hash += chars[idx]; bits = 0; idx = 0; }
  }
  return hash;
}

export function isoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function pickImage(images, target = 160) {
  if (!images?.length) return null;
  const sorted = [...images].filter((i) => i.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= target) || sorted[sorted.length - 1])?.url || null;
}

/* ================================================================ Genres */

export const BUCKETS = [
  ['Dance/Electronic', /house|techno|edm|electro|trance|dubstep|drum and bass|drum & bass|dnb|jungle|garage|dance|big room|hardstyle|bass music|future bass|idm|synthwave|disco|eurodance|melodic bass/],
  ['Hip-Hop/Rap', /hip ?-?hop|rap|trap|drill|grime|boom bap/],
  ['Metal', /metal|metalcore|deathcore|djent|grindcore/],
  ['Rock', /rock|punk|grunge|stoner|shoegaze|post-hardcore/],
  ['Alternative', /indie|alternative|emo|lo-fi|bedroom|new wave/],
  ['Pop', /pop|boy band|girl group/],
  ['R&B', /r&b|rnb|soul|funk/],
  ['Jazz', /jazz|swing|bebop/],
  ['Blues', /blues/],
  ['Klassik', /classical|klassik|orchestra|orchester|baroque|opera|oper|chamber|soundtrack|score/],
  ['Folk', /folk|singer-songwriter|liedermacher|acoustic/],
  ['Country', /country|americana|bluegrass/],
  ['Reggae', /reggae|dancehall|ska\b|dub\b/],
  ['Latin', /latin|reggaeton|salsa|bachata|cumbia|urbano/],
  ['Schlager', /schlager|volksmusik/],
];

export function bucketsFor(text) {
  const t = String(text || '').toLowerCase();
  return BUCKETS.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/**
 * Genre-Profil: wie stark jedes Genre in deiner Musik vorkommt (0..1).
 * `genres` (Liste von Genre-Namen) ersetzt die automatische Auswahl.
 */
export function buildProfile(artists, { hidden = new Set(), genres = null } = {}) {
  const buckets = {};
  const raw = new Map();
  for (const a of artists) {
    if (hidden.has(a.key)) continue;
    for (const g of a.genres || []) {
      raw.set(g, (raw.get(g) || 0) + a.score);
      const bs = bucketsFor(g);
      for (const b of bs) buckets[b] = (buckets[b] || 0) + a.score / bs.length;
    }
  }
  const max = Math.max(0, ...Object.values(buckets));
  const auto = {};
  for (const [b, w] of Object.entries(buckets)) auto[b] = max ? w / max : 0;
  const rawMax = Math.max(0.0001, ...raw.values());
  const rawTop = [...raw.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 40)
    .map(([g, w]) => [norm(g), w / rawMax]);

  let active = auto;
  const manual = Array.isArray(genres);
  if (manual) {
    active = {};
    for (const b of genres) active[b] = 1;
  }
  return { auto, buckets: active, rawTop, manual };
}

export function discoveryScore(ev, profile) {
  const parts = [ev.genre, ev.subGenre].filter((g) => g && !/undefined|other|^music$/i.test(g));
  if (!parts.length) return { score: 0 };
  let score = 0;
  let bucket = null;
  for (const b of bucketsFor(parts.join(' '))) {
    const w = profile.buckets[b] || 0;
    if (w > score) { score = w; bucket = b; }
  }
  let sub = null;
  const subNorm = ev.subGenre && !/undefined|other/i.test(ev.subGenre) ? norm(ev.subGenre) : '';
  if (subNorm && subNorm !== norm(ev.genre) && !profile.manual) {
    for (const [g, w] of profile.rawTop) {
      if (g.includes(subNorm) || subNorm.includes(g)) {
        sub = ev.subGenre;
        score = Math.min(1, score + 0.1 + 0.25 * w);
        break;
      }
    }
  }
  return { score, bucket, sub };
}

/* ================================================================ Ticketmaster-Daten */

export const JUNK = /\b(parking|parken|parkplatz|parkschein|park ?ticket|parkhaus|shuttle|bus ?transfer|gutschein|voucher|gift ?card|upgrade|fast ?lane|locker|schlie(ss|ß)fach|camping ?(ticket|pass)?|merch)\b/i;
export const PACKAGE = /\b(vip|package|paket|premium|hospitality|meet ?(and|&) ?greet|platinum|lounge)\b/i;
export const TRIBUTE = /tribute|hommage|cover ?band|plays the music of|the music of|a tribute to|revival/i;

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['de'], { type: 'region' }); } catch { /* alter Browser */ }

export function countryName(country) {
  const code = country?.countryCode;
  if (code && regionNames) {
    try { return regionNames.of(code) || country.name || code; } catch { /* unbekannter Code */ }
  }
  return country?.name || code || '';
}

function spotifyIdFrom(attraction) {
  for (const link of attraction.externalLinks?.spotify || []) {
    const m = /artist[/:]([A-Za-z0-9]{10,})/.exec(link.url || '');
    if (m) return m[1];
  }
  return null;
}

/** Ticketmaster-Rohdaten auf das Nötigste eindampfen. Gibt null für Abgesagtes und Parktickets. */
export function toEvent(raw) {
  const status = raw.dates?.status?.code || '';
  if (/cancel/i.test(status)) return null;
  if (JUNK.test(raw.name || '')) return null;
  const venue = raw._embedded?.venues?.[0] || {};
  const lat = Number(venue.location?.latitude);
  const lon = Number(venue.location?.longitude);
  const cls = raw.classifications?.find((c) => c.primary) || raw.classifications?.[0] || {};
  const price = raw.priceRanges?.[0];
  const start = raw.dates?.start || {};
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url || null,
    date: start.localDate || null,
    time: start.noSpecificTime || start.timeTBA ? null : start.localTime || null,
    dateTime: start.dateTime || null,
    status,
    venue: venue.name || '',
    city: venue.city?.name || '',
    country: venue.country?.countryCode || '',
    countryName: countryName(venue.country),
    lat: Number.isFinite(lat) && venue.location ? lat : null,
    lon: Number.isFinite(lon) && venue.location ? lon : null,
    segment: cls.segment?.name || '',
    genre: cls.genre?.name || '',
    subGenre: cls.subGenre?.name || '',
    attractions: (raw._embedded?.attractions || []).map((a) => ({
      name: a.name,
      spotifyId: spotifyIdFrom(a),
      image: pickImage(a.images, 200),
    })),
    image: pickImage(raw.images, 200),
    saleStart: raw.sales?.public?.startTBD ? null : raw.sales?.public?.startDateTime || null,
    presales: (raw.sales?.presales || [])
      .filter((p) => p.startDateTime)
      .map((p) => ({ name: p.name || 'Presale', start: p.startDateTime, end: p.endDateTime || null })),
    price: price && Number.isFinite(Number(price.min)) ? { min: Number(price.min), max: Number(price.max), currency: price.currency } : null,
  };
}

export function saleInfo(ev, now = Date.now()) {
  const pre = (ev.presales || [])
    .filter((p) => Date.parse(p.start) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const pub = ev.saleStart && Date.parse(ev.saleStart) > now ? ev.saleStart : null;
  const upcoming = pre && (!pub || Date.parse(pre.start) < Date.parse(pub)) ? pre.start : pub;
  return { pre, pub, upcoming };
}

export function isNew(ev, data, now = Date.now()) {
  return !!ev.firstSeen && data.baseline != null && ev.firstSeen > data.baseline && now - ev.firstSeen < NEW_FOR;
}

/* ================================================================ Einordnen */

/**
 * Ordnet jedes Konzert ein:
 *   near     – einer deiner Künstler im Umkreis eines deiner Orte
 *   travel   – einer deiner Künstler weiter weg, bis travelKm von zuhause
 *   discover – anderes Konzert in der Nähe, das zu deinen Genres passt
 * Alles andere fällt raus. Doppelte Einträge (VIP-Pakete) werden zusammengefasst.
 */
export function classify(data, { home, places = [], travelKm = 1500, genres = null, hidden = new Set(), now = Date.now() } = {}) {
  const byId = new Map();
  const byName = new Map();
  for (const a of data.artists || []) {
    if (hidden.has(a.key)) continue;
    if (a.spotifyId && !byId.has(a.spotifyId)) byId.set(a.spotifyId, a);
    if (!byName.has(a.norm)) byName.set(a.norm, a);
  }
  const profile = buildProfile(data.artists || [], { hidden, genres });
  const allPlaces = [home, ...places].filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const today = todayISO(new Date(now));
  const out = [];

  for (const ev of data.events || []) {
    if (ev.date && ev.date < today) continue;

    let artist = null;
    let support = false;
    ev.attractions.forEach((att, i) => {
      if (artist) return;
      const hit = (att.spotifyId && byId.get(att.spotifyId)) || byName.get(norm(att.name));
      if (hit) { artist = hit; support = i > 0; }
    });
    if (!artist && !ev.attractions.length && !TRIBUTE.test(ev.name)) {
      // Ohne eingetragene Künstler: Titel wie "Name – Tour 2027" prüfen.
      artist = byName.get(norm(String(ev.name).split(/\s[-–—:|@]\s|:\s/)[0])) || null;
    }

    const located = ev.lat != null && ev.lon != null;
    const dHome = located && home ? haversine(home, ev) : null;
    let near = null;
    if (located) {
      for (const place of allPlaces) {
        const d = haversine(place, ev);
        if (d <= place.radius) { near = { place, d }; break; }
      }
    }

    let section = null;
    let score = 0;
    let disc = null;
    if (artist) {
      if (near) {
        section = 'near';
        score = 60 + 40 * artist.score - (support ? 10 : 0);
      } else if (dHome == null || dHome <= travelKm) {
        section = 'travel';
        score = 25 + 55 * artist.score - Math.min(15, (dHome || 0) / 150) - (support ? 10 : 0);
      }
    } else if (near && /music|musik/i.test(ev.segment || 'music') && !TRIBUTE.test(ev.name)) {
      disc = discoveryScore(ev, profile);
      if (disc.score >= 0.35) {
        section = 'discover';
        score = 45 * disc.score;
      }
    }
    if (!section) continue;
    out.push({ ...ev, section, score, artist, support, near, dHome, disc, isNew: isNew(ev, data, now), sale: saleInfo(ev, now) });
  }

  const best = new Map();
  const rank = (e) => (PACKAGE.test(e.name) ? 1000 : 0) + e.name.length;
  for (const ev of out) {
    const k = `${ev.artist?.key || norm(ev.name)}|${ev.date}|${norm(ev.venue)}`;
    const prev = best.get(k);
    if (!prev || rank(ev) < rank(prev)) best.set(k, ev);
  }
  return [...best.values()];
}
