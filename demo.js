/*
 * Beispieldaten für die Vorschau (#demo).
 *
 * Alle Künstler, Hallen und Termine sind erfunden. Die Konzerte haben dieselbe
 * Form wie bei Ticketmaster und laufen durch denselben Kern wie echte Daten.
 */

import { norm, toEvent } from './core.js';

function art(name, hue) {
  const initials = name.split(/\s+/).filter((w) => /^[A-Za-zÄÖÜÅ]/.test(w)).slice(0, 2).map((w) => w[0]).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},85%,58%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,22%)"/>
    </linearGradient></defs>
    <rect width="300" height="300" fill="url(#g)"/>
    <text x="150" y="185" font-family="Arial Black,Arial,sans-serif" font-size="120" font-weight="900" text-anchor="middle" fill="rgba(255,255,255,.92)">${initials}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const ARTISTS = {
  nordlicht: { id: 'demo0nordlicht00000001', name: 'Nordlicht Kollektiv', genres: ['progressive house', 'edm'], hue: 200 },
  kalle: { id: 'demo0kallevagen0000002', name: 'Kalle Vågen', genres: ['swedish house', 'big room'], hue: 320 },
  ferro: { id: 'demo0saintferro0000003', name: 'Saint Ferro', genres: ['german hip hop', 'trap'], hue: 20 },
  lanterns: { id: 'demo0paperlantern00004', name: 'The Paper Lanterns', genres: ['indie rock', 'modern rock'], hue: 45 },
  mira: { id: 'demo0mirasol000000005', name: 'Mira Sol', genres: ['dance pop', 'pop'], hue: 280 },
  rostrot: { id: 'demo0rostrot000000006', name: 'Rostrot', genres: ['deutschrock'], hue: 0 },
  velvet: { id: 'demo0velvetstatic00007', name: 'Velvet Static', genres: ['synthwave', 'electronica'], hue: 250 },
  juno: { id: 'demo0junogezeiten0008', name: 'Juno & die Gezeiten', genres: ['german indie', 'indie pop'], hue: 160 },
};

function spotifyArtist(key) {
  const a = ARTISTS[key];
  return { id: a.id, name: a.name, genres: a.genres, images: [{ url: art(a.name, a.hue), width: 300, height: 300 }] };
}

const VENUES = {
  frankfurt: ['Mainhalle', 'Frankfurt am Main', 'DE', 'Deutschland', 50.1109, 8.6821],
  mainz: ['Rheinbühne', 'Mainz', 'DE', 'Deutschland', 49.9929, 8.2473],
  koeln: ['Domhalle', 'Köln', 'DE', 'Deutschland', 50.9375, 6.9603],
  saarbruecken: ['Kulturwerk', 'Saarbrücken', 'DE', 'Deutschland', 49.2402, 6.9969],
  mannheim: ['Arena am Neckar', 'Mannheim', 'DE', 'Deutschland', 49.4875, 8.466],
  kaiserslautern: ['Kammgarn-Saal', 'Kaiserslautern', 'DE', 'Deutschland', 49.4447, 7.769],
  trier: ['Moselufer', 'Trier', 'DE', 'Deutschland', 49.7499, 6.6371],
  luxemburg: ['Kulturfabrik Süd', 'Luxemburg', 'LU', 'Luxemburg', 49.6116, 6.1319],
  goeteborg: ['Hafenarena', 'Göteborg', 'SE', 'Schweden', 57.7089, 11.9746],
  goeteborgStadion: ['Stadion am Meer', 'Göteborg', 'SE', 'Schweden', 57.7059, 11.9871],
  stockholm: ['Södra Hallen', 'Stockholm', 'SE', 'Schweden', 59.3293, 18.0686],
  amsterdam: ['Havenhal', 'Amsterdam', 'NL', 'Niederlande', 52.3676, 4.9041],
  berlin: ['Spreewerk', 'Berlin', 'DE', 'Deutschland', 52.52, 13.405],
  london: ['Riverside Hall', 'London', 'GB', 'Großbritannien', 51.5072, -0.1276],
};

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inDays(offset, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let counter = 0;
function event({ name, artists = [], venue, offset, time = '20:00:00', genre = 'Dance/Electronic', subGenre = 'House', price, status = 'onsale', saleIn, presaleIn, isNew = false, spotifyLink = false, attractionName }) {
  const v = VENUES[venue];
  const date = day(offset);
  return {
    id: `demo-${counter += 1}`,
    name,
    url: null,
    demoNew: isNew,
    images: artists[0] ? [{ url: art(ARTISTS[artists[0]].name, ARTISTS[artists[0]].hue), width: 300, height: 300, ratio: '1_1' }] : [],
    dates: {
      start: { localDate: date, localTime: time, dateTime: `${date}T${time.slice(0, 5)}:00Z` },
      status: { code: status },
    },
    sales: {
      public: { startDateTime: saleIn != null ? inDays(saleIn) : inDays(-30) },
      presales: presaleIn != null ? [{ name: 'Fan-Presale', startDateTime: inDays(presaleIn), endDateTime: inDays(presaleIn + 2) }] : [],
    },
    priceRanges: price ? [{ min: price, max: price + 40, currency: 'EUR' }] : undefined,
    classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: genre }, subGenre: { name: subGenre } }],
    _embedded: {
      venues: [{
        name: v[0], city: { name: v[1] }, country: { countryCode: v[2], name: v[3] },
        location: { latitude: String(v[4]), longitude: String(v[5]) },
      }],
      attractions: artists.map((key, i) => ({
        name: i === 0 && attractionName ? attractionName : ARTISTS[key].name,
        externalLinks: spotifyLink ? { spotify: [{ url: `https://open.spotify.com/artist/${ARTISTS[key].id}` }] } : undefined,
      })),
    },
  };
}

function buildEvents() {
  counter = 0;
  return [
    event({ name: 'Nordlicht Kollektiv – Polarnacht Tour', artists: ['nordlicht'], venue: 'frankfurt', offset: 40, price: 49, isNew: true }),
    event({ name: 'Nordlicht Kollektiv – VIP Package', artists: ['nordlicht'], venue: 'frankfurt', offset: 40, price: 189 }),
    event({ name: 'Nordlicht Kollektiv – Parkticket', artists: ['nordlicht'], venue: 'frankfurt', offset: 40, price: 15 }),
    event({ name: 'Nordlicht Kollektiv – Polarnacht Tour', artists: ['nordlicht'], venue: 'goeteborg', offset: 75, price: 59 }),
    event({ name: 'Kalle Vågen – Live am Meer', artists: ['kalle'], attractionName: 'Kalle Vagen', spotifyLink: true, venue: 'goeteborgStadion', offset: 120, time: '19:00:00', saleIn: 5, isNew: true, subGenre: 'Progressive House' }),
    event({ name: 'Kalle Vågen', artists: ['kalle'], venue: 'stockholm', offset: 118, saleIn: 5 }),
    event({ name: 'Kalle Vågen', artists: ['kalle'], venue: 'amsterdam', offset: 131, price: 65 }),
    event({ name: 'SAINT FERRO – Eisenzeit Tour', artists: ['ferro'], attractionName: 'SAINT FERRO', venue: 'mainz', offset: 25, genre: 'Hip-Hop/Rap', subGenre: 'Urban', price: 38 }),
    event({ name: 'SAINT FERRO – Eisenzeit Tour', artists: ['ferro', 'juno'], attractionName: 'SAINT FERRO', venue: 'koeln', offset: 27, genre: 'Hip-Hop/Rap', subGenre: 'Urban', price: 42 }),
    event({ name: 'The Paper Lanterns', artists: ['lanterns'], venue: 'saarbruecken', offset: 60, genre: 'Rock', subGenre: 'Indie Rock', presaleIn: 2, saleIn: 4, isNew: true }),
    event({ name: 'Mira Sol – Golden Hour', artists: ['mira'], venue: 'mannheim', offset: 90, genre: 'Pop', subGenre: 'Pop', status: 'offsale' }),
    event({ name: 'Mira Sol – Golden Hour', artists: ['mira'], venue: 'london', offset: 95, genre: 'Pop', subGenre: 'Pop', price: 55 }),
    event({ name: 'Rostrot', artists: ['rostrot'], venue: 'kaiserslautern', offset: 15, genre: 'Rock', subGenre: 'Rock', price: 29 }),
    event({ name: 'Velvet Static – Neon Nights', artists: ['velvet'], venue: 'berlin', offset: 50, price: 34, subGenre: 'Electronic' }),
    event({ name: 'Bassline Nacht', venue: 'frankfurt', offset: 10, time: '23:00:00', subGenre: 'House', price: 18, isNew: true }),
    event({ name: 'Hallo Echo – Techno bis zum Morgen', venue: 'luxemburg', offset: 33, time: '23:30:00', subGenre: 'Techno', price: 22 }),
    event({ name: 'Indie Sommer Open Air 2027', venue: 'trier', offset: 160, genre: 'Alternative', subGenre: 'Indie Rock', price: 69, saleIn: 9 }),
    event({ name: 'Großer Schlagerabend', venue: 'mainz', offset: 20, genre: 'Schlager', subGenre: 'Schlager', price: 45 }),
    event({ name: 'Jazz im Hof', venue: 'kaiserslautern', offset: 12, genre: 'Jazz', subGenre: 'Jazz', price: 25 }),
  ];
}

const TOP = [
  ['nordlicht', 1, '#1 deiner Top-Künstler (letzte 4 Wochen) · 412 Streams'],
  ['kalle', 0.93, '#2 deiner Top-Künstler (letzte 4 Wochen) · 377 Streams'],
  ['ferro', 0.78, '#3 deiner Top-Künstler (letzte 4 Wochen) · 240 Streams'],
  ['lanterns', 0.7, '#4 deiner Top-Künstler (letzte 4 Wochen) · 198 Streams'],
  ['mira', 0.66, '#5 deiner Top-Künstler (letzte 4 Wochen) · 160 Streams'],
  ['rostrot', 0.6, '#1 deiner Top-Künstler (insgesamt) · 2.318 Streams'],
  ['velvet', 0.55, '#3 deiner Top-Künstler (letzte 6 Monate) · 301 Streams'],
  ['juno', 0.4, '#6 deiner Top-Künstler (letzte 6 Monate) · 122 Streams'],
];

export function buildDemoData() {
  const now = Date.now();
  const baseline = now - 10 * 864e5;
  const artists = TOP.map(([key, score, why]) => {
    const a = ARTISTS[key];
    return { key: `sfm:${key}`, name: a.name, norm: norm(a.name), spotifyId: a.id, image: art(a.name, a.hue), genres: a.genres, score, why, url: null };
  });
  const events = buildEvents()
    .map((raw) => {
      const ev = toEvent(raw);
      if (ev) ev.firstSeen = raw.demoNew ? now - 864e5 : baseline - 864e5;
      return ev;
    })
    .filter(Boolean);
  return {
    version: 1,
    ts: now - 3 * 3600e3,
    baseline,
    source: { statsfm: { name: 'beispiel', url: 'https://stats.fm/' } },
    settings: { home: { name: 'Idar-Oberstein', lat: 49.7117, lon: 7.3127, radius: 150 }, places: [], travelKm: 1500, monthsAhead: 12, maxArtists: 60 },
    artists,
    events,
    errors: [],
    stats: { searched: artists.length, tmCalls: 0 },
  };
}
