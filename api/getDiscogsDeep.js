// /api/getDiscogsDeep.js  V4 - Vercel Hobby 10s 호환 버전
//
// V3 문제: 1번 호출에 13개 요청 → 10초 timeout 초과 (FUNCTION_INVOCATION_TIMEOUT)
//
// V4 해결: “stage” 파라미터로 한 번에 2~3개 요청만 처리.
// 프론트엔드가 여러 번 호출하며 단계별로 누적. 각 호출은 3~5초에 끝남.
//
// 사용법:
//   /api/getDiscogsDeep?artistName=X&stage=1  → 아티스트 ID + 디스코그래피 page 4
//   /api/getDiscogsDeep?artistName=X&stage=2&artistId=123  → 디스코그래피 page 5, 6
//   /api/getDiscogsDeep?artistName=X&stage=3  → V.A. Compilation 검색
//   /api/getDiscogsDeep?artistName=X&stage=4  → 키워드 추가 페이지
//   /api/getDiscogsDeep?artistName=X&stage=5  → summit/tribute/guest 키워드

export default async function handler(req, res) {
try {
return await mainHandler(req, res);
} catch (topError) {
console.error(’[getDiscogsDeep] TOP-LEVEL ERROR:’, topError);
return res.status(500).json({
error: `Top-level crash: ${topError?.message || String(topError)}`,
results: [], done: false
});
}
}

async function mainHandler(req, res) {
const { artistName, stage, artistId: artistIdParam } = req.query;
if (!artistName) {
return res.status(400).json({ error: ‘artistName is required’, results: [], done: false });
}

if (typeof fetch !== ‘function’) {
return res.status(500).json({
error: ‘fetch unavailable. Upgrade to Node 18+.’,
results: [], done: false
});
}

const TOKEN = process.env.DISCOGS_TOKEN;
const headers = { ‘User-Agent’: ‘CanYouDigIt/1.0 +https://owb-digging.app’ };
const tokenQ = TOKEN ? `&token=${TOKEN}` : ‘’;
const artistNameLower = artistName.toLowerCase();

const fetchJson = async (url, timeoutMs = 3500) => {
let ctrl = null, timeoutId = null;
try {
ctrl = new AbortController();
timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);
const r = await fetch(url, { headers, signal: ctrl.signal });
clearTimeout(timeoutId);
if (r.status === 429) return { _rateLimited: true };
if (!r.ok) return { _httpError: r.status };
return await r.json();
} catch (e) {
if (timeoutId) clearTimeout(timeoutId);
return { _fetchError: e?.message || ‘unknown’ };
}
};

const parseSearchResults = (rawResults, badge, role) => {
const out = [];
const seenIds = new Set();
rawResults.forEach(d => {
if (!d || d._rateLimited || d._httpError || d._fetchError || !d.results) return;
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
      role,
      thumb: r.thumb || '',
      discogsId: r.id,
      _badge: badge
    });
  });
});
return out;
```

};

const parseReleasePages = (pageResults) => {
const out = [];
const seen = new Set();
pageResults.forEach(d => {
if (!d || d._rateLimited || d._httpError || d._fetchError || !d.releases) return;
d.releases.forEach(r => {
if (seen.has(r.id)) return;
seen.add(r.id);
if (r.role && r.role !== ‘Main’ && r.artist && r.title) {
out.push({
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
return out;
};

const stageNum = parseInt(stage || ‘1’, 10);

// =========== STAGE 1: Artist ID + Disco page 4 ===========
if (stageNum === 1) {
const sData = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${tokenQ}`
);
if (!sData || sData._rateLimited || sData._httpError || sData._fetchError) {
return res.status(200).json({
error: sData?._rateLimited ? ‘Rate limit’ : ‘Artist lookup failed’,
results: [], done: false, nextStage: null
});
}
if (!sData.results?.length) {
return res.status(200).json({
error: ‘Artist not found’, results: [], done: true, nextStage: null
});
}
const exactMatch = sData.results.find(r => r.title?.toLowerCase() === artistNameLower);
const artist = exactMatch || sData.results[0];
const artistId = artist.id;

```
// Disco page 4
const pageData = await fetchJson(
  `https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=4&sort=year&sort_order=desc${tokenQ}`
);
const results = parseReleasePages([pageData]);

return res.status(200).json({
  results, done: false, nextStage: 2, artistId, stageLabel: '디스코그래피 4페이지'
});
```

}

// =========== STAGE 2: Disco page 5, 6 ===========
if (stageNum === 2) {
if (!artistIdParam) {
return res.status(400).json({ error: ‘artistId required for stage 2’, results: [], done: false });
}
const urls = [5, 6].map(p =>
`https://api.discogs.com/artists/${artistIdParam}/releases?per_page=100&page=${p}&sort=year&sort_order=desc${tokenQ}`
);
const pageResults = await Promise.all(urls.map(u => fetchJson(u)));
const results = parseReleasePages(pageResults);

```
return res.status(200).json({
  results, done: false, nextStage: 3, artistId: artistIdParam, stageLabel: '디스코그래피 5-6페이지'
});
```

}

// =========== STAGE 3: V.A. Compilation ===========
if (stageNum === 3) {
const urls = [1, 2].map(p =>
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=${p}${tokenQ}`
);
const raw = await Promise.all(urls.map(u => fetchJson(u)));
const results = parseSearchResults(raw, ‘V.A.’, ‘V.A. Compilation’);

```
return res.status(200).json({
  results, done: false, nextStage: 4, artistId: artistIdParam, stageLabel: 'V.A. 컴필레이션'
});
```

}

// =========== STAGE 4: Keyword search pages 2-3 ===========
if (stageNum === 4) {
const urls = [2, 3].map(p =>
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&per_page=100&page=${p}${tokenQ}`
);
const raw = await Promise.all(urls.map(u => fetchJson(u)));
const results = parseSearchResults(raw, ‘SIDEMAN’, ‘Credit’);

```
return res.status(200).json({
  results, done: false, nextStage: 5, artistId: artistIdParam, stageLabel: '키워드 확장 검색'
});
```

}

// =========== STAGE 5: Special keyword combos ===========
if (stageNum === 5) {
const KEYWORDS = [‘summit’, ‘tribute’, ‘guest’];
const urls = KEYWORDS.map(kw =>
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName + ' ' + kw)}&type=release&per_page=50${tokenQ}`
);
const raw = await Promise.all(urls.map(u => fetchJson(u)));
const results = parseSearchResults(raw, ‘DEEP’, ‘Deep Search’);

```
return res.status(200).json({
  results, done: true, nextStage: null, artistId: artistIdParam, stageLabel: '특수 키워드 검색'
});
```

}

return res.status(400).json({ error: `Unknown stage: ${stageNum}`, results: [], done: true });
}