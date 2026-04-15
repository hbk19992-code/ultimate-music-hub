// /api/getDiscogs.js  V2 — Multi-Release Credit Merger
//
// 같은 앨범의 여러 release(LP/CD/디럭스 등)에서 크레딧을 모아 합칩니다.
// CD pressing이 보통 가장 풍부한 라이너노트를 가지므로 우선 선택.
//
// 기존 인터페이스 100% 호환:
//   GET /api/getDiscogs?albumTitle=...&artistName=...
//      → { extraartists, tracklist, ... } (병합된 결과)
//   GET /api/getDiscogs?deepSearch=true&artistName=...&sessionName=...
//      → { matchedTitles: [...] }

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
  } catch {
    clearTimeout(t);
    return null;
  }
}

// 이름+역할 기준 dedupe (정규화된 비교)
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

// 같은 트랙의 크레딧끼리 합치기
function mergeTracklists(allTracklists) {
  const tracksByKey = new Map();
  const order = [];
  allTracklists.forEach(tl => {
    (tl || []).forEach((track, idx) => {
      if (!track?.title) return;
      const key = track.title.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
      if (!key) return;
      if (!tracksByKey.has(key)) {
        tracksByKey.set(key, {
          ...track,
          extraartists: [...(track.extraartists || [])],
          _firstSeen: order.length
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
  return order.map(k => {
    const t = tracksByKey.get(k);
    delete t._firstSeen;
    return t;
  });
}

// release 우선순위 점수 (높을수록 먼저 선택)
function scoreRelease(rel) {
  let score = 0;
  const formats = (Array.isArray(rel.format) ? rel.format.join(' ') : (rel.format || '')).toLowerCase();
  // CD가 가장 풍부한 라이너노트를 가짐
  if (formats.includes('cd')) score += 10;
  if (formats.includes('album')) score += 5;
  // 디럭스/익스팬디드 보너스
  if (/deluxe|expanded|special|anniversary|remaster/i.test(formats + ' ' + (rel.title || ''))) score += 4;
  // 박스셋
  if (/box ?set/i.test(formats)) score += 6;
  // 디지털만은 감점 (보통 크레딧 부실)
  if (formats.includes('file') && !formats.includes('cd') && !formats.includes('vinyl')) score -= 5;
  // for_sale 많을수록 표준 release일 가능성 높음
  if (rel.community?.have) score += Math.min(rel.community.have / 100, 3);
  return score;
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  const { albumTitle, artistName, deepSearch, sessionName } = req.query;

  // ============================================================
  // MODE 1: Deep Session Search (스나이퍼)
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

      const rData = await fetchJson(
        `https://api.discogs.com/artists/${artistId}/releases?per_page=100&sort=year&sort_order=desc${TOKEN_Q}`
      );
      if (!rData?.releases) return res.json({ matchedTitles: [] });

      const sessionLower = sessionName.toLowerCase();
      const toCheck = rData.releases
        .filter(r => r.role === 'Main' && r.id && r.title)
        .slice(0, 25);

      // 동시 5개씩 청크로 검사 (rate limit 방어)
      const matchedTitles = new Set();
      const chunkSize = 5;
      for (let i = 0; i < toCheck.length; i += chunkSize) {
        const chunk = toCheck.slice(i, i + chunkSize);
        const results = await Promise.allSettled(
          chunk.map(async rel => {
            const detail = await fetchJson(
              `https://api.discogs.com/releases/${rel.id}?${TOKEN_Q.slice(1)}`
            );
            if (!detail) return null;
            const allCredits = [
              ...(detail.extraartists || []),
              ...((detail.tracklist || []).flatMap(t => t.extraartists || []))
            ];
            const found = allCredits.some(ar =>
              ar.name && ar.name.toLowerCase().replace(/\s\(\d+\)$/, '').includes(sessionLower)
            );
            return found ? rel.title : null;
          })
        );
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value) matchedTitles.add(r.value);
        });
      }

      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.json({ matchedTitles: Array.from(matchedTitles) });
    } catch (e) {
      return res.status(500).json({ error: e.message, matchedTitles: [] });
    }
  }

  // ============================================================
  // MODE 2: Album Credits (Multi-Release Merger)
  // ============================================================
  if (!albumTitle || !artistName) {
    return res.status(400).json({ error: 'albumTitle and artistName required' });
  }

  try {
    let releaseIdsToFetch = [];
    let masterUsed = false;

    // === STEP 1: Master release 검색 ===
    const masterUrl = `https://api.discogs.com/database/search?q=${encodeURIComponent(albumTitle)}&type=master&artist=${encodeURIComponent(artistName)}&per_page=5${TOKEN_Q}`;
    const masterSearch = await fetchJson(masterUrl);
    let masterId = null;
    if (masterSearch?.results?.length) {
      const titleLower = albumTitle.toLowerCase();
      const best = masterSearch.results.find(r => {
        const rTitle = (r.title || '').toLowerCase();
        return rTitle.includes(titleLower) ||
               titleLower.includes(rTitle.split(' - ').pop() || '');
      }) || masterSearch.results[0];
      masterId = best.id;
    }

    // === STEP 2: Master가 있으면 versions에서 best 2~3개 뽑기 ===
    if (masterId) {
      const versions = await fetchJson(
        `https://api.discogs.com/masters/${masterId}/versions?per_page=25${TOKEN_Q}`
      );
      if (versions?.versions?.length) {
        const scored = versions.versions
          .filter(v => v.id)
          .map(v => ({ v, s: scoreRelease(v) }))
          .sort((a, b) => b.s - a.s);

        // CD/디럭스 1~2개 + 가장 오래된 것(오리지널) 1개 = 다양성 확보
        const top = scored.slice(0, 3).map(x => x.v.id);
        // 오리지널 1장 추가
        const oldest = versions.versions
          .filter(v => v.id && v.released)
          .sort((a, b) => (a.released || '9999').localeCompare(b.released || '9999'))[0];
        const set = new Set(top);
        if (oldest?.id) set.add(oldest.id);
        releaseIdsToFetch = Array.from(set).slice(0, 3);
        masterUsed = true;
      }
    }

    // === STEP 3: Master 없으면 release 직접 검색 ===
    if (releaseIdsToFetch.length === 0) {
      const releaseSearch = await fetchJson(
        `https://api.discogs.com/database/search?q=${encodeURIComponent(albumTitle)}&type=release&artist=${encodeURIComponent(artistName)}&per_page=10${TOKEN_Q}`
      );
      if (releaseSearch?.results?.length) {
        const scored = releaseSearch.results
          .filter(r => r.id)
          .map(r => ({ r, s: scoreRelease(r) }))
          .sort((a, b) => b.s - a.s);
        releaseIdsToFetch = scored.slice(0, 3).map(x => x.r.id);
      }
    }

    if (releaseIdsToFetch.length === 0) {
      return res.json({ extraartists: [], tracklist: [], notFound: true });
    }

    // === STEP 4: 선택된 release들 병렬 fetch ===
    const releases = await Promise.allSettled(
      releaseIdsToFetch.map(id =>
        fetchJson(`https://api.discogs.com/releases/${id}?${TOKEN_Q.slice(1)}`)
      )
    );

    const validReleases = releases
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (validReleases.length === 0) {
      return res.json({ extraartists: [], tracklist: [], notFound: true });
    }

    // === STEP 5: 병합 ===
    // primary는 가장 데이터가 풍부한 release (구조 베이스)
    const primary = [...validReleases].sort((a, b) =>
      ((b.extraartists?.length || 0) +
       (b.tracklist || []).reduce((s, t) => s + (t.extraartists?.length || 0), 0)) -
      ((a.extraartists?.length || 0) +
       (a.tracklist || []).reduce((s, t) => s + (t.extraartists?.length || 0), 0))
    )[0];

    // 모든 release의 album-level 크레딧 병합
    const mergedExtraartists = mergeArtists(
      validReleases.flatMap(r => r.extraartists || [])
    );

    // 모든 release의 track-level 크레딧 병합
    const mergedTracklist = mergeTracklists(validReleases.map(r => r.tracklist || []));

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({
      // primary의 메타데이터(year/label/genre 등) 보존
      ...primary,
      // 병합된 크레딧으로 덮어쓰기
      extraartists: mergedExtraartists,
      tracklist: mergedTracklist,
      // 디버깅용 메타
      _mergedFrom: validReleases.length,
      _releaseIds: releaseIdsToFetch,
      _masterUsed: masterUsed,
      _totalCredits: mergedExtraartists.length +
        mergedTracklist.reduce((s, t) => s + (t.extraartists?.length || 0), 0)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, extraartists: [], tracklist: [] });
  }
}
