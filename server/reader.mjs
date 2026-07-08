// Zinester reader — dependency-free feed ingestion + summarization.
//
// Pure logic only: no fs, no http server. Given raw feed XML it returns
// normalized items; given article text it returns a short summary. The HTTP
// handlers live in server.mjs and reuse these functions. Node >= 18 built-ins
// only (the global `fetch` is used for feed fetching and the optional Claude
// summary hook), so it runs anywhere the reference server does.

// --- HTML / entity handling -------------------------------------------------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

export function decodeEntities(s = '') {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

// Strip CDATA wrappers, tags, and collapse whitespace to readable plain text.
export function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t\f\v]+/g, ' ').replace(/\n{2,}/g, '\n\n').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

// --- tiny tolerant XML field extraction -------------------------------------
function unwrap(v) {
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v.trim());
  return m ? m[1] : v;
}
// First <name ...>inner</name> in xml (namespace-aware: "dc:creator" etc).
function tag(xml, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i');
  const m = re.exec(xml);
  return m ? unwrap(m[1]).trim() : '';
}
function attr(fragment, name) {
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(fragment)
    || new RegExp(name + "\\s*=\\s*'([^']*)'", 'i').exec(fragment);
  return m ? m[1] : '';
}
function blocks(xml, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/' + name + '>', 'gi');
  return xml.match(re) || [];
}

// Resolve a possibly-relative link against the feed URL.
function absolutize(link, base) {
  if (!link) return '';
  try { return new URL(link, base).href; } catch { return link; }
}

function pickDate(...cands) {
  for (const c of cands) {
    if (!c) continue;
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// --- feed parsing (RSS 2.0 / RDF / Atom) ------------------------------------
// Returns { title, homepage, items: [{ guid, title, url, author, publishedAt,
//   description, content }] } — description/content are raw HTML; the caller
// summarizes. Throws only on completely unrecognizable input.
export function parseFeed(xml, feedUrl = '') {
  if (!xml || typeof xml !== 'string') throw new Error('empty feed');
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const channel = isAtom ? xml : (tag(xml, 'channel') ? xml : xml);

  const feedTitle = decodeEntities(isAtom
    ? tag(xml.replace(/<entry[\s\S]*$/i, ''), 'title')
    : tag(channel.replace(/<item[\s\S]*$/i, ''), 'title'));

  const entryTag = isAtom ? 'entry' : 'item';
  const rawItems = blocks(xml, entryTag);

  const items = rawItems.map((frag) => {
    const title = decodeEntities(tag(frag, 'title')) || '(untitled)';
    let url;
    if (isAtom) {
      // Prefer rel="alternate"; fall back to the first <link href>.
      const links = frag.match(/<link\b[^>]*>/gi) || [];
      const alt = links.find(l => /rel=["']?alternate/i.test(l)) || links.find(l => !/rel=/i.test(l)) || links[0];
      url = alt ? attr(alt, 'href') : '';
    } else {
      url = tag(frag, 'link') || attr((frag.match(/<link\b[^>]*>/i) || [''])[0], 'href');
    }
    url = absolutize(url, feedUrl);

    const guid = tag(frag, 'guid') || tag(frag, 'id') || url || title;
    // Author: RSS uses dc:creator/author (plain text); Atom nests <author><name>.
    let authorRaw = tag(frag, 'dc:creator');
    if (!authorRaw) { const au = tag(frag, 'author'); authorRaw = /<name[\s>]/i.test(au) ? tag(au, 'name') : au; }
    const author = decodeEntities(authorRaw);
    const publishedAt = pickDate(
      tag(frag, 'pubDate'), tag(frag, 'published'), tag(frag, 'updated'),
      tag(frag, 'dc:date'), tag(frag, 'date'));
    const content = tag(frag, 'content:encoded') || tag(frag, 'content') || '';
    const description = tag(frag, 'description') || tag(frag, 'summary') || '';
    return { guid, title, url, author: author.replace(/^by\s+/i, '').trim(), publishedAt, description, content };
  });

  return { title: feedTitle, homepage: absolutize(isAtom ? '' : tag(channel, 'link'), feedUrl), items };
}

// --- summarization ----------------------------------------------------------
function sentences(text) {
  return text.replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/).filter(Boolean);
}

// Dependency-free extractive summary: the first couple of sentences, trimmed to
// a tweet-ish length so the reading queue stays scannable.
export function extractiveSummary(text, { maxChars = 300, maxSentences = 2 } = {}) {
  const clean = stripHtml(text);
  if (!clean) return '';
  const sents = sentences(clean);
  let out = '';
  for (const s of sents) {
    if (out && (out.length + s.length + 1) > maxChars) break;
    out = out ? out + ' ' + s : s;
    if (sents.indexOf(s) + 1 >= maxSentences && out.length >= 120) break;
  }
  if (!out) out = clean;
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

// Optional upgrade: if ANTHROPIC_API_KEY is set, ask Claude for a tighter
// summary. Best-effort — any failure returns null so the caller falls back to
// the extractive summary and the pipeline stays offline-capable.
export async function claudeSummary(text, {
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ZINESTER_SUMMARY_MODEL || 'claude-haiku-4-5-20251001',
  title = '',
} = {}) {
  if (!apiKey) return null;
  const clean = stripHtml(text).slice(0, 8000);
  if (clean.length < 200) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
      body: JSON.stringify({
        model, max_tokens: 220,
        system: 'You summarize articles for a personal reading queue. Reply with 2-3 plain sentences capturing the core argument and why it matters. No preamble, no markdown, no "This article".',
        messages: [{ role: 'user', content: (title ? `Title: ${title}\n\n` : '') + clean }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const out = (data.content || []).map(b => b.text || '').join(' ').trim();
    return out || null;
  } catch { return null; }
}

// Choose the best available summary for an item and report which engine made it.
// Order: Claude (if key) -> a clean feed blurb -> extractive from full content.
export async function summarizeItem(item, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const fullText = stripHtml(item.content || item.description || '');
  const blurb = stripHtml(item.description || '');
  const excerpt = fullText.slice(0, 1200);
  const oneLine = s => s.replace(/\s+/g, ' ').trim();

  if (apiKey) {
    const c = await claudeSummary(item.content || item.description || '', { apiKey, title: item.title });
    if (c) return { summary: oneLine(c), engine: 'claude', excerpt };
  }
  if (blurb && blurb.length >= 40 && blurb.length <= 400 && /[.!?]/.test(blurb)) {
    return { summary: oneLine(blurb), engine: 'feed', excerpt };
  }
  return { summary: oneLine(extractiveSummary(fullText)), engine: 'extractive', excerpt };
}

// Fetch + parse a feed URL. Returns { title, homepage, items } or throws.
export async function fetchFeed(url) {
  const r = await fetch(url, {
    // A browser-ish UA gets past feeds that 403 obvious bots; still identifies as a reader.
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Zinester-Reader/1.0; +https://github.com/zekefiddler/zinester)',
      'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    redirect: 'follow',
  });
  if (!r.ok) throw Object.assign(new Error('feed HTTP ' + r.status), { status: 502 });
  const xml = await r.text();
  return parseFeed(xml, url);
}
