/*
 * Konzertradar – die Seite.
 *
 * Die Suche selbst läuft jeden Morgen bei GitHub (scripts/update.mjs) und legt
 * data.json neben diese Seite. Hier wird nur noch angezeigt, gefiltert,
 * gemerkt und in den Kalender gelegt. Es gibt keine Schlüssel im Browser.
 */

import { BUCKETS, buildProfile, classify, linksOf, norm, saleInfo, todayISO } from './core.js';

const LS = {
  prefs: 'konzertradar.prefs',
  saved: 'konzertradar.saved',
  hidden: 'konzertradar.hidden',
};

/* ================================================================ Speicher */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* privater Modus o. ä. */ }
}

let prefs = { travelKm: null, genres: null, ...load(LS.prefs, {}) };
let saved = load(LS.saved, {});
let hidden = new Set(load(LS.hidden, []));

const state = {
  view: 'feed',
  data: null,
  loading: true,
  loadError: null,
  demo: false,
  chip: 'foryou',
  query: '',
  expand: {},
  tripOpen: new Set(),
};

/** Aus https://name.github.io/repo/ die GitHub-Adressen ableiten. */
const repo = (() => {
  const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return null;
  const first = location.pathname.split('/').filter(Boolean)[0];
  const name = first && !/\.html?$/.test(first) ? first : `${m[1]}.github.io`;
  const base = `https://github.com/${m[1]}/${name}`;
  return {
    base,
    config: `${base}/edit/main/config.json`,
    actions: `${base}/actions/workflows/update.yml`,
    secrets: `${base}/settings/secrets/actions`,
    pages: `${base}/settings/pages`,
    issues: `${base}/issues`,
  };
})();

/* ================================================================ Helfer */

const DAY = 864e5;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const fmtMonth = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const fmtMonthLong = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
const fmtSale = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

const localDate = (iso) => new Date(`${iso}T12:00:00`);

function dayParts(ev) {
  if (!ev.date) return { wd: '', d: 'TBA', m: '', y: '' };
  const d = localDate(ev.date);
  return {
    wd: fmtWeekday.format(d).replace('.', ''),
    d: String(d.getDate()),
    m: fmtMonth.format(d).replace('.', ''),
    y: d.getFullYear() === new Date().getFullYear() ? '' : String(d.getFullYear()),
  };
}

function whenText(ev) {
  if (!ev.date) return 'Datum folgt';
  const day = fmtDay.format(localDate(ev.date));
  return ev.time ? `${day}, ${ev.time.slice(0, 5)} Uhr` : day;
}

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 3600e3) return `vor ${Math.max(1, Math.round(diff / 60e3))} Min.`;
  if (diff < DAY) return `vor ${Math.round(diff / 3600e3)} Std.`;
  const days = Math.round(diff / DAY);
  return days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

function money(price) {
  if (!price || !Number.isFinite(price.min)) return '';
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: price.currency || 'EUR', maximumFractionDigits: 0 }).format(price.min);
  } catch {
    return `${Math.round(price.min)} ${price.currency || ''}`.trim();
  }
}

let toastTimer = null;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

/* ================================================================ Daten */

async function loadData() {
  state.loading = true;
  try {
    const response = await fetch(`./data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'missing' : `Fehler ${response.status}`);
    state.data = await response.json();
    state.loadError = null;
  } catch (error) {
    state.data = null;
    state.loadError = error.message;
  } finally {
    state.loading = false;
  }
}

function settings() {
  const s = state.data?.settings || {};
  return {
    home: s.home || { name: 'Zuhause', lat: 0, lon: 0, radius: 150 },
    places: s.places || [],
    travelKm: prefs.travelKm ?? s.travelKm ?? 2500,
    configTravelKm: s.travelKm ?? 2500,
  };
}

let classifiedCache = null;

function classified() {
  const d = state.data;
  if (!d) return [];
  const s = settings();
  const key = JSON.stringify([d.ts, s.travelKm, prefs.genres, [...hidden], todayISO()]);
  if (classifiedCache?.key === key) return classifiedCache.list;
  const list = classify(d, { home: s.home, places: s.places, travelKm: s.travelKm, genres: prefs.genres, hidden });
  classifiedCache = { key, list };
  return list;
}

function profile() {
  return state.data ? buildProfile(state.data.artists || [], { hidden, genres: prefs.genres }) : { auto: {}, buckets: {} };
}

/* ================================================================ Kalender */

function icsDate(ev) {
  if (ev.dateTime) {
    const start = new Date(ev.dateTime);
    const end = new Date(start.getTime() + 3 * 3600e3);
    const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return [`DTSTART:${f(start)}`, `DTEND:${f(end)}`];
  }
  const next = localDate(ev.date);
  next.setDate(next.getDate() + 1);
  return [`DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${todayISO(next).replace(/-/g, '')}`];
}

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
}

function downloadIcs(ev) {
  if (!ev.date) { toast('Für dieses Konzert steht noch kein Datum fest.'); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const who = ev.artist?.name || ev.attractions?.[0]?.name || ev.name;
  const title = norm(ev.name) !== norm(who) ? `${who} – ${ev.name}` : ev.name;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Konzertradar//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.id}@konzertradar`,
    `DTSTAMP:${stamp}`,
    ...icsDate(ev),
    `SUMMARY:${icsEscape(title)}`,
    `LOCATION:${icsEscape([ev.venue, ev.city, ev.countryName].filter(Boolean).join(', '))}`,
    linksOf(ev)[0] ? `URL:${linksOf(ev)[0].url}` : null,
    `DESCRIPTION:${icsEscape(linksOf(ev).length ? linksOf(ev).map((l) => `Tickets (${l.source}): ${l.url}`).join('\n') : 'Gefunden mit dem Konzertradar')}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${norm(title).replace(/ /g, '-').slice(0, 50) || 'konzert'}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ================================================================ Darstellung */

const app = document.getElementById('app');
const VIEWS = ['feed', 'artists', 'settings'];

function render() {
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.view === state.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  let html = '';
  if (state.demo) {
    html += `<div class="demo-banner"><span>Beispieldaten – erfundene Künstler und Termine, damit du siehst, wie es aussieht.</span>
      <button class="btn small" data-act="demo-exit">Beispiel beenden</button></div>`;
  }
  if (state.loading) html += '<div class="status"><p>Lade Konzerte…</p></div>';
  else if (!state.data) html += renderSetup();
  else if (state.view === 'settings') html += renderSettings();
  else if (state.view === 'artists') html += renderArtists();
  else html += renderFeed();
  app.innerHTML = html;
}

function renderStatus() {
  const d = state.data;
  const list = classified();
  const fresh = list.filter((e) => e.isNew).length;
  const sfm = d.source?.statsfm;
  const who = sfm ? ` · Geschmack von <a href="${esc(sfm.url)}" target="_blank" rel="noopener"><strong>stats.fm/${esc(sfm.name)}</strong></a>` : '';
  const ok = (d.stats?.sources || []).filter((x) => x.ok).map((x) => x.name);
  const from = ok.length ? ` · aus ${esc(ok.join(' + '))}` : '';
  const warn = d.errors?.length ? ` · <button class="linkbtn" data-act="errors" style="color:var(--amber)">${d.errors.length} Hinweis${d.errors.length === 1 ? '' : 'e'}</button>` : '';
  return `<div class="status" id="status">
    <p>Stand <strong>${relTime(d.ts)}</strong>, wird jeden Morgen aktualisiert · ${list.length} Konzerte für dich${fresh ? ` · <strong style="color:var(--accent)">${fresh} neu</strong>` : ''}${from}${who}${warn}</p>
  </div>`;
}

function renderErrors() {
  const errs = state.data?.errors || [];
  if (!state.showErrors || !errs.length) return '';
  return `<div class="panel" style="margin-top:12px"><h3 style="font-size:16px;margin-bottom:6px">Hinweise vom letzten Suchlauf</h3>
    <ul class="errors">${errs.slice(0, 40).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
}

function renderFeed() {
  const list = classified();
  const q = norm(state.query);
  const match = (e) => !q || norm([e.name, e.artist?.name, e.city, e.venue, e.countryName].join(' ')).includes(q);
  const filtered = list.filter(match);
  const savedList = Object.values(saved).filter((e) => !e.date || e.date >= todayISO());
  const chips = [
    ['foryou', 'Für dich'],
    ['date', 'Nach Datum'],
    ['new', 'Neu', filtered.filter((e) => e.isNew).length],
    ['sale', 'Vorverkauf startet', filtered.filter((e) => e.sale.upcoming).length],
    ['saved', 'Gemerkt', savedList.length],
  ];
  let html = renderStatus() + renderErrors();
  html += `<div class="filters" role="toolbar" aria-label="Ansicht">${chips.map(([id, label, n]) =>
    `<button class="chip" data-act="chip" data-chip="${id}" aria-pressed="${state.chip === id}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
    <input class="search" type="search" id="search" placeholder="Künstler, Stadt oder Halle filtern…" value="${esc(state.query)}" autocomplete="off" />`;

  if (state.chip === 'foryou') html += renderForYou(filtered);
  else if (state.chip === 'date') html += renderFlat(filtered, 'Alle Konzerte nach Datum', true);
  else if (state.chip === 'new') {
    html += renderFlat(filtered.filter((e) => e.isNew), 'Neu angekündigt', false,
      'In den letzten 14 Tagen dazugekommen. Beim allerersten Suchlauf ist noch nichts „neu“.');
  } else if (state.chip === 'sale') {
    const s = filtered.filter((e) => e.sale.upcoming).sort((a, b) => Date.parse(a.sale.upcoming) - Date.parse(b.sale.upcoming));
    html += renderFlat(s, 'Vorverkauf startet bald', false,
      'Tickets gibt es noch nicht – hier steht, wann es losgeht. Für Presales brauchst du oft eine Anmeldung beim Veranstalter.');
  } else if (state.chip === 'saved') {
    const live = new Map(list.map((e) => [e.id, e]));
    const s = savedList.map((e) => live.get(e.id) || { ...e, isNew: false, sale: saleInfo(e) }).filter(match);
    html += renderFlat(s, 'Gemerkt', true);
  }
  return html;
}

function byDate(a, b) {
  return (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || '');
}

function sectionHead(title, count, sub) {
  return `<div class="section-head"><h2 class="display">${title}</h2><span class="count">${count}</span></div>
    ${sub ? `<p class="section-sub">${sub}</p>` : ''}`;
}

function moreButton(id, shown, total) {
  if (total <= shown) return '';
  return `<div class="more"><button class="btn ghost" data-act="more" data-id="${id}">${total - shown} weitere anzeigen</button></div>`;
}

function emptyNote(text) {
  return `<div class="empty"><p style="margin:0">${text}</p></div>`;
}

function groupByArtist(list) {
  const groups = new Map();
  for (const ev of list) {
    const g = groups.get(ev.artist.key) || { artist: ev.artist, events: [] };
    g.events.push(ev);
    groups.set(ev.artist.key, g);
  }
  return [...groups.values()].sort((a, b) => b.artist.score - a.artist.score);
}

function renderForYou(list) {
  const s = settings();
  const near = list.filter((e) => e.section === 'near').sort((a, b) => b.score - a.score || byDate(a, b));
  const germany = groupByArtist(list.filter((e) => e.section === 'germany'));
  const abroad = groupByArtist(list.filter((e) => e.section === 'abroad'));
  const discover = list.filter((e) => e.section === 'discover').sort((a, b) => b.score - a.score || byDate(a, b));
  const placesText = [s.home, ...s.places].map((p) => `${esc(p.name)} (${Math.round(p.radius)} km)`).join(', ');

  let html = sectionHead('In deiner Nähe', near.length, `Deine Künstler rund um ${placesText}.`);
  const nNear = state.expand.near ? near.length : 12;
  html += near.length
    ? `<div class="grid">${near.slice(0, nNear).map(eventCard).join('')}</div>${moreButton('near', nNear, near.length)}`
    : emptyNote('Gerade keine angekündigten Konzerte deiner Künstler in der Nähe.');

  html += sectionHead('Deutschland', germany.length, 'Deine Künstler sonst irgendwo in Deutschland. Pro Künstler zuerst die Termine, die am nächsten liegen.');
  const nDe = state.expand.germany ? germany.length : 10;
  html += germany.length
    ? `<div class="grid">${germany.slice(0, nDe).map(tripCard).join('')}</div>${moreButton('germany', nDe, germany.length)}`
    : emptyNote('Keine weiteren Termine deiner Künstler in Deutschland.');

  html += sectionHead('Ausland', abroad.length, `Deine Künstler im Ausland – bis ${s.travelKm.toLocaleString('de-DE')} km von ${esc(s.home.name)}.`);
  const nAb = state.expand.abroad ? abroad.length : 10;
  html += abroad.length
    ? `<div class="grid">${abroad.slice(0, nAb).map(tripCard).join('')}</div>${moreButton('abroad', nAb, abroad.length)}`
    : emptyNote('Keine Termine deiner Künstler im Ausland gefunden.');

  html += sectionHead('Entdecken', discover.length, 'Andere Konzerte in deiner Nähe, die zu deinen Genres passen.');
  const nDisc = state.expand.discover ? discover.length : 12;
  html += discover.length
    ? `<div class="grid">${discover.slice(0, nDisc).map(eventCard).join('')}</div>${moreButton('discover', nDisc, discover.length)}`
    : emptyNote(Object.keys(profile().buckets).length
      ? 'Nichts Passendes in der Nähe gefunden.'
      : 'Es sind keine Genres bekannt. Wähle unter Einstellungen → Genres selbst aus, was dich interessiert.');
  return html;
}

function renderFlat(list, title, withMonths, sub) {
  const sorted = state.chip === 'sale' ? list : [...list].sort(byDate);
  const limit = state.expand[`flat-${state.chip}`] ? sorted.length : 60;
  let html = sectionHead(title, sorted.length, sub);
  if (!sorted.length) return html + emptyNote('Hier ist gerade nichts.');
  let lastMonth = '';
  let open = false;
  for (const ev of sorted.slice(0, limit)) {
    const month = ev.date ? fmtMonthLong.format(localDate(ev.date)) : 'Datum folgt';
    if (withMonths && month !== lastMonth) {
      if (open) html += '</div>';
      html += `<h3 class="display" style="font-size:20px;color:var(--muted);margin:22px 0 10px">${esc(month)}</h3><div class="grid">`;
      open = true;
      lastMonth = month;
    } else if (!open) {
      html += '<div class="grid">';
      open = true;
    }
    html += eventCard(ev);
  }
  if (open) html += '</div>';
  return html + moreButton(`flat-${state.chip}`, limit, sorted.length);
}

function whyTags(ev) {
  const tags = [];
  if (ev.isNew) tags.push('<span class="tag new">Neu</span>');
  if (ev.section === 'discover' && ev.disc) tags.push(`<span class="tag why">Passt zu dir: ${esc(ev.disc.sub || ev.disc.bucket)}</span>`);
  else if (ev.artist) tags.push(`<span class="tag why">${esc(ev.artist.why)}${ev.support ? ' · als Support' : ''}</span>`);
  if (/festival|open ?air/i.test(ev.name)) tags.push('<span class="tag">Festival</span>');
  if (/postponed|rescheduled/i.test(ev.status)) tags.push('<span class="tag warn">Verschoben</span>');
  return tags.join('');
}

function distanceText(ev) {
  const home = settings().home;
  if (ev.near && ev.near.place.name !== home.name) return `${Math.round(ev.near.d)} km von ${esc(ev.near.place.name)}`;
  if (ev.dHome != null) return `${Math.round(ev.dHome).toLocaleString('de-DE')} km von ${esc(home.name)}`;
  return '';
}

function saleText(ev) {
  const s = ev.sale || saleInfo(ev);
  const price = money(ev.price);
  if (s.pre && (!s.pub || Date.parse(s.pre.start) < Date.parse(s.pub))) {
    return `<span class="tag sale">Presale ${esc(fmtSale.format(new Date(s.pre.start)))}</span> <span>${esc(s.pre.name)}${s.pub ? ` · allgemein ab ${esc(fmtSale.format(new Date(s.pub)))}` : ''}</span>`;
  }
  if (s.pub) return `<span class="tag sale">Vorverkauf ab ${esc(fmtSale.format(new Date(s.pub)))}</span>`;
  if (/offsale/i.test(ev.status)) return 'Gerade kein Verkauf – evtl. ausverkauft';
  return price ? `Tickets ab <b>${esc(price)}</b>` : 'Tickets beim Anbieter';
}

/** Ein Knopf pro Ticket-Anbieter; bei nur einem heißt er einfach „Tickets“. */
function ticketButtons(ev) {
  const links = linksOf(ev);
  if (!links.length) return '';
  return links.map((l, i) => `<a class="btn ${i === 0 ? 'primary ' : ''}small" href="${esc(l.url)}" target="_blank" rel="noopener"${links.length === 1 ? ` title="Tickets bei ${esc(l.source)}"` : ''}>${links.length === 1 ? `Tickets <span class="src">${esc(l.source)}</span>` : esc(l.source)}</a>`).join('');
}

function sourcesList(d) {
  const sources = d.stats?.sources || [];
  if (!sources.length) return '';
  return `<ul class="places">${sources.map((s) => `<li><span><b>${esc(s.name)}</b> <span class="muted small">· ${s.ok
    ? `${s.kept ?? s.found} Konzerte`
    : s.reused ? 'ausgefallen – zeigt die Konzerte vom letzten Mal' : 'ausgefallen'}</span></span>
    <span style="color:${s.ok ? 'var(--green)' : 'var(--red)'}">${s.ok ? '●' : '○'}</span></li>`).join('')}</ul>`;
}

function saveButton(ev, compact = false) {
  const on = !!saved[ev.id];
  const label = compact ? (on ? '★' : '☆') : (on ? '★ Gemerkt' : '☆ Merken');
  return `<button class="btn small${on ? ' on' : ''}" data-act="save" data-id="${esc(ev.id)}" aria-pressed="${on}"${compact ? ' aria-label="Merken"' : ''}>${label}</button>`;
}

function eventCard(ev) {
  const p = dayParts(ev);
  const title = ev.artist ? ev.artist.name : ev.attractions[0]?.name || ev.name;
  // "Künstler – Tourname" → nur den Tournamen als Untertitel, der Künstler steht schon drüber.
  let sub = norm(ev.name) !== norm(title) ? ev.name : '';
  if (sub && sub.toLowerCase().startsWith(title.toLowerCase())) sub = sub.slice(title.length).replace(/^[\s\-–—:|@,]+/, '');
  const img = ev.image || ev.artist?.image;
  const place = [ev.venue, ev.city, ev.country && ev.country !== 'DE' ? ev.countryName : ''].filter(Boolean).map(esc).join(' · ');
  const dist = distanceText(ev);
  return `<article class="ev${ev.isNew ? ' is-new' : ''}" data-id="${esc(ev.id)}">
    <div class="ev-date" aria-label="${esc(whenText(ev))}"><span class="wd">${esc(p.wd)}</span><span class="d">${esc(p.d)}</span><span class="m">${esc(p.m)}</span>${p.y ? `<span class="y">${p.y}</span>` : ''}</div>
    <div class="ev-body">
      <div class="tags">${whyTags(ev)}</div>
      <div class="ev-media">
        <div class="ev-main">
          <h3 class="ev-title">${esc(title)}</h3>
          ${sub ? `<p class="ev-sub">${esc(sub)}</p>` : ''}
        </div>
        ${img ? `<img class="ev-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />` : ''}
      </div>
      <p class="ev-where">${place}${dist ? ` <span class="dist">· ${dist}</span>` : ''}</p>
      <p class="ev-sale">${ev.time ? `${esc(ev.time.slice(0, 5))} Uhr · ` : ''}${saleText(ev)}</p>
      <div class="ev-actions">
        ${ticketButtons(ev)}
        ${saveButton(ev)}
        <button class="btn small ghost" data-act="ics" data-id="${esc(ev.id)}">In Kalender</button>
      </div>
    </div>
  </article>`;
}

function tripCard(group) {
  const a = group.artist;
  const events = [...group.events].sort((x, y) => (x.dHome ?? 1e9) - (y.dHome ?? 1e9) || byDate(x, y));
  const open = state.tripOpen.has(a.key);
  const shown = open ? events : events.slice(0, 3);
  const img = a.image || events.find((e) => e.image)?.image;
  return `<article class="trip">
    <div class="trip-head">
      ${img ? `<img class="trip-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />` : '<div class="trip-img"></div>'}
      <div style="min-width:0">
        <h3>${esc(a.name)}</h3>
        <div class="tags">${events.some((e) => e.isNew) ? '<span class="tag new">Neu</span>' : ''}<span class="tag why">${esc(a.why)}</span><span class="tag">${events.length} ${events.length === 1 ? 'Termin' : 'Termine'}</span></div>
      </div>
    </div>
    <ul class="dates">${shown.map((ev) => {
      const extra = ev.sale.upcoming ? ` · <span style="color:var(--amber)">VVK ab ${esc(fmtSale.format(new Date(ev.sale.upcoming)))}</span>` : '';
      return `<li class="${ev.isNew ? 'is-new' : ''}">
        <span class="when">${esc(whenText(ev))}${ev.support ? ' <span class="muted small">(Support)</span>' : ''}</span>
        <span class="where">${esc([ev.city, ev.countryName].filter(Boolean).join(', '))} · ${esc(ev.venue)}${ev.dHome != null ? ` · ${Math.round(ev.dHome).toLocaleString('de-DE')} km` : ''}${extra}</span>
        <span class="acts">
          ${ticketButtons(ev)}
          ${saveButton(ev, true)}
        </span>
      </li>`;
    }).join('')}</ul>
    ${events.length > 3 ? `<button class="linkbtn more" data-act="trip" data-key="${esc(a.key)}">${open ? 'Weniger anzeigen' : `+ ${events.length - 3} weitere Termine`}</button>` : ''}
  </article>`;
}

/* ---------------------------------------------------------------- Künstler */

function renderArtists() {
  const d = state.data;
  const countBy = new Map();
  for (const ev of classified()) {
    if (!ev.artist) continue;
    const c = countBy.get(ev.artist.key) || { near: 0, germany: 0, abroad: 0 };
    c[ev.section] = (c[ev.section] || 0) + 1;
    countBy.set(ev.artist.key, c);
  }
  const artists = d.artists || [];
  const max = d.settings?.maxArtists || 60;
  let html = `<div class="hero"><h1 class="display hero-title">Deine <em>Künstler</em></h1>
    <p class="lead">Danach sucht das Radar, sortiert danach, wie viel du sie hörst. Die obersten ${max} werden einzeln gesucht,
      alle anderen erkennt es trotzdem, wenn sie in deiner Nähe spielen.</p>
    ${repo ? `<p class="small muted" style="margin-top:10px">Jemand fehlt? In <a href="${repo.config}" target="_blank" rel="noopener">config.json</a> unter <code>"artists"</code> eintragen – ab dem nächsten Suchlauf ist er dabei.</p>` : ''}
  </div>`;
  if (!artists.length) return `${html}${emptyNote('Noch keine Künstler. Trag deinen stats.fm-Namen oder Künstler in config.json ein.')}`;

  html += `<ul class="artists">${artists.slice(0, 300).map((a, i) => {
    const c = countBy.get(a.key);
    const isHidden = hidden.has(a.key);
    const found = c ? [c.near ? `${c.near} in der Nähe` : '', c.germany ? `${c.germany} in Deutschland` : '', c.abroad ? `${c.abroad} im Ausland` : ''].filter(Boolean).join(', ') : '';
    return `<li class="artist${isHidden ? ' hidden-artist' : ''}">
      <span class="rank">${i + 1}</span>
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />` : '<span class="ph"></span>'}
      <div style="min-width:0">
        <div class="name">${esc(a.name)}</div>
        <div class="meta">${esc(a.why)}${a.genres?.length ? ` · ${esc(a.genres.slice(0, 3).join(', '))}` : ''}</div>
        <div class="meta" style="color:${found ? 'var(--green)' : 'var(--faint)'}">${found ? `Konzerte: ${esc(found)}` : 'gerade keine Konzerte gefunden'}</div>
        <div class="bar"><span style="width:${Math.round(a.score * 100)}%"></span></div>
      </div>
      <div class="links">
        <a class="btn small ghost" href="https://www.eventim.de/search/?searchterm=${encodeURIComponent(a.name)}" target="_blank" rel="noopener" title="Bei Eventim suchen – dort gibt es viele deutsche Konzerte, die Ticketmaster nicht kennt">Eventim</a>
        ${a.url ? `<a class="btn small ghost" href="${esc(a.url)}" target="_blank" rel="noopener">Spotify</a>` : ''}
        <button class="btn small ghost" data-act="${isHidden ? 'unhide' : 'hide'}" data-key="${esc(a.key)}">${isHidden ? 'Einblenden' : 'Ausblenden'}</button>
      </div>
    </li>`;
  }).join('')}</ul>`;
  return html;
}

/* ---------------------------------------------------------------- Einstellungen */

function renderSettings() {
  const d = state.data;
  const s = settings();
  const prof = profile();
  const autoList = Object.entries(prof.auto).sort((a, b) => b[1] - a[1]);
  const manual = Array.isArray(prefs.genres);
  const active = new Set(manual ? prefs.genres : autoList.filter(([, w]) => w >= 0.35).map(([b]) => b));
  const sfm = d.source?.statsfm;

  return `<div class="hero"><h1 class="display hero-title">Einstel<em>lungen</em></h1></div>
  <div class="settings">
    <section class="panel">
      <h2 class="display">Suchlauf</h2>
      <p class="muted small">Letzter Suchlauf ${relTime(d.ts)} (${new Date(d.ts).toLocaleString('de-DE')}). ${d.stats?.searched ?? 0} Künstler einzeln gesucht.
        ${sfm ? `Geschmack von <a href="${esc(sfm.url)}" target="_blank" rel="noopener">stats.fm/${esc(sfm.name)}</a>.` : 'Kein stats.fm-Profil verknüpft.'}</p>
      ${sourcesList(d)}
      ${repo ? `<div class="row">
        <a class="btn primary" href="${repo.actions}" target="_blank" rel="noopener">Jetzt neu suchen</a>
        <a class="btn" href="${repo.config}" target="_blank" rel="noopener">Orte &amp; Künstler ändern</a>
      </div>
      <p class="hint muted small">„Jetzt neu suchen“ öffnet GitHub – dort auf <b>Run workflow</b> tippen, nach 1–2 Minuten ist die Seite aktuell.
        Orte, Umkreis, stats.fm-Name und Extra-Künstler stehen in <code>config.json</code>.</p>` : ''}
      <ul class="places">${[s.home, ...s.places].map((p, i) => `<li><span><b>${esc(p.name)}</b> <span class="muted small">· ${Math.round(p.radius)} km Umkreis${i === 0 ? ' · Zuhause' : ''}</span></span></li>`).join('')}</ul>
    </section>

    <section class="panel">
      <h2 class="display">Ausland</h2>
      <div class="field"><label for="s-travel">Deine Künstler im Ausland zeigen – bis</label>
        <div class="range"><input type="range" id="s-travel" min="200" max="5000" step="100" value="${s.travelKm}" data-range="travelKm" />
        <output>${s.travelKm.toLocaleString('de-DE')} km</output></div>
        <span class="hint">Göteborg liegt rund 1.050 km von Idar-Oberstein entfernt, Stockholm 1.250 km, London 650 km, Barcelona 1.000 km.
          Gilt nur auf diesem Gerät.</span></div>
    </section>

    <section class="panel">
      <h2 class="display">Genres für „Entdecken“</h2>
      <p class="muted small">${manual ? 'Du hast die Genres selbst gewählt (nur auf diesem Gerät).' : autoList.length ? 'Automatisch aus deinem Geschmack. Antippen, um selbst zu wählen.' : 'Es sind keine Genres bekannt – wähle selbst.'}</p>
      <div class="genre-chips">${BUCKETS.map(([b]) => {
        const w = prof.auto[b];
        return `<button class="chip" data-act="genre" data-genre="${esc(b)}" aria-pressed="${active.has(b)}">${esc(b)}${w ? `<span class="n">${Math.round(w * 100)}%</span>` : ''}</button>`;
      }).join('')}</div>
      ${manual ? '<p><button class="linkbtn" data-act="genre-auto">Wieder automatisch</button></p>' : ''}
    </section>

    <section class="panel">
      <h2 class="display">Auf diesem Gerät</h2>
      <p class="muted small">${Object.keys(saved).length} gemerkte Konzerte, ${hidden.size} ausgeblendete Künstler.</p>
      <div class="row">
        ${hidden.size ? '<button class="btn" data-act="unhide-all">Alle Künstler wieder einblenden</button>' : ''}
        <button class="btn ghost" data-act="reset">Gerät zurücksetzen</button>
      </div>
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- Einrichtung */

function renderSetup() {
  const link = (url, text) => (repo ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>` : text);
  return `<section class="hero">
    <h1 class="display hero-title">Konzerte, die zu <em>deiner Musik</em> passen</h1>
    <p class="lead">Jeden Morgen holt das Radar deine Top-Künstler von stats.fm, sucht dazu Konzerte und Vorverkäufe –
      in deiner Nähe und für deine Favoriten auch dort, wo sich die Reise lohnt.</p>
    <div class="row" style="margin-top:18px;max-width:520px"><button class="btn primary" data-act="demo">Beispiel ansehen</button></div>
  </section>
  <div class="panel" style="margin-bottom:14px"><p style="margin:0" class="muted">${state.loadError === 'missing'
    ? 'Hier liegen noch keine Konzertdaten. Der erste Suchlauf hat noch nicht stattgefunden oder ist fehlgeschlagen.'
    : `Die Konzertdaten konnten nicht geladen werden (${esc(state.loadError || 'unbekannt')}).`}</p></div>
  <ol class="steps">
    <li><h3>Ticketmaster-Schlüssel holen</h3>
      <p>Kostenlos auf <a href="https://developer-acct.ticketmaster.com/user/register" target="_blank" rel="noopener">developer.ticketmaster.com</a> registrieren, unter <b>My Apps</b> den <b>Consumer Key</b> kopieren.
      Dann im Repo unter ${link(repo?.secrets, 'Settings → Secrets and variables → Actions')} ein <b>New repository secret</b> anlegen: Name <code>TICKETMASTER_KEY</code>, Wert = der Key.</p></li>
    <li><h3>stats.fm-Namen eintragen</h3>
      <p>In ${link(repo?.config, 'config.json')} bei <code>"statsfm"</code> deinen Namen aus der Profiladresse eintragen (stats.fm/<b>name</b>).
      In der stats.fm-App muss unter Privatsphäre „Top-Künstler“ öffentlich sein.</p></li>
    <li><h3>Seite einschalten</h3>
      <p>Unter ${link(repo?.pages, 'Settings → Pages')} bei <b>Source</b> „GitHub Actions“ wählen.</p></li>
    <li><h3>Ersten Suchlauf starten</h3>
      <p>Unter ${link(repo?.actions, 'Actions → Konzerte aktualisieren')} auf <b>Run workflow</b>. Nach 1–2 Minuten diese Seite neu laden.</p></li>
  </ol>`;
}

/* ================================================================ Aktionen */

function findEvent(id) {
  return classified().find((e) => e.id === id) || saved[id] || null;
}

function snapshot(ev) {
  const keep = ['id', 'source', 'name', 'url', 'links', 'date', 'time', 'dateTime', 'status', 'venue', 'city', 'country', 'countryName', 'lat', 'lon', 'image', 'attractions', 'saleStart', 'presales', 'price', 'section', 'dHome', 'support'];
  const out = {};
  for (const k of keep) out[k] = ev[k];
  if (ev.artist) out.artist = { key: ev.artist.key, name: ev.artist.name, why: ev.artist.why, image: ev.artist.image, score: ev.artist.score };
  return out;
}

async function enterDemo() {
  const { buildDemoData } = await import('./demo.js');
  state.demo = true;
  state.chip = 'foryou';
  state.query = '';
  state.data = buildDemoData();
  state.loading = false;
  classifiedCache = null;
  state.view = 'feed';
  history.replaceState(null, '', '#demo');
  render();
}

async function exitDemo() {
  state.demo = false;
  state.chip = 'foryou';
  state.query = '';
  classifiedCache = null;
  history.replaceState(null, '', '#feed');
  await loadData();
  render();
}

app.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'demo': enterDemo(); break;
    case 'demo-exit': exitDemo(); break;
    case 'errors': state.showErrors = !state.showErrors; render(); break;
    case 'chip': state.chip = el.dataset.chip; render(); break;
    case 'more': state.expand[el.dataset.id] = true; render(); break;
    case 'trip': {
      const k = el.dataset.key;
      if (state.tripOpen.has(k)) state.tripOpen.delete(k); else state.tripOpen.add(k);
      render();
      break;
    }
    case 'save': {
      const id = el.dataset.id;
      if (saved[id]) delete saved[id];
      else {
        const ev = findEvent(id);
        if (ev) saved[id] = snapshot(ev);
      }
      store(LS.saved, saved);
      render();
      break;
    }
    case 'ics': {
      const ev = findEvent(el.dataset.id);
      if (ev) downloadIcs(ev);
      break;
    }
    case 'hide':
    case 'unhide':
      if (act === 'hide') hidden.add(el.dataset.key); else hidden.delete(el.dataset.key);
      store(LS.hidden, [...hidden]);
      classifiedCache = null;
      render();
      break;
    case 'unhide-all':
      hidden = new Set();
      store(LS.hidden, []);
      classifiedCache = null;
      render();
      break;
    case 'genre': {
      const prof = profile();
      const current = Array.isArray(prefs.genres) ? prefs.genres : Object.entries(prof.auto).filter(([, w]) => w >= 0.35).map(([b]) => b);
      const set = new Set(current);
      const g = el.dataset.genre;
      if (set.has(g)) set.delete(g); else set.add(g);
      prefs.genres = [...set];
      store(LS.prefs, prefs);
      classifiedCache = null;
      render();
      break;
    }
    case 'genre-auto':
      prefs.genres = null;
      store(LS.prefs, prefs);
      classifiedCache = null;
      render();
      break;
    case 'reset':
      if (!window.confirm('Merkliste, ausgeblendete Künstler und eigene Einstellungen auf diesem Gerät löschen?')) break;
      Object.values(LS).forEach((k) => store(k, null));
      prefs = { travelKm: null, genres: null };
      saved = {};
      hidden = new Set();
      classifiedCache = null;
      toast('Zurückgesetzt');
      render();
      break;
    default:
  }
});

app.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'search') {
    state.query = el.value;
    clearTimeout(app.searchTimer);
    app.searchTimer = setTimeout(() => {
      const pos = el.selectionStart;
      render();
      const again = document.getElementById('search');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }, 200);
    return;
  }
  if (el.dataset.range === 'travelKm') {
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = `${Number(el.value).toLocaleString('de-DE')} km`;
  }
});

app.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset.range === 'travelKm') {
    const v = Number(el.value);
    prefs.travelKm = v === settings().configTravelKm ? null : v;
    store(LS.prefs, prefs);
    classifiedCache = null;
    toast('Gespeichert');
  }
});

function viewFromHash() {
  const v = location.hash.slice(1);
  return VIEWS.includes(v) ? v : 'feed';
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#demo') { if (!state.demo) enterDemo(); return; }
  state.view = viewFromHash();
  render();
  window.scrollTo(0, 0);
});

/* ================================================================ Start */

async function init() {
  state.view = viewFromHash();
  if (location.hash === '#demo') { await enterDemo(); return; }
  render();
  await loadData();
  render();
}

init();
