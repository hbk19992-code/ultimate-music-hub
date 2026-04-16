// /api/getDiscogsDeep.js  V3 - Hardened
// 에러가 나더라도 반드시 JSON 응답을 반환하고, 어느 단계에서 실패했는지 추적 가능

export const config = {
maxDuration: 30  // Vercel Pro는 60, Hobby는 10 → 명시해서 최대치 요청
};

export default async function handler(req, res) {
// 🔒 모든 에러를 잡아서 JSON으로 반환하는 최상위 래퍼
try {
return await mainHandler(req, res);
} catch (topError) {
console.error(’[getDiscogsDeep] TOP-LEVEL ERROR:’, topError);
return res.status(500).json({
error: `Top-level crash: ${topError?.message || String(topError)}`,
stack: topError?.stack?.split(’\n’).slice(0, 3).join(’ | ’),
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [], total: 0
});
}
}

async function mainHandler(req, res) {
const { artistName } = req.query;
if (!artistName) {
return res.status(400).json({ error: ‘artistName is required’ });
}

// Node 18+ global fetch 존재 확인
if (typeof fetch !== ‘function’) {
return res.status(500).json({
error: ‘fetch is not available on this Node runtime. Upgrade to Node 18+ in Vercel project settings.’,
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [], total: 0
});
}

const TOKEN = process.env.DISCOGS_TOKEN;
const headers = {
‘User-Agent’: ‘CanYouDigIt/1.0 +https://owb-digging.app’
};
const tokenQ = TOKEN ? `&token=${TOKEN}` : ‘’;
const artistNameLower = artistName.toLowerCase();
const debug = { steps: [] };

// 안전한 fetch (4.5초 타임아웃, 에러 시 null 반환)
const fetchJson = async (url, timeoutMs = 4500) => {
let ctrl = null;
let timeoutId = null;
try {
ctrl = new AbortController();
timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);
const r = await fetch(url, { headers, signal: ctrl.signal });
clearTimeout(timeoutId);
if (r.status === 429) return { _rateLimited: true };
if (!r.ok) return { _httpError: r.status };
const txt = await r.text();
try {
return JSON.parse(txt);
} catch (parseErr) {
return { _parseError: true };
}
} catch (e) {
if (timeoutId) clearTimeout(timeoutId);
return { _fetchError: e?.message || ‘unknown’ };
}
};

// 배치 처리 (동시 요청 제한)
const batchFetch = async (urls, batchSize = 3) => {
const all = [];
let rateLimited = false;
for (let i = 0; i < urls.length; i += batchSize) {
const batch = urls.slice(i, i + batchSize);
const results = await Promise.all(batch.map(u => fetchJson(u)));
all.push(…results);
if (results.some(r => r?._rateLimited)) {
rateLimited = true;
break;
}
}
return { results: all, rateLimited };
};

const parseSearchResults = (rawResults, badge, role) => {
const out = [];
const seenIds = new Set();
rawResults.forEach(d => {
if (!d || d._rateLimited || d._httpError || d._fetchError || d._parseError) return;
if (!d.results) return;
d.results.forEach(r => {
if (!r.title || seenIds.has(r.id)) return;
seenIds.add(r.id);
const fullTitle = (r.title || ‘’).toLowerCase();
if (!fullTitle.includes(artistNameLower)) return;

```
    const parts = (r.title || '').split(' - ');
    let albumTitle = '', albumArtist = '';
    if (parts.length >= 2) {
      albumArtist = parts[0].trim();
      albumTitle = parts.slice(1).join(' - ').trim();
    } else {
      albumTitle = r.title;
    }
    if (albumArtist.toLowerCase() === artistNameLower) return;

    out.push({
      title: albumTitle,
      artist: albumArtist || 'Various',
      year: r.year || null,
      role: role,
      thumb: r.thumb || '',
      discogsId: r.id,
      _badge: badge
    });
  });
});
return out;
```

};

const dedup = (arr) => {
const seen = new Set();
return arr.filter(a => {
const key = `${(a.title || '').toLowerCase()}_${(a.artist || '').toLowerCase()}`;
if (seen.has(key)) return false;
seen.add(key);
return true;
});
};

const sortByYear = (arr) =>
arr.sort((a, b) => (b.year || 0) - (a.year || 0));

// ================ STEP 1: 아티스트 ID ================
debug.steps.push(‘step1_start’);
let artistId = null;
try {
const sData = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${tokenQ}`
);
debug.steps.push(`step1_response:${sData ? 'ok' : 'null'}`);
if (!sData) throw new Error(‘step1 null’);
if (sData._rateLimited) {
return res.status(200).json({
partialResults: true,
warning: ‘Rate limit hit during artist lookup’,
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [],
total: 0, debug
});
}
if (sData._httpError || sData._fetchError || sData._parseError) {
throw new Error(`step1 failed: ${JSON.stringify(sData)}`);
}
if (!sData.results?.length) {
return res.status(200).json({
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [],
total: 0, warning: ‘Artist not found on Discogs’, debug
});
}
const exactMatch = sData.results.find(r => r.title?.toLowerCase() === artistName.toLowerCase());
const artist = exactMatch || sData.results[0];
artistId = artist.id;
debug.steps.push(`step1_artistId:${artistId}`);
} catch (e) {
return res.status(500).json({
error: `Step 1 failed: ${e.message}`,
debug,
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [], total: 0
});
}

// ================ STEP 2: 디스코그래피 페이지 4-6 ================
debug.steps.push(‘step2_start’);
let appearances = [];
let stopEarly = false;
try {
const pageUrls = [4, 5, 6].map(p =>
`https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=${p}&sort=year&sort_order=desc${tokenQ}`
);
const { results: pageResults, rateLimited } = await batchFetch(pageUrls, 3);
if (rateLimited) stopEarly = true;
const seen = new Set();
pageResults.forEach(d => {
if (!d || d._rateLimited || d._httpError || d._fetchError || d._parseError) return;
if (!d.releases) return;
d.releases.forEach(r => {
if (seen.has(r.id)) return;
seen.add(r.id);
if (r.role && r.role !== ‘Main’ && r.artist && r.title) {
appearances.push({
title: r.title,
artist: r.artist,
year: r.year || null,
role: r.role,
thumb: r.thumb || ‘’,
discogsId: r.id,
_badge: ‘SIDEMAN’
});
}
});
});
debug.steps.push(`step2_got:${appearances.length}`);
} catch (e) {
debug.steps.push(`step2_error:${e.message}`);
}

// ================ STEP 3: V.A. 컴필레이션 ================
let compHits = [];
if (!stopEarly) {
debug.steps.push(‘step3_start’);
try {
const compUrls = [1, 2].map(p =>
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=${p}${tokenQ}`
);
const { results: compResults, rateLimited } = await batchFetch(compUrls, 2);
if (rateLimited) stopEarly = true;
compHits = parseSearchResults(compResults, ‘V.A.’, ‘V.A. Compilation’);
debug.steps.push(`step3_got:${compHits.length}`);
} catch (e) {
debug.steps.push(`step3_error:${e.message}`);
}
}

// ================ STEP 4: 키워드 검색 페이지 2-3 ================
let searchHits = [];
if (!stopEarly) {
debug.steps.push(‘step4_start’);
try {
const searchUrls = [2, 3].map(p =>
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&per_page=100&page=${p}${tokenQ}`
);
const { results: searchResults, rateLimited } = await batchFetch(searchUrls, 2);
if (rateLimited) stopEarly = true;
searchHits = parseSearchResults(searchResults, ‘SIDEMAN’, ‘Credit’);
debug.steps.push(`step4_got:${searchHits.length}`);
} catch (e) {
debug.steps.push(`step4_error:${e.message}`);
}
}

// ================ STEP 5: 키워드 조합 ================
let keywordHits = [];
if (!stopEarly) {
debug.steps.push(‘step5_start’);
try {
const KEYWORDS = [‘summit’, ‘tribute’, ‘guest’];
const keywordUrls = KEYWORDS.map(kw =>
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName + ' ' + kw)}&type=release&per_page=50${tokenQ}`
);
const { results: keywordResults, rateLimited } = await batchFetch(keywordUrls, 3);
if (rateLimited) stopEarly = true;
keywordHits = parseSearchResults(keywordResults, ‘DEEP’, ‘Deep Search’);
debug.steps.push(`step5_got:${keywordHits.length}`);
} catch (e) {
debug.steps.push(`step5_error:${e.message}`);
}
}

// ================ 응답 조립 ================
const result = {
appearances: sortByYear(dedup(appearances)),
searchHits: sortByYear(dedup(searchHits)),
compHits: sortByYear(dedup(compHits)),
featHits: [],
keywordHits: sortByYear(dedup(keywordHits)),
artistId,
partialResults: stopEarly,
total: 0,
debug
};
result.total =
result.appearances.length +
result.searchHits.length +
result.compHits.length +
result.keywordHits.length;

if (stopEarly) {
result.warning = ‘Rate limit reached. Some results omitted.’;
}

res.setHeader(‘Cache-Control’, ‘s-maxage=3600, stale-while-revalidate=86400’);
return res.status(200).json(result);
}