// /api/getDiscogs.js  V7 — One-Shot Sniper & Title Sanitizer Edition

const TOKEN = process.env.DISCOGS_TOKEN;
const TOKEN_Q = TOKEN ? `&token=${TOKEN}` : '';
const HEADERS = { 'User-Agent': 'CanYouDigIt/1.0 +https://owb-digging.app' };

// ---------- Helpers ----------
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

function mergeArtists(allArtists) {
  const seen = new Map();
  allArtists.forEach(ar => {
    if (!ar?.name) return;
    const cleanName = ar.name.replace(/\s\(\d+\)$/, '').trim();
    const cleanRole = (ar.role || '').trim();
    const key = `${cleanName.toLowerCase()}|${cleanRole.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.set(key, { ...ar, name: ar.name, role: cleanRole });
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
      const key = track.title.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
      if (!key) return;
      if (!tracksByKey.has(key)) {
        tracksByKey.set(key, {
          ...track,
          extraartists: [...(track.extraartists || [])]
        });
        order.push(key);
      } else {
        const existing = tracksByKey.get(key);
        existing.extraartists = mergeArtists([
          ...existing.extraartists,
          ...(track.extraartists || [])
        ]);
      }
    });
  });
  return order.map(k => tracksByKey.get(k));
}

function scoreRelease(rel) {
  let score = 0;
  const formats = (Array.isArray(rel.format) ? rel.format.join(' ') : (rel.format || '')).toLowerCase();
  if (formats.includes('cd')) score += 10;
  if (formats.includes('album')) score += 5;
  if (/deluxe|expanded|special|remaster/i.test(formats + ' ' + (rel.title || ''))) score += 4;
  if (rel.community?.have) score += Math.min(rel.community.have / 100, 3);
  return score;
}

// 괄호, 리마스터 등 꼬리표를 깔끔하게 제거하는 제목 정제기
function sanitizeTitle(title) {
  if (!title) return "";
  return title
    .replace(/\s*[\(\[].*?(remaster|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp).*?[\)\]]/gi, '')
    .replace(/\s*-\s*(remaster|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp).*$/gi, '')
    .trim();
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  const { albumTitle, artistName, deepSearch, sessionName } = req.query;

  // ============================================================
  // MODE 1: Deep Session Search (One-Shot 스나이퍼 혁신)
  // ============================================================
  if (deepSearch === 'true' && artistName && sessionName) {
    try {
      // 100번 반복하는 대신, Discogs DB 검색에 '아티스트'와 '세션명'을 동시에 던집니다.
      // 이렇게 하면 Discogs가 알아서 세션 크레딧이 포함된 앨범만 추려서 보내줍니다.
      const sniperUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artistName)}&q=${encodeURIComponent(sessionName)}&type=release&per_page=100${TOKEN_Q}`;
      
      const searchRes = await fetchJson(sniperUrl);
      
      if (!searchRes || !searchRes.results) {
        return res.json({ matchedTitles: [] });
      }

      const matchedTitles = new Set();
      
      searchRes.results.forEach(r => {
        // Discogs API의 title 결과는 "Brian Blade - Perceptual" 처럼 아티스트명이 붙어있으므로 분리
        const rawTitle = r.title.includes(' - ') ? r.title.split(' - ').slice(1).join(' - ') : r.title;
        // 괄호와 꼬리표를 제거한 깔끔한 제목만 저장
        matchedTitles.add(sanitizeTitle(rawTitle));
      });

      return res.json({ matchedTitles: Array.from(matchedTitles) });
      
    } catch (e) {
      return res.status(500).json({ error: e.message, matchedTitles: [] });
    }
  }

  // ============================================================
  // MODE 2: Album Credits (상세 크레딧)
  // ============================================================
  if (!albumTitle || !artistName) return res.status(400).json({ error: 'Required params missing' });

  try {
    const cleanAlbumTitle = sanitizeTitle(albumTitle);
    const queryStr = encodeURIComponent(`${artistName} ${cleanAlbumTitle}`);
    
    const masterSearch = await fetchJson(
      `https://api.discogs.com/database/search?q=${queryStr}&type=master&per_page=5${TOKEN_Q}`
    );
    
    let masterId = null;
    if (masterSearch?.results?.length) {
      const best = masterSearch.results.find(r => 
        r.title?.toLowerCase().includes(cleanAlbumTitle.toLowerCase())
      ) || masterSearch.results[0];
      masterId = best.id;
    }

    let releaseIdsToFetch = [];
    if (masterId) {
      const versions = await fetchJson(`https://api.discogs.com/masters/${masterId}/versions?per_page=20${TOKEN_Q}`);
      if (versions?.versions) {
        const top = versions.versions
          .filter(v => v.id)
          .map(v => ({ v, s: scoreRelease(v) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 4) 
          .map(x => x.v.id);
        releaseIdsToFetch = top;
      }
    }

    if (releaseIdsToFetch.length === 0) {
      const relSearch = await fetchJson(`https://api.discogs.com/database/search?q=${queryStr}&type=release&per_page=5${TOKEN_Q}`);
      releaseIdsToFetch = (relSearch?.results || []).slice(0, 3).map(r => r.id);
    }

    const releases = await Promise.allSettled(releaseIdsToFetch.map(id => fetchJson(`https://api.discogs.com/releases/${id}?${TOKEN_Q.slice(1)}`)));
    const validReleases = releases.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

    if (validReleases.length === 0) return res.json({ extraartists: [], tracklist: [], notFound: true });

    const primary = [...validReleases].sort((a, b) => (b.extraartists?.length || 0) - (a.extraartists?.length || 0))[0];
    
    // 5분 캐시 적용
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.json({
      ...primary,
      extraartists: mergeArtists(validReleases.flatMap(r => r.extraartists || [])),
      tracklist: mergeTracklists(validReleases.map(r => r.tracklist || []))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
