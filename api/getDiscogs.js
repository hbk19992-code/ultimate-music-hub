// /api/getDiscogs.js  V6 — Ultimate Stable Edition

const TOKEN = process.env.DISCOGS_TOKEN;
const TOKEN_Q = TOKEN ? `&token=${TOKEN}` : '';
const HEADERS = { 'User-Agent': 'CanYouDigIt/1.0 +https://owb-digging.app' };

// ---------- Helpers ----------
async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      console.error(`🚨 [Discogs API Error] ${r.status}: ${url}`);
      return null;
    }
    return await r.json();
  } catch (error) {
    clearTimeout(t);
    console.error(`🚨 [Fetch Failed] ${error.message}`);
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

// 괄호, 리마스터 등 꼬리표를 깔끔하게 제거하는 제목 정제 함수
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
  // MODE 1: Deep Session Search (스나이퍼 서치)
  // ============================================================
  if (deepSearch === 'true' && artistName && sessionName) {
    try {
      const artistSearch = await fetchJson(
        `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${TOKEN_Q}`
      );
      if (!artistSearch?.results?.length) return res.json({ matchedTitles: [] });

      const exactMatch = artistSearch.results.find(r =>
        r.title?.toLowerCase() === artistName.toLowerCase()
      );
      const artistId = (exactMatch || artistSearch.results[0]).id;

      // 과거 명반 추적을 위해 검색 범위 100개 유지
      const rData = await fetchJson(
        `https://api.discogs.com/artists/${artistId}/releases?per_page=100&sort=year&sort_order=desc${TOKEN_Q}`
      );
      
      if (!rData?.releases) return res.json({ matchedTitles: [] });

      const sessionLower = sessionName.toLowerCase().trim().replace(/\s+/g, ' ');
      
      const toCheck = rData.releases
        .filter(r => r.role === 'Main' && r.title)
        .slice(0, 100); 

      const matchedTitles = new Set();
      const chunkSize = 4; // API 부하 분산용 청크

      for (let i = 0; i < toCheck.length; i += chunkSize) {
        const chunk = toCheck.slice(i, i + chunkSize);
        
        const results = await Promise.allSettled(
          chunk.map(async rel => {
            try {
              // 마스터 ID 누락 시 원래 ID로 우회하는 완벽한 폴백 처리
              const targetReleaseId = (rel.type === 'master' && rel.main_release) ? rel.main_release : rel.id;
              
              if (!targetReleaseId) {
                console.log(`[스나이퍼] 유효한 ID 없음 패스: ${rel.title}`);
                return null;
              }

              const detail = await fetchJson(
                `https://api.discogs.com/releases/${targetReleaseId}?${TOKEN_Q.slice(1)}`
              );
              
              if (!detail) return null;
              
              const allCredits = [
                ...(detail.extraartists || []),
                ...((detail.tracklist || []).flatMap(t => t.extraartists || []))
              ];
              
              const found = allCredits.some(ar => {
                const cleanName = (ar.name || '').toLowerCase().replace(/\s\(\d+\)$/, '').trim();
                return cleanName.includes(sessionLower);
              });
              
              // 발견 시 프론트엔드와 매칭하기 쉽게 꼬리표를 뗀 제목으로 반환
              return found ? sanitizeTitle(rel.title) : null;
              
            } catch (err) {
              console.error(`[스나이퍼] ${rel.title} 처리 중 에러:`, err);
              return null;
            }
          })
        );
        
        results.forEach(r => { 
          if (r.status === 'fulfilled' && r.value) {
            matchedTitles.add(r.value); 
          }
        });
        
        // Rate Limit 회피를 위한 1.2초 대기
        await new Promise(resolve => setTimeout(resolve, 1200));
      }

      // 스나이핑 결과는 빠르고 정확한 갱신을 위해 캐싱하지 않음
      return res.json({ matchedTitles: Array.from(matchedTitles) });
      
    } catch (e) {
      console.error("[스나이퍼] 전체 에러:", e);
      return res.status(500).json({ error: e.message, matchedTitles: [] });
    }
  }

  // ============================================================
  // MODE 2: Album Credits (앨범 상세 크레딧)
  // ============================================================
  if (!albumTitle || !artistName) return res.status(400).json({ error: 'Required params missing' });

  try {
    // 앨범 제목 렌즈 클리닝: (Remastered) 등의 꼬리표를 제거
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
    
    // 실전용 5분 캐시 적용 (앨범 크레딧 조회 최적화)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.json({
      ...primary,
      extraartists: mergeArtists(validReleases.flatMap(r => r.extraartists || [])),
      tracklist: mergeTracklists(validReleases.map(r => r.tracklist || []))
    });
  } catch (e) {
    console.error("[앨범 크레딧] 전체 에러:", e);
    return res.status(500).json({ error: e.message });
  }
}
