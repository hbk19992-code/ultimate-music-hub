// /api/getDiscogsDeep.js  V2 - Lightweight & Resilient
// “더 찾아보기” 심층 검색 — Vercel 10초 timeout 안에서 안전하게 동작하도록 경량화
//
// V1 문제점:
//   - 25개 동시 fetch → Discogs rate limit (분당 25회) 초과 → 429
//   - 일부 응답 지연 시 Vercel serverless 10초 timeout 초과
//
// V2 개선:
//   - 동시 요청 수를 5개로 제한 (배치 처리)
//   - 전체 요청 수를 13개로 축소
//   - 429 응답 시 즉시 부분 결과 반환 (전체 실패 X)
//   - 모든 단계가 try/catch로 격리되어 한 단계 실패해도 다른 결과 반환

export default async function handler(req, res) {
const { artistName } = req.query;
if (!artistName) {
return res.status(400).json({ error: ‘artistName is required’ });
}

const TOKEN = process.env.DISCOGS_TOKEN;
const headers = {
‘User-Agent’: ‘CanYouDigIt/1.0 +https://owb-digging.app’
};
const tokenQ = TOKEN ? `&token=${TOKEN}` : ‘’;
const artistNameLower = artistName.toLowerCase();

// 4초 타임아웃으로 단축 (10초 함수 limit 안에서 여러 요청 가능하게)
const fetchJson = async (url, timeoutMs = 4500) => {
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), timeoutMs);
try {
const r = await fetch(url, { headers, signal: ctrl.signal });
clearTimeout(t);
if (r.status === 429) return { _rateLimited: true };
if (!r.ok) return null;
return await r.json();
} catch (e) {
clearTimeout(t);
return null;
}
};

// 배치 처리: N개씩 순차 처리
const batchFetch = async (urls, batchSize = 5) => {
const all = [];
for (let i = 0; i < urls.length; i += batchSize) {
const batch = urls.slice(i, i + batchSize);
const results = await Promise.all(batch.map(u => fetchJson(u)));
all.push(…results);
// rate limit 감지 시 즉시 중단
if (results.some(r => r?._rateLimited)) {
console.warn(‘Rate limit detected, stopping further requests’);
return { results: all, rateLimited: true };
}
}
return { results: all, rateLimited: false };
};

// 결과 파서 (재사용)
const parseResults = (rawResults, badge, role) => {
const out = [];
const seenIds = new Set();
rawResults.forEach(d => {
if (!d || d._rateLimited || !d.results) return;
d.results.forEach(r => {
if (!r.title || seenIds.has(r.id)) return;
seenIds.add(r.id);
const fullTitle = (r.title || ‘’).toLowerCase();
// 아티스트명이 결과에 들어 있는지 확인 (오탐 방지)
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

try {
// === STEP 1: 아티스트 ID 확보 (1 req) ===
const sData = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${tokenQ}`
);
if (!sData || sData._rateLimited) {
return res.status(503).json({
error: sData?._rateLimited
? ‘Discogs API rate limit exceeded. Please try again in a minute.’
: ‘Failed to reach Discogs API.’,
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [], total: 0
});
}
if (!sData.results?.length) {
return res.json({ appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [], total: 0 });
}
const exactMatch = sData.results.find(r => r.title?.toLowerCase() === artistName.toLowerCase());
const artist = exactMatch || sData.results[0];
const artistId = artist.id;

```
// === STEP 2: 디스코그래피 깊이 페이지네이션 (3 req: page 4,5,6) ===
let appearances = [];
let rateLimited = false;
try {
  const pageUrls = [4, 5, 6].map(p =>
    `https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=${p}&sort=year&sort_order=desc${tokenQ}`
  );
  const { results: pageResults, rateLimited: rl1 } = await batchFetch(pageUrls, 3);
  rateLimited = rl1;
  const seen = new Set();
  pageResults.forEach(d => {
    if (!d || d._rateLimited || !d.releases) return;
    d.releases.forEach(r => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      if (r.role && r.role !== 'Main' && r.artist && r.title) {
        appearances.push({
          title: r.title,
          artist: r.artist,
          year: r.year || null,
          role: r.role,
          thumb: r.thumb || '',
          discogsId: r.id,
          _badge: 'SIDEMAN'
        });
      }
    });
  });
} catch (e) {
  console.warn('Step 2 failed:', e.message);
}

if (rateLimited) {
  // rate limit이면 여기서 중단하고 부분 결과 반환
  return res.json({
    appearances: dedup(appearances),
    searchHits: [], compHits: [], featHits: [], keywordHits: [],
    total: appearances.length,
    partialResults: true,
    warning: 'Discogs rate limit reached. Showing partial results from artist discography.'
  });
}

// === STEP 3: V.A. 컴필레이션 전용 검색 (2 req) ===
let compHits = [];
try {
  const compUrls = [1, 2].map(p =>
    `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=${p}${tokenQ}`
  );
  const { results: compResults, rateLimited: rl2 } = await batchFetch(compUrls, 2);
  compHits = parseResults(compResults, 'V.A.', 'V.A. Compilation');
  if (rl2) rateLimited = true;
} catch (e) {
  console.warn('Step 3 failed:', e.message);
}

if (rateLimited) {
  return res.json({
    appearances: dedup(appearances),
    searchHits: [], compHits: dedup(compHits), featHits: [], keywordHits: [],
    total: appearances.length + compHits.length,
    partialResults: true,
    warning: 'Discogs rate limit reached. Some search results omitted.'
  });
}

// === STEP 4: 키워드 검색 추가 페이지 (3 req: page 2,3,4) ===
let searchHits = [];
try {
  const searchUrls = [2, 3, 4].map(p =>
    `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&per_page=100&page=${p}${tokenQ}`
  );
  const { results: searchResults, rateLimited: rl3 } = await batchFetch(searchUrls, 3);
  searchHits = parseResults(searchResults, 'SIDEMAN', 'Credit');
  if (rl3) rateLimited = true;
} catch (e) {
  console.warn('Step 4 failed:', e.message);
}

// === STEP 5: 키워드 조합 검색 (4 req: summit/tribute/guest/session) ===
let keywordHits = [];
if (!rateLimited) {
  try {
    const KEYWORDS = ['summit', 'tribute', 'guest', 'session'];
    const keywordUrls = KEYWORDS.map(kw =>
      `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName + ' ' + kw)}&type=release&per_page=50${tokenQ}`
    );
    const { results: keywordResults, rateLimited: rl4 } = await batchFetch(keywordUrls, 4);
    keywordHits = parseResults(keywordResults, 'DEEP', 'Deep Search');
    if (rl4) rateLimited = true;
  } catch (e) {
    console.warn('Step 5 failed:', e.message);
  }
}

// featHits는 V1 API (getDiscogsAppearances)에서 이미 가져왔으므로 여기서는 생략
const featHits = [];

function dedup(arr) {
  const seen = new Set();
  return arr.filter(a => {
    const key = `${(a.title || '').toLowerCase()}_${(a.artist || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sortByYear = (arr) =>
  arr.sort((a, b) => (b.year || 0) - (a.year || 0));

const result = {
  appearances: sortByYear(dedup(appearances)),
  searchHits: sortByYear(dedup(searchHits)),
  compHits: sortByYear(dedup(compHits)),
  featHits: sortByYear(dedup(featHits)),
  keywordHits: sortByYear(dedup(keywordHits)),
  artistId,
  partialResults: rateLimited,
  total: 0
};
result.total =
  result.appearances.length +
  result.searchHits.length +
  result.compHits.length +
  result.featHits.length +
  result.keywordHits.length;

if (rateLimited) {
  result.warning = 'Discogs rate limit reached. Some results may be missing.';
}

res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
res.json(result);
```

} catch (e) {
console.error(‘Deep search fatal error:’, e);
res.status(500).json({
error: e.message || ‘Internal server error’,
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: [], total: 0
});
}
}
