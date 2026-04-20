// /api/getDiscogs.js  V8 — Robust matching for legacy artists (Miles Davis etc.)

const TOKEN = process.env.DISCOGS_TOKEN;
const TOKEN_Q = TOKEN ? `&token=${TOKEN}` : ‘’;
const HEADERS = { ‘User-Agent’: ‘CanYouDigIt/1.0 +https://owb-digging.app’ };

// ––––– Helpers –––––
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

// 제목 정규화 — 매칭 비교용 (특수문자/공백 제거)
function normalizeForMatch(s) {
return (s || ‘’)
.toLowerCase()
.replace(/[’’`]/g, ‘’)                      // 아포스트로피 제거
.replace(/[^\p{L}\p{N}]+/gu, ’ ’)           // 영숫자/한글/라틴 이외는 공백
.trim()
.replace(/\s+/g, ’ ’);
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
tracksByKey.set(key, {
…track,
extraartists: […(track.extraartists || [])]
});
order.push(key);
} else {
const existing = tracksByKey.get(key);
existing.extraartists = mergeArtists([
…existing.extraartists,
…(track.extraartists || [])
]);
}
});
});
return order.map(k => tracksByKey.get(k));
}

// 마스터/릴리즈 스코어링 — 정식 앨범 우선, 크레딧 수가 많을수록 우선
function scoreRelease(rel) {
let score = 0;
const formats = (Array.isArray(rel.format) ? rel.format.join(’ ’) : (rel.format || ‘’)).toLowerCase();
if (formats.includes(‘cd’)) score += 10;
if (formats.includes(‘album’)) score += 5;
if (/deluxe|expanded|special|remaster/i.test(formats + ’ ’ + (rel.title || ‘’))) score += 4;
if (rel.community?.have) score += Math.min(rel.community.have / 100, 3);
return score;
}

// 제목 꼬리표 제거
function sanitizeTitle(title) {
if (!title) return “”;
return title
.replace(/\s*[([].*?(remaster|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp|legacy|anniversary|collector).*?[)]]/gi, ‘’)
.replace(/\s*-\s*(remaster|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp|legacy|anniversary|collector).*$/gi, ‘’)
.replace(/\s+/g, ’ ’)
.trim();
}

// 마스터 결과에서 최적 매칭 찾기 — 정규화 후 비교
function findBestMasterMatch(results, targetTitle, targetArtist) {
if (!results?.length) return null;

const targetTitleNorm = normalizeForMatch(sanitizeTitle(targetTitle));
const targetArtistNorm = normalizeForMatch(targetArtist);

const scored = results.map(r => {
// Discogs master title은 보통 “Artist - Title” 형태
const raw = r.title || ‘’;
const parts = raw.includes(’ - ‘) ? raw.split(’ - ‘) : [raw];
const discogsArtist = parts.length >= 2 ? parts[0] : ‘’;
const discogsTitle = parts.length >= 2 ? parts.slice(1).join(’ - ’) : raw;

```
const titleNorm = normalizeForMatch(sanitizeTitle(discogsTitle));
const artistNorm = normalizeForMatch(discogsArtist);

let score = 0;
// 제목 매칭 — 정확일치가 최우선
if (titleNorm === targetTitleNorm) score += 100;
else if (titleNorm.includes(targetTitleNorm) || targetTitleNorm.includes(titleNorm)) score += 50;
else {
  // 토큰 매칭 (부분 일치)
  const targetTokens = targetTitleNorm.split(' ').filter(t => t.length > 2);
  const matchedTokens = targetTokens.filter(t => titleNorm.includes(t)).length;
  if (targetTokens.length > 0) score += (matchedTokens / targetTokens.length) * 30;
}

// 아티스트 매칭 — 정확일치 우선, 부분 일치도 점수
if (artistNorm === targetArtistNorm) score += 40;
else if (artistNorm.includes(targetArtistNorm) || targetArtistNorm.includes(artistNorm)) score += 20;

// 커뮤니티 보유수 (인기도) — 정식 앨범일 가능성 높음
if (r.community?.have) score += Math.min(r.community.have / 200, 5);

return { result: r, score };
```

}).sort((a, b) => b.score - a.score);

// 스코어 30 미만이면 매칭 없다고 판단 (잘못된 앨범 반환 방지)
if (scored[0].score < 30) return null;
return scored[0].result;
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
const { albumTitle, artistName, deepSearch, sessionName } = req.query;

// ============================================================
// MODE 1: Deep Session Search
// ============================================================
if (deepSearch === ‘true’ && artistName && sessionName) {
try {
const sniperUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&q=${encodeURIComponent(sessionName)}&type=release&per_page=100${TOKEN_Q}`;
const searchRes = await fetchJson(sniperUrl);

```
  if (!searchRes || !searchRes.results) {
    return res.json({ matchedTitles: [] });
  }

  const matchedTitles = new Set();
  searchRes.results.forEach(r => {
    const rawTitle = r.title.includes(' - ') ? r.title.split(' - ').slice(1).join(' - ') : r.title;
    matchedTitles.add(sanitizeTitle(rawTitle));
  });

  return res.json({ matchedTitles: Array.from(matchedTitles) });
} catch (e) {
  return res.status(500).json({ error: e.message, matchedTitles: [] });
}
```

}

// ============================================================
// MODE 2: Album Credits
// ============================================================
if (!albumTitle || !artistName) return res.status(400).json({ error: ‘Required params missing’ });

try {
const cleanAlbumTitle = sanitizeTitle(albumTitle);

```
// --- Strategy 1: Master search with artist + title (per_page=15 확대) ---
const masterSearchUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&release_title=${encodeURIComponent(cleanAlbumTitle)}&type=master&per_page=15${TOKEN_Q}`;
let masterSearch = await fetchJson(masterSearchUrl);

// Fallback: 일반 q 검색
if (!masterSearch?.results?.length) {
  const queryStr = encodeURIComponent(`${artistName} ${cleanAlbumTitle}`);
  masterSearch = await fetchJson(
    `https://api.discogs.com/database/search?q=${queryStr}&type=master&per_page=15${TOKEN_Q}`
  );
}

let masterId = null;
if (masterSearch?.results?.length) {
  const best = findBestMasterMatch(masterSearch.results, cleanAlbumTitle, artistName);
  if (best) masterId = best.id;
}

let releaseIdsToFetch = [];
if (masterId) {
  const versions = await fetchJson(`https://api.discogs.com/masters/${masterId}/versions?per_page=25${TOKEN_Q}`);
  if (versions?.versions) {
    const top = versions.versions
      .filter(v => v.id)
      .map(v => ({ v, s: scoreRelease(v) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)  // 4 → 5로 확대
      .map(x => x.v.id);
    releaseIdsToFetch = top;
  }
}

// --- Strategy 2: Release search (master가 없거나 실패한 경우) ---
if (releaseIdsToFetch.length === 0) {
  // artist + release_title 정밀 검색 우선
  let relSearch = await fetchJson(
    `https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&release_title=${encodeURIComponent(cleanAlbumTitle)}&type=release&per_page=15${TOKEN_Q}`
  );
  // 폴백: 일반 q 검색
  if (!relSearch?.results?.length) {
    const queryStr = encodeURIComponent(`${artistName} ${cleanAlbumTitle}`);
    relSearch = await fetchJson(`https://api.discogs.com/database/search?q=${queryStr}&type=release&per_page=15${TOKEN_Q}`);
  }

  if (relSearch?.results?.length) {
    // 릴리즈도 정규화 매칭으로 상위 5개
    const best = findBestMasterMatch(relSearch.results, cleanAlbumTitle, artistName);
    if (best) {
      // best 기준으로 유사한 릴리즈 5개 가져옴 (master 없으면 단건도 OK)
      releaseIdsToFetch = [best.id];
      // 추가로 상위 결과 몇 개 더 (크레딧 병합)
      relSearch.results.slice(0, 5).forEach(r => {
        if (r.id !== best.id && !releaseIdsToFetch.includes(r.id)) {
          releaseIdsToFetch.push(r.id);
        }
      });
    } else {
      // 매칭 실패 — 첫 결과만
      releaseIdsToFetch = relSearch.results.slice(0, 3).map(r => r.id);
    }
  }
}

if (releaseIdsToFetch.length === 0) {
  return res.json({ extraartists: [], tracklist: [], notFound: true, reason: 'no-master-or-release-match' });
}

// --- Release 상세 fetch (여러 개 병렬) ---
const releases = await Promise.allSettled(
  releaseIdsToFetch.map(id => fetchJson(`https://api.discogs.com/releases/${id}?${TOKEN_Q.slice(1)}`))
);
const validReleases = releases
  .filter(r => r.status === 'fulfilled' && r.value)
  .map(r => r.value);

if (validReleases.length === 0) {
  return res.json({ extraartists: [], tracklist: [], notFound: true, reason: 'all-releases-failed' });
}

// 크레딧 수가 가장 많은 릴리즈를 primary로
const primary = [...validReleases].sort((a, b) => (b.extraartists?.length || 0) - (a.extraartists?.length || 0))[0];

// ★ 핵심 개선: top-level extraartists + tracklist의 track extraartists 모두 병합
//    → 일부 Discogs 릴리즈는 master-level에 크레딧이 없고 각 트랙에만 있음
const topLevelArtists = validReleases.flatMap(r => r.extraartists || []);
const trackLevelArtists = validReleases.flatMap(r =>
  (r.tracklist || []).flatMap(t => t.extraartists || [])
);
const allExtraArtists = mergeArtists([...topLevelArtists, ...trackLevelArtists]);

// 캐시 헤더 (5분)
res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
return res.json({
  ...primary,
  extraartists: allExtraArtists,
  tracklist: mergeTracklists(validReleases.map(r => r.tracklist || [])),
  _debug: {
    strategy: masterId ? 'master' : 'release',
    releasesTried: releaseIdsToFetch.length,
    releasesOk: validReleases.length,
    topLevelCredits: topLevelArtists.length,
    trackLevelCredits: trackLevelArtists.length,
    mergedCredits: allExtraArtists.length
  }
});
```

} catch (e) {
return res.status(500).json({ error: e.message });
}
}