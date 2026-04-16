// /api/getDiscogsAppearances.js  V4
// 사이드맨 + 밴드 + feat. + Various Artists 컴필레이션까지 모두 발굴
//
// 주요 개선 (V3 -> V4):
//   - 본인 디스코그래피(/artists/{id}/releases)를 3페이지까지 페이지네이션
//     -> “Alternative Guitar Summit” 같은 V.A. 컴필레이션 누락 해결
//   - feat 검색 결과의 필터를 완화 (V.A. / 다중 아티스트 허용)
//   - searchHits 필터 완화: feat/with/and/&/, 포함 시 통과
//   - 결과 정렬: 연도 내림차순

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

const fetchJson = async (url, timeoutMs = 8000) => {
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
// === 1) 아티스트 검색 -> ID 획득 ===
const searchUrl = `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${tokenQ}`;
const sData = await fetchJson(searchUrl);
if (!sData?.results?.length) {
return res.json({ groups: [], groupReleases: [], appearances: [], searchHits: [], featHits: [], total: 0 });
}

```
const exactMatch = sData.results.find(r =>
  r.title?.toLowerCase() === artistName.toLowerCase()
);
const artist = exactMatch || sData.results[0];
const artistId = artist.id;

// === 2) 아티스트 상세 -> groups (소속 밴드) ===
const detailUrl = `https://api.discogs.com/artists/${artistId}?${tokenQ.slice(1)}`;
const detail = await fetchJson(detailUrl);
const groups = (detail?.groups || []).slice(0, 5);

// === 3) 각 그룹의 releases (병렬) ===
const groupReleases = [];
if (groups.length > 0) {
  const groupResults = await Promise.allSettled(
    groups.map(g =>
      fetchJson(`https://api.discogs.com/artists/${g.id}/releases?per_page=50&sort=year&sort_order=desc${tokenQ}`)
    )
  );
  groupResults.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value?.releases) {
      r.value.releases.forEach(rel => {
        if (rel.role === 'Main' && rel.title && rel.artist) {
          groupReleases.push({
            title: rel.title,
            artist: rel.artist,
            year: rel.year || null,
            role: `Member of ${groups[idx].name}`,
            thumb: rel.thumb || '',
            discogsId: rel.id,
            groupName: groups[idx].name
          });
        }
      });
    }
  });
}

// === 4) 본인 디스코그래피 사이드맨 -- 3페이지 페이지네이션 ===
//   100개 제한 시 V.A. 컴필레이션 (Alternative Guitar Summit 등)이 누락됨
const appearances = [];
const appearancePages = await Promise.allSettled([
  fetchJson(`https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=1&sort=year&sort_order=desc${tokenQ}`),
  fetchJson(`https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=2&sort=year&sort_order=desc${tokenQ}`),
  fetchJson(`https://api.discogs.com/artists/${artistId}/releases?per_page=100&page=3&sort=year&sort_order=desc${tokenQ}`)
]);
const appSeenIds = new Set();
appearancePages.forEach(pg => {
  if (pg.status === 'fulfilled' && pg.value?.releases) {
    pg.value.releases.forEach(r => {
      if (appSeenIds.has(r.id)) return;
      appSeenIds.add(r.id);
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

// === 5) 키워드 검색 (사이드맨 발굴) -- 필터 완화 ===
const searchHits = [];
const searchHitsRaw = await fetchJson(
  `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&per_page=100${tokenQ}`
);
const artistNameLower = artistName.toLowerCase();
if (searchHitsRaw?.results) {
  searchHitsRaw.results.forEach(r => {
    if (!r.title) return;
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
    // 다중 아티스트/V.A./feat. 표기는 통과
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
}

// === 6) "feat." 피처링 전용 검색 ===
const featHits = [];
const featQueries = [
  `feat ${artistName}`,
  `featuring ${artistName}`,
  `with ${artistName}`,
  `ft ${artistName}`
];

const featResults = await Promise.allSettled(
  featQueries.map(q =>
    fetchJson(
      `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=50${tokenQ}`
    )
  )
);

const featSeenIds = new Set();
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

// === 7) 중복 제거 + 연도 내림차순 정렬 ===
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
  groups: groups.map(g => ({ name: g.name, id: g.id })),
  groupReleases: sortByYear(dedup(groupReleases)),
  appearances: sortByYear(dedup(appearances)),
  searchHits: sortByYear(dedup(searchHits)),
  featHits: sortByYear(dedup(featHits)),
  artistId,
  total: 0
};
result.total = result.groupReleases.length + result.appearances.length + result.searchHits.length + result.featHits.length;

res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
res.json(result);
```

} catch (e) {
res.status(500).json({
error: e.message,
groups: [], groupReleases: [], appearances: [], searchHits: [], featHits: []
});
}
}