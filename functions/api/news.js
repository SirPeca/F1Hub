// =========================================
// F1 Hub — functions/api/news.js  v1
//
// GET /api/news
//
// Agrega RSS de medios de F1 reconocidos y devuelve titulares
// normalizados con link a la nota original. No reproducimos el
// cuerpo del artículo: solo título, fuente, fecha y un resumen
// corto (recortado) para respetar derechos de autor. El clic
// siempre lleva al medio original.
// =========================================

const FEEDS = [
  { source: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { source: 'Motorsport.com', url: 'https://www.motorsport.com/rss/f1/news/' },
  { source: 'RaceFans', url: 'https://www.racefans.net/feed/' },
];

const CACHE_TTL = 600; // 10 min
const MAX_SUMMARY_CHARS = 160;

export async function onRequestGet(context) {
  const { request } = context;
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled(
    FEEDS.map((f) => fetchFeed(f))
  );

  let items = [];
  const sourceStatus = {};
  results.forEach((r, i) => {
    const source = FEEDS[i].source;
    if (r.status === 'fulfilled') {
      items.push(...r.value);
      sourceStatus[source] = 'ok';
    } else {
      sourceStatus[source] = 'unavailable';
    }
  });

  // Deduplicar por título normalizado (algunos medios republican lo mismo)
  const seen = new Set();
  items = items.filter((it) => {
    const key = it.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  items = items.slice(0, 40);

  return jsonResponse({ updatedAt: new Date().toISOString(), sourceStatus, items }, 200, cache, cacheKey, CACHE_TTL);
}

async function fetchFeed({ source, url }) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; f1hub/1.0; +https://pages.dev) NewsAggregator',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${source}`);
  const xml = await res.text();
  return parseRss(xml, source);
}

function parseRss(xml, source) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const block of itemBlocks) {
    const title = decodeEntities(stripCdata(extractTag(block, 'title')));
    const link = decodeEntities(stripCdata(extractTag(block, 'link'))).trim();
    const pubDateRaw = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const pubDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : new Date().toISOString();
    const descRaw = decodeEntities(stripCdata(extractTag(block, 'description')));
    const summary = truncate(stripHtml(descRaw), MAX_SUMMARY_CHARS);

    if (title && link) {
      items.push({ title: title.trim(), link, pubDate, summary, source });
    }
  }
  return items;
}

function extractTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? match[1] : '';
}

function stripCdata(str) {
  return str.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function jsonResponse(obj, status = 200, cache, cacheKey, ttl) {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });
  if (cache && cacheKey && status === 200) cache.put(cacheKey, res.clone());
  return res;
}
