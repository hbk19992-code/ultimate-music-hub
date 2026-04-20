// /api/getDiscogs.js  V9 — Aggressive matching + sniper paging

const TOKEN = process.env.DISCOGS_TOKEN;
const TOKEN_Q = TOKEN ? `&token=${TOKEN}` : ‘’;
const HEADERS = { ‘User-Agent’: ‘CanYouDigIt/1.0 +https://owb-digging.app’ };

async function fetchJson(url, timeoutMs = 8000) {
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), timeoutMs);
try {
const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
clearTimeout(t);
if (!r.ok) return null;
return await r.json();
} catch (error) {
clearTimeout(t);
return null;
}
}

function normalizeForMatch(s) {
return (s || ‘’)
.toLowerCase()
.replace(/[’’`”]/g, ‘’)
.replace(/&/g, ‘and’)
.replace(/[^\p{L}\p{N}]+/gu, ’ ’)
.trim()
.replace(/\s+/g, ’ ’);
}

function sanitizeTitle(title) {
if (!title) return “”;
return title
.replace(/\s*[([].*?(remaster|remastered|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp|legacy|anniversary|collector|super audio|sacd|hi-res|hd|hires|extended|alternate|take|japan|japanese|us|uk|eu|europe|original|complete).*?[)]]/gi, ‘’)
.replace(/\s*-\s*(remaster|remastered|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp|legacy|anniversary|collector|super audio|sacd|hi-res|hd|hires|extended|alternate|take|japan|japanese|us|uk|eu|europe|original|complete).*$/gi, ‘’)
.replace(/\s*(?\s*\d+(st|nd|rd|th)\s+(anniversary|edition|year).*?)?/gi, ‘’)
.replace(/\s*(?\s*(feat.?|featuring|ft.?|with)\s+[^)]+)?/gi, ‘’)
.replace(/\s+(19|20)\d{2}\s*(remaster|remastered|mix|version)?$/gi, ‘’)
.replace(/\s+/g, ’ ’)
.trim();
}

function mergeArtists(allArtists) {
const seen = new Map();
allArtists.forEach(ar => {
if (!ar?.name) return;
const cleanName = ar.name.replace(/\s(\d+)$/, ‘’).trim();
const cleanRole = (ar.role || ‘’).trim();
const key = `${cleanName.toLowerCase()}|${cleanRole.toLowerCase()}`;
if (!seen.has(key)) {
seen.set(key, { …ar, name: ar.name, role: cleanRole });
}
});
return Array.from(seen.values());
}

function mergeTracklists(allTracklists) {
const tracksByKey = new Map();
const order = [];
allTracklists.forEach(tl => {
(tl || []).forEach((track) => {
if (!track?.title) return;
const key = track.title.toLowerCase().replace(/[^a-z0-9가-힣]/g, ‘’);
if (!key) return;
if (!tracksByKey.has(key)) {
tracksByKey.set(key, { …track, extraartists: […(track.extraartists || [])] });
order.push(key);
} else {
const existing = tracksByKey.get(key);
existing.extraartists = mergeArtists([…existing.extraartists, …(track.extraartists || [])]);
}
});
});
return order.map(k => tracksByKey.get(k));
}

function scoreRelease(rel) {
let score = 0;
const formats = (Array.isArray(rel.format) ? rel.format.join(’ ’) : (rel.format || ‘’)).toLowerCase();
if (formats.includes(‘cd’)) score += 10;
if (formats.includes(‘album’)) score += 5;
if (/deluxe|expanded|special|remaster/i.test(formats + ’ ’ + (rel.title || ‘’))) score += 4;
if (rel.community?.have) score += Math.min(rel.community.have / 100, 3);
return score;
}

function findBestMasterMatch(results, targetTitle, targetArtist) {
if (!results?.length) return null;

const targetTitleNorm = normalizeForMatch(sanitizeTitle(targetTitle));
const targetArtistNorm = normalizeForMatch(targetArtist);
const targetTitleTokens = targetTitleNorm.split(’ ’).filter(t => t.length > 1);

const scored = results.map(r => {
const raw = r.title || ‘’;
const parts = raw.includes(’ - ‘) ? raw.split(’ - ‘) : [raw];
const discogsArtist = parts.length >= 2 ? parts[0] : ‘’;
const discogsTitle = parts.length >= 2 ? parts.slice(1).join(’ - ’) : raw;

```
const titleNorm = normalizeForMatch(sanitizeTitle(discogsTitle));
const artistNorm = normalizeForMatch(discogsArtist);

let score = 0;
if (titleNorm === targetTitleNorm) score += 100;
else if (titleNorm.includes(targetTitleNorm) || targetTitleNorm.includes(titleNorm)) score += 60;
else {
  const titleTokens = titleNorm.split(' ').filter(t => t.length > 1);
  const intersection = targetTitleTokens.filter(t => titleTokens.includes(t));
  if (targetTitleTokens.length > 0) {
    const coverage = intersection.length / targetTitleTokens.length;
    score += coverage * 50;
  }
}

if (artistNorm === targetArtistNorm) score += 40;
else if (artistNorm.includes(targetArtistNorm) || targetArtistNorm.includes(artistNorm)) score += 25;
else {
  const artistTokens = artistNorm.split(' ').filter(t => t.length > 1);
  const targetArtistTokens = targetArtistNorm.split(' ').filter(t => t.length > 1);
  if (targetArtistTokens.length && artistTokens.length) {
    const matched = targetArtistTokens.filter(t => artistTokens.includes(t)).length;
    score += (matched / targetArtistTokens.length) * 20;
  }
}

if (r.community?.have) score += Math.min(r.community.have / 200, 5);
return { result: r, score };
```

}).sort((a, b) => b.score - a.score);

if (scored[0].score < 20) return null;
return scored[0].result;
}

// Sniper search — 페이징 + credit 파라미터 동시 사용
async function runSniperSearch(artistName, sessionName) {
const matchedTitles = new Set();
const pageUrls = [];
for (let p = 1; p <= 3; p++) {
pageUrls.push(
`https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&q=${encodeURIComponent(sessionName)}&type=release&per_page=100&page=${p}${TOKEN_Q}`
);
}
// credit 파라미터 검색 추가
pageUrls.push(
`https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&credit=${encodeURIComponent(sessionName)}&type=release&per_page=100${TOKEN_Q}`
);

const results = await Promise.all(pageUrls.map(u => fetchJson(u)));
results.forEach(searchRes => {
if (!searchRes?.results) return;
searchRes.results.forEach(r => {
if (!r?.title) return;
const rawTitle = r.title.includes(’ - ‘) ? r.title.split(’ - ‘).slice(1).join(’ - ’) : r.title;
matchedTitles.add(sanitizeTitle(rawTitle));
});
});

return Array.from(matchedTitles);
}

export default async function handler(req, res) {
const { albumTitle, artistName, deepSearch, sessionName } = req.query;

if (deepSearch === ‘true’ && artistName && sessionName) {
try {
const matchedTitles = await runSniperSearch(artistName, sessionName);
res.setHeader(‘Cache-Control’, ‘s-maxage=300, stale-while-revalidate=600’);
return res.json({ matchedTitles, _count: matchedTitles.length });
} catch (e) {
return res.status(500).json({ error: e.message, matchedTitles: [] });
}
}

if (!albumTitle || !artistName) return res.status(400).json({ error: ‘Required params missing’ });

try {
const cleanAlbumTitle = sanitizeTitle(albumTitle);
const debugTrace = [];

```
let masterSearch = await fetchJson(
  `https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&release_title=${encodeURIComponent(cleanAlbumTitle)}&type=master&per_page=20${TOKEN_Q}`
);
debugTrace.push(`master-precise: ${masterSearch?.results?.length || 0}`);

if (!masterSearch?.results?.length) {
  const queryStr = encodeURIComponent(`${artistName} ${cleanAlbumTitle}`);
  masterSearch = await fetchJson(`https://api.discogs.com/database/search?q=${queryStr}&type=master&per_page=20${TOKEN_Q}`);
  debugTrace.push(`master-fallback: ${masterSearch?.results?.length || 0}`);
}

let masterId = null;
if (masterSearch?.results?.length) {
  const matched = findBestMasterMatch(masterSearch.results, cleanAlbumTitle, artistName);
  if (matched) masterId = matched.id;
  debugTrace.push(`master-match: ${masterId || 'none'}`);
}

let releaseIdsToFetch = [];
if (masterId) {
  const versions = await fetchJson(`https://api.discogs.com/masters/${masterId}/versions?per_page=25${TOKEN_Q}`);
  if (versions?.versions) {
    const top = versions.versions
      .filter(v => v.id)
      .map(v => ({ v, s: scoreRelease(v) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map(x => x.v.id);
    releaseIdsToFetch = top;
    debugTrace.push(`versions: ${top.length}`);
  }
}

if (releaseIdsToFetch.length === 0) {
  let relSearch = await fetchJson(
    `https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&release_title=${encodeURIComponent(cleanAlbumTitle)}&type=release&per_page=20${TOKEN_Q}`
  );
  debugTrace.push(`release-precise: ${relSearch?.results?.length || 0}`);

  if (!relSearch?.results?.length) {
    const queryStr = encodeURIComponent(`${artistName} ${cleanAlbumTitle}`);
    relSearch = await fetchJson(`https://api.discogs.com/database/search?q=${queryStr}&type=release&per_page=20${TOKEN_Q}`);
    debugTrace.push(`release-fallback: ${relSearch?.results?.length || 0}`);
  }

  if (relSearch?.results?.length) {
    const bestMatch = findBestMasterMatch(relSearch.results, cleanAlbumTitle, artistName);
    if (bestMatch) {
      releaseIdsToFetch.push(bestMatch.id);
      const bestRaw = (bestMatch.title || '').includes(' - ')
        ? bestMatch.title.split(' - ').slice(1).join(' - ')
        : bestMatch.title;
      const bestTitleNorm = normalizeForMatch(sanitizeTitle(bestRaw));

      relSearch.results.forEach(r => {
        if (releaseIdsToFetch.length >= 6) return;
        if (r.id === bestMatch.id) return;
        const rawTitle = (r.title || '').includes(' - ')
          ? r.title.split(' - ').slice(1).join(' - ')
          : r.title;
        const rNorm = normalizeForMatch(sanitizeTitle(rawTitle));
        if (rNorm === bestTitleNorm || rNorm.includes(bestTitleNorm) || bestTitleNorm.includes(rNorm)) {
          releaseIdsToFetch.push(r.id);
        }
      });
      debugTrace.push(`release-siblings: ${releaseIdsToFetch.length}`);
    } else {
      releaseIdsToFetch = relSearch.results.slice(0, 3).map(r => r.id);
      debugTrace.push(`release-blind: ${releaseIdsToFetch.length}`);
    }
  }
}

if (releaseIdsToFetch.length === 0) {
  return res.json({ extraartists: [], tracklist: [], notFound: true, _debug: debugTrace });
}

const releases = await Promise.allSettled(
  releaseIdsToFetch.map(id => fetchJson(`https://api.discogs.com/releases/${id}?${TOKEN_Q.slice(1)}`))
);
const validReleases = releases
  .filter(r => r.status === 'fulfilled' && r.value)
  .map(r => r.value);

debugTrace.push(`releases-ok: ${validReleases.length}/${releaseIdsToFetch.length}`);

if (validReleases.length === 0) {
  return res.json({ extraartists: [], tracklist: [], notFound: true, _debug: debugTrace });
}

const primary = [...validReleases].sort((a, b) => (b.extraartists?.length || 0) - (a.extraartists?.length || 0))[0];

const topLevelArtists = validReleases.flatMap(r => r.extraartists || []);
const trackLevelArtists = validReleases.flatMap(r =>
  (r.tracklist || []).flatMap(t => t.extraartists || [])
);
// ★ main artists도 크레딧에 포함 (Miles Davis의 sextet 멤버가 여기 들어있는 경우)
const mainArtists = validReleases.flatMap(r =>
  (r.artists || []).map(a => ({ ...a, role: a.role || 'Main Artist' }))
);

const allExtraArtists = mergeArtists([...topLevelArtists, ...trackLevelArtists, ...mainArtists]);

debugTrace.push(`credits: top=${topLevelArtists.length}, track=${trackLevelArtists.length}, main=${mainArtists.length}, merged=${allExtraArtists.length}`);

res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
return res.json({
  ...primary,
  extraartists: allExtraArtists,
  tracklist: mergeTracklists(validReleases.map(r => r.tracklist || [])),
  _debug: debugTrace
});
```

} catch (e) {
return res.status(500).json({ error: e.message });
}
}