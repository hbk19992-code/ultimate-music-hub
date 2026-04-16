// /api/getDiscogsAppearances.js  V3
// Mahavishnu Orchestra (밴드) + 사이드맨 + feat. 참여까지 모두 발굴
//
// 4단계 검색:
//   1) /artists/{id}/groups → 소속 밴드 목록 (Mahavishnu Orchestra, Shakti 등)
//   2) 각 그룹의 releases → 밴드 활동 앨범
//   3) /database/search?q={name}&type=release → 키워드로 모든 참여 릴리스
//   4) 🆕 /database/search?q=feat+{name}&type=release → “feat.” 피처링 전용 검색
//      (Alternative Guitar Summit feat. Kurt Rosenwinkel 같은 타이틀 발굴)

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
// === 1) 아티스트 검색 → ID 획득 ===
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

// === 2) 아티스트 상세 → groups (소속 밴드) ===
const detailUrl = `https://api.discogs.com/artists/${artistId}?${tokenQ.slice(1)}`;
const detail = await fetchJson(detailUrl);
const groups = (detail?.groups || []).slice(0, 5);

// === 3) 각 그룹의 releases (병렬, 그룹당 50개씩) ===
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

// === 4) 본인 디스코그래피의 사이드맨/Appearance 작업 ===
const appearances = [];
const relUrl = `https://api.discogs.com/artists/${artistId}/releases?per_page=100&sort=year&sort_order=desc${tokenQ}`;
const rData = await fetchJson(relUrl);
if (rData?.releases) {
  rData.releases.forEach(r => {
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

// === 5) 키워드 검색 (사이드맨 발굴) ===
const searchHits = [];
const searchHitsRaw = await fetchJson(
  `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&per_page=100${tokenQ}`
);
if (searchHitsRaw?.results) {
  const artistNameLower = artistName.toLowerCase();
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
    if (albumArtist.toLowerCase() === artistNameLower) return;
    if (albumArtist.toLowerCase().includes(artistNameLower) &&
        !albumArtist.toLowerCase().includes(',') &&
        !albumArtist.toLowerCase().includes('&') &&
        !albumArtist.toLowerCase().includes('feat')) return;

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

// === 6) 🆕 "feat." 피처링 전용 검색 ===
//   "feat Kurt Rosenwinkel", "featuring Kurt Rosenwinkel" 등으로 검색
//   이름이 타이틀이나 아티스트 필드에 "feat." 형태로 들어간 릴리스를 잡아냄
const featHits = [];
const featQueries = [
  `feat ${artistName}`,
  `featuring ${artistName}`,
  `ft ${artistName}`
];

const featResults = await Promise.allSettled(
  featQueries.map(q =>
    fetchJson(
      `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=50${tokenQ}`
    )
  )
);

const artistNameLower = artistName.toLowerCase();
const featSeenIds = new Set();

featResults.forEach(fr => {
  if (fr.status !== 'fulfilled' || !fr.value?.results) return;
  fr.value.results.forEach(r => {
    if (!r.title || featSeenIds.has(r.id)) return;
    featSeenIds.add(r.id);

    const fullTitle = (r.title || '').toLowerCase();
    // 아티스트 이름이 실제로 타이틀 안에 있는지 확인 (feat. 맥락)
    if (!fullTitle.includes(artistNameLower)) return;

    const parts = (r.title || '').split(' - ');
    let albumTitle = '', albumArtist = '';
    if (parts.length >= 2) {
      albumArtist = parts[0].trim();
      albumTitle = parts.slice(1).join(' - ').trim();
    } else {
      albumTitle = r.title;
    }
    // 본인이 메인 아티스트인 것은 제외
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

// === 7) 중복 제거 ===
const dedup = (arr) => {
  const seen = new Set();
  return arr.filter(a => {
    const key = `${(a.title || '').toLowerCase()}_${(a.artist || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const result = {
  groups: groups.map(g => ({ name: g.name, id: g.id })),
  groupReleases: dedup(groupReleases),
  appearances: dedup(appearances),
  searchHits: dedup(searchHits),
  featHits: dedup(featHits),
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