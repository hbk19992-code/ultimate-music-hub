// /api/getDiscogsDeep.js  V1
// “더 찾아보기” 심층 검색 전용 엔드포인트
//
// 기본 getDiscogsAppearances에서 놓치는 V.A. 컴필레이션 / 희귀 세션 참여작을 발굴.
// 속도보다 발굴량을 우선하는 모드. 사용자가 명시적으로 트리거해야 호출됨.
//
// 전략:
//   1) /artists/{id}/releases 4~10페이지 (최대 1000건 추가)
//   2) 키워드 검색 2~4페이지 추가 (최대 400건 추가)
//   3) format=Compilation 지정 검색 (V.A. 전용)
//   4) feat/featuring/with 검색 2페이지까지 확장
//   5) 역할 키워드 조합 검색 (guest, session, plays, tribute)

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

const fetchJson = async (url, timeoutMs = 10000) => {
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), timeoutMs);
try {
const r = await fetch(url, { headers, signal: ctrl.signal });
clearTimeout(t);
if (!r.ok) return null;
return await r.json();
} catch (e) {
clearTimeout(t);
return null;
}
};

try {
// === 아티스트 ID 확보 ===
const sData = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${tokenQ}`
);
if (!sData?.results?.length) {
return res.json({ appearances: [], searchHits: [], featHits: [], compHits: [], total: 0 });
}
const exactMatch = sData.results.find(r => r.title?.toLowerCase() === artistName.toLowerCase());
const artist = exactMatch || sData.results[0];
const artistId = artist.id;
const artistNameLower = artistName.toLowerCase();

```
// === 전략 1: 본인 디스코그래피 깊이 페이지네이션 (page 4~10) ===
const DEEP_PAGES = [4, 5, 6, 7, 8, 9, 10];
const deepPageResults = await Promise.allSettled(
  DEEP_PAGES.map(p =>
    fetchJson(`https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=${p}&sort=year&sort_order=desc${tokenQ}`)
  )
);

const appearances = [];
const seenIds = new Set();
deepPageResults.forEach(pg => {
  if (pg.status === 'fulfilled' && pg.value?.releases) {
    pg.value.releases.forEach(r => {
      if (seenIds.has(r.id)) return;
      seenIds.add(r.id);
      if (r.role && r.role !== 'Main' && r.artist && r.title) {
        appearances.push({
          title: r.title,
          artist: r.artist,
          year: r.year || null,
          role: r.role,
          thumb: r.thumb || '',
          discogsId: r.id
        });
      }
    });
  }
});

// === 전략 2: 키워드 검색 추가 페이지 (page 2~4) ===
const EXTRA_SEARCH_PAGES = [2, 3, 4];
const extraSearchResults = await Promise.allSettled(
  EXTRA_SEARCH_PAGES.map(p =>
    fetchJson(
      `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&per_page=100&page=${p}${tokenQ}`
    )
  )
);

const searchHits = [];
const searchSeenIds = new Set();
extraSearchResults.forEach(pg => {
  if (pg.status !== 'fulfilled' || !pg.value?.results) return;
  pg.value.results.forEach(r => {
    if (!r.title || searchSeenIds.has(r.id)) return;
    searchSeenIds.add(r.id);
    const parts = (r.title || '').split(' - ');
    let albumTitle = '', albumArtist = '';
    if (parts.length >= 2) {
      albumArtist = parts[0].trim();
      albumTitle = parts.slice(1).join(' - ').trim();
    } else {
      albumTitle = r.title;
    }
    const albumArtistLower = albumArtist.toLowerCase();
    if (albumArtistLower === artistNameLower) return;
    if (albumArtistLower.includes(artistNameLower) &&
        !/[,&]|\bfeat|\bwith|\band\b|\bvarious\b|\bv\.?a\.?\b/i.test(albumArtist)) return;

    searchHits.push({
      title: albumTitle,
      artist: albumArtist || 'Various',
      year: r.year || null,
      role: 'Credit',
      thumb: r.thumb || '',
      discogsId: r.id
    });
  });
});

// === 전략 3: Compilation 포맷 전용 검색 (V.A. 전용 필터) ===
const compHits = [];
const compSeenIds = new Set();
const compPageResults = await Promise.allSettled([
  fetchJson(
    `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=1${tokenQ}`
  ),
  fetchJson(
    `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=2${tokenQ}`
  )
]);

compPageResults.forEach(pg => {
  if (pg.status !== 'fulfilled' || !pg.value?.results) return;
  pg.value.results.forEach(r => {
    if (!r.title || compSeenIds.has(r.id)) return;
    compSeenIds.add(r.id);
    const parts = (r.title || '').split(' - ');
    let albumTitle = '', albumArtist = '';
    if (parts.length >= 2) {
      albumArtist = parts[0].trim();
      albumTitle = parts.slice(1).join(' - ').trim();
    } else {
      albumTitle = r.title;
    }
    if (albumArtist.toLowerCase() === artistNameLower) return;

    compHits.push({
      title: albumTitle,
      artist: albumArtist || 'Various',
      year: r.year || null,
      role: 'V.A. Compilation',
      thumb: r.thumb || '',
      discogsId: r.id
    });
  });
});

// === 전략 4: feat/featuring/with 2페이지까지 확장 ===
const featHits = [];
const featSeenIds = new Set();
const FEAT_TEMPLATES = [
  `feat ${artistName}`,
  `featuring ${artistName}`,
  `with ${artistName}`,
  `ft ${artistName}`,
  `presents ${artistName}`,
  `plays ${artistName}`
];
const featFetches = [];
FEAT_TEMPLATES.forEach(q => {
  featFetches.push(fetchJson(
    `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=50&page=1${tokenQ}`
  ));
  featFetches.push(fetchJson(
    `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=50&page=2${tokenQ}`
  ));
});
const featResults = await Promise.allSettled(featFetches);

featResults.forEach(fr => {
  if (fr.status !== 'fulfilled' || !fr.value?.results) return;
  fr.value.results.forEach(r => {
    if (!r.title || featSeenIds.has(r.id)) return;
    featSeenIds.add(r.id);

    const fullTitle = (r.title || '').toLowerCase();
    if (!fullTitle.includes(artistNameLower)) return;

    const parts = (r.title || '').split(' - ');
    let albumTitle = '', albumArtist = '';
    if (parts.length >= 2) {
      albumArtist = parts[0].trim();
      albumTitle = parts.slice(1).join(' - ').trim();
    } else {
      albumTitle = r.title;
    }
    if (albumArtist.toLowerCase() === artistNameLower) return;

    featHits.push({
      title: albumTitle,
      artist: albumArtist || 'Various',
      year: r.year || null,
      role: 'Featured',
      thumb: r.thumb || '',
      discogsId: r.id
    });
  });
});

// === 전략 5: 역할 키워드 조합 검색 (session/guest/tribute) ===
const keywordHits = [];
const keywordSeenIds = new Set();
const KEYWORD_COMBOS = [
  `${artistName} guest`,
  `${artistName} session`,
  `${artistName} tribute`,
  `${artistName} summit`,
  `${artistName} all stars`,
  `${artistName} guitar summit`,
  `${artistName} jazz summit`
];
const keywordFetches = KEYWORD_COMBOS.map(q =>
  fetchJson(
    `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=50${tokenQ}`
  )
);
const keywordResults = await Promise.allSettled(keywordFetches);

keywordResults.forEach(kr => {
  if (kr.status !== 'fulfilled' || !kr.value?.results) return;
  kr.value.results.forEach(r => {
    if (!r.title || keywordSeenIds.has(r.id)) return;
    keywordSeenIds.add(r.id);

    const fullTitle = (r.title || '').toLowerCase();
    if (!fullTitle.includes(artistNameLower)) return;

    const parts = (r.title || '').split(' - ');
    let albumTitle = '', albumArtist = '';
    if (parts.length >= 2) {
      albumArtist = parts[0].trim();
      albumTitle = parts.slice(1).join(' - ').trim();
    } else {
      albumTitle = r.title;
    }
    if (albumArtist.toLowerCase() === artistNameLower) return;

    keywordHits.push({
      title: albumTitle,
      artist: albumArtist || 'Various',
      year: r.year || null,
      role: 'Deep Search',
      thumb: r.thumb || '',
      discogsId: r.id
    });
  });
});

// === 통합 중복 제거 + 정렬 ===
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

const result = {
  appearances: sortByYear(dedup(appearances)),
  searchHits: sortByYear(dedup(searchHits)),
  compHits: sortByYear(dedup(compHits)),
  featHits: sortByYear(dedup(featHits)),
  keywordHits: sortByYear(dedup(keywordHits)),
  artistId,
  total: 0
};
result.total = result.appearances.length + result.searchHits.length + result.compHits.length + result.featHits.length + result.keywordHits.length;

res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
res.json(result);
```

} catch (e) {
res.status(500).json({
error: e.message,
appearances: [], searchHits: [], compHits: [], featHits: [], keywordHits: []
});
}
}