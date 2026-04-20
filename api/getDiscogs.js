// /api/getDiscogs.js  V10 — Vercel-safe (no unicode props, strict timeouts)

const TOKEN = process.env.DISCOGS_TOKEN;
const TOKEN_Q = TOKEN ? `&token=${TOKEN}` : '';
const HEADERS = { 'User-Agent': 'CanYouDigIt/1.0 +https://owb-digging.app' };

// 각 fetch 짧게 (전체 함수 10초 제한에 맞춤)
async function fetchJson(url, timeoutMs = 5000) {
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

// 제목 정규화 - unicode property 없이 ASCII 기반
function normalizeForMatch(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/['`"\u2018\u2019\u201C\u201D]/g, '')   // 아포스트로피/따옴표
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\uAC00-\uD7AF]+/g, ' ')        // 영숫자 + 한글만 남김
    .trim()
    .replace(/\s+/g, ' ');
}

// 정규식 오류 및 이중 백슬래시 누락 수정 완료
function sanitizeTitle(title) {
  if (!title) return '';
  const keywords = 'remaster|remastered|deluxe|edition|version|bonus|live|expanded|remix|stereo|mono|reissue|feat|ft|cd|lp|legacy|anniversary|collector|sacd|extended|alternate|japanese|original|complete';
  return String(title)
    .replace(new RegExp('\\s*[\\(\\[].*?(' + keywords + ').*?[\\)\\]]', 'gi'), '')
    .replace(new RegExp('\\s*-\\s*(' + keywords + ').*$', 'gi'), '')
    .replace(/\s*(?:\s*\d+(st|nd|rd|th)\s+(anniversary|edition|year).*?)?/gi, '')
    .replace(/\s*(?:\s*(feat\.?|featuring|ft\.?)\s+[^)]+)?/gi, '')
    .replace(/\s+(19|20)\d{2}\s*(remaster|remastered|mix|version)?$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeArtists(allArtists) {
  const seen = new Map();
  allArtists.forEach(ar => {
    if (!ar || !ar.name) return;
    const cleanName = String(ar.name).replace(/\s(\d+)$/, '').trim();
    const cleanRole = String(ar.role || '').trim();
    const key = cleanName.toLowerCase() + '|' + cleanRole.toLowerCase();
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
      if (!track || !track.title) return;
      const key = String(track.title).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key) return;
      if (!tracksByKey.has(key)) {
        tracksByKey.set(key, { ...track, extraartists: [...(track.extraartists || [])] });
        order.push(key);
      } else {
        const existing = tracksByKey.get(key);
        existing.extraartists = mergeArtists([...existing.extraartists, ...(track.extraartists || [])]);
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
  if (rel.community && rel.community.have) score += Math.min(rel.community.have / 100, 3);
  return score;
}

function findBestMatch(results, targetTitle, targetArtist) {
  if (!results || !results.length) return null;

  const targetTitleNorm = normalizeForMatch(sanitizeTitle(targetTitle));
  const targetArtistNorm = normalizeForMatch(targetArtist);
  const targetTitleTokens = targetTitleNorm.split(' ').filter(t => t.length > 1);

  const scored = results.map(r => {
    const raw = r.title || '';
    const parts = raw.includes(' - ') ? raw.split(' - ') : [raw];
    const discogsArtist = parts.length >= 2 ? parts[0] : '';
    const discogsTitle = parts.length >= 2 ? parts.slice(1).join(' - ') : raw;

    const titleNorm = normalizeForMatch(sanitizeTitle(discogsTitle));
    const artistNorm = normalizeForMatch(discogsArtist);

    let score = 0;
    if (titleNorm === targetTitleNorm) score += 100;
    else if (titleNorm.includes(targetTitleNorm) || targetTitleNorm.includes(titleNorm)) score += 60;
    else {
      const titleTokens = titleNorm.split(' ').filter(t => t.length > 1);
      if (targetTitleTokens.length > 0) {
        const matched = targetTitleTokens.filter(t => titleTokens.includes(t)).length;
        score += (matched / targetTitleTokens.length) * 50;
      }
    }

    if (artistNorm === targetArtistNorm) score += 40;
    else if (artistNorm.includes(targetArtistNorm) || targetArtistNorm.includes(artistNorm)) score += 25;

    if (r.community && r.community.have) score += Math.min(r.community.have / 200, 5);
    return { result: r, score };
  }).sort((a, b) => b.score - a.score);

  if (scored[0].score < 20) return null;
  return scored[0].result;
}

// Sniper — 2페이지만 (10초 함수 타임아웃 내에)
async function runSniperSearch(artistName, sessionName) {
  const matchedTitles = new Set();

  const urls = [
    'https://api.discogs.com/database/search?artist=' + encodeURIComponent(artistName) +
    '&q=' + encodeURIComponent(sessionName) + '&type=release&per_page=100&page=1' + TOKEN_Q,
    'https://api.discogs.com/database/search?artist=' + encodeURIComponent(artistName) +
    '&q=' + encodeURIComponent(sessionName) + '&type=release&per_page=100&page=2' + TOKEN_Q,
    'https://api.discogs.com/database/search?artist=' + encodeURIComponent(artistName) +
    '&credit=' + encodeURIComponent(sessionName) + '&type=release&per_page=100' + TOKEN_Q
  ];

  // 병렬 (각 5초 timeout)
  const results = await Promise.all(urls.map(u => fetchJson(u, 5000)));
  results.forEach(searchRes => {
    if (!searchRes || !searchRes.results) return;
    searchRes.results.forEach(r => {
      if (!r || !r.title) return;
      const rawTitle = r.title.includes(' - ') ? r.title.split(' - ').slice(1).join(' - ') : r.title;
      matchedTitles.add(sanitizeTitle(rawTitle));
    });
  });

  return Array.from(matchedTitles);
}

export default async function handler(req, res) {
  const { albumTitle, artistName, deepSearch, sessionName } = req.query || {};

  // ============================================================
  // MODE 1: Sniper
  // ============================================================
  if (deepSearch === 'true' && artistName && sessionName) {
    try {
      const matchedTitles = await runSniperSearch(artistName, sessionName);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.json({ matchedTitles: matchedTitles, _count: matchedTitles.length });
    } catch (e) {
      return res.status(200).json({ matchedTitles: [], _error: String(e.message || e) });
    }
  }

  // ============================================================
  // MODE 2: Album Credits
  // ============================================================
  if (!albumTitle || !artistName) return res.status(400).json({ error: 'Required params missing' });

  try {
    const cleanAlbumTitle = sanitizeTitle(albumTitle);
    const debugTrace = [];

    // 1. Master 정밀
    let masterSearch = await fetchJson(
      'https://api.discogs.com/database/search?artist=' + encodeURIComponent(artistName) +
      '&release_title=' + encodeURIComponent(cleanAlbumTitle) +
      '&type=master&per_page=15' + TOKEN_Q
    );
    debugTrace.push('master-precise:' + (masterSearch && masterSearch.results ? masterSearch.results.length : 0));

    // 2. Master 폴백
    if (!masterSearch || !masterSearch.results || !masterSearch.results.length) {
      const queryStr = encodeURIComponent(artistName + ' ' + cleanAlbumTitle);
      masterSearch = await fetchJson(
        'https://api.discogs.com/database/search?q=' + queryStr + '&type=master&per_page=15' + TOKEN_Q
      );
      debugTrace.push('master-fallback:' + (masterSearch && masterSearch.results ? masterSearch.results.length : 0));
    }

    let masterId = null;
    if (masterSearch && masterSearch.results && masterSearch.results.length) {
      const matched = findBestMatch(masterSearch.results, cleanAlbumTitle, artistName);
      if (matched) masterId = matched.id;
      debugTrace.push('master-match:' + (masterId || 'none'));
    }

    let releaseIdsToFetch = [];
    if (masterId) {
      const versions = await fetchJson(
        'https://api.discogs.com/masters/' + masterId + '/versions?per_page=20' + TOKEN_Q
      );
      if (versions && versions.versions) {
        releaseIdsToFetch = versions.versions
          .filter(v => v.id)
          .map(v => ({ v: v, s: scoreRelease(v) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 4)
          .map(x => x.v.id);
        debugTrace.push('versions:' + releaseIdsToFetch.length);
      }
    }

    // 3. Release 폴백
    if (releaseIdsToFetch.length === 0) {
      let relSearch = await fetchJson(
        'https://api.discogs.com/database/search?artist=' + encodeURIComponent(artistName) +
        '&release_title=' + encodeURIComponent(cleanAlbumTitle) +
        '&type=release&per_page=15' + TOKEN_Q
      );
      debugTrace.push('release-precise:' + (relSearch && relSearch.results ? relSearch.results.length : 0));

      if (!relSearch || !relSearch.results || !relSearch.results.length) {
        const queryStr = encodeURIComponent(artistName + ' ' + cleanAlbumTitle);
        relSearch = await fetchJson(
          'https://api.discogs.com/database/search?q=' + queryStr + '&type=release&per_page=15' + TOKEN_Q
        );
        debugTrace.push('release-fallback:' + (relSearch && relSearch.results ? relSearch.results.length : 0));
      }

      if (relSearch && relSearch.results && relSearch.results.length) {
        const bestMatch = findBestMatch(relSearch.results, cleanAlbumTitle, artistName);
        if (bestMatch) {
          releaseIdsToFetch.push(bestMatch.id);
          relSearch.results.forEach(r => {
            if (releaseIdsToFetch.length >= 4) return;
            if (r.id === bestMatch.id) return;
            releaseIdsToFetch.push(r.id);
          });
          debugTrace.push('release-siblings:' + releaseIdsToFetch.length);
        } else {
          releaseIdsToFetch = relSearch.results.slice(0, 3).map(r => r.id);
          debugTrace.push('release-blind:' + releaseIdsToFetch.length);
        }
      }
    }

    if (releaseIdsToFetch.length === 0) {
      return res.json({ extraartists: [], tracklist: [], notFound: true, _debug: debugTrace });
    }

    const releases = await Promise.allSettled(
      releaseIdsToFetch.map(id =>
        fetchJson('https://api.discogs.com/releases/' + id + (TOKEN_Q ? '?' + TOKEN_Q.slice(1) : ''))
      )
    );
    const validReleases = releases
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    debugTrace.push('releases-ok:' + validReleases.length + '/' + releaseIdsToFetch.length);

    if (validReleases.length === 0) {
      return res.json({ extraartists: [], tracklist: [], notFound: true, _debug: debugTrace });
    }

    const primary = [...validReleases].sort(
      (a, b) => (b.extraartists ? b.extraartists.length : 0) - (a.extraartists ? a.extraartists.length : 0)
    )[0];

    const topLevelArtists = validReleases.flatMap(r => r.extraartists || []);
    const trackLevelArtists = validReleases.flatMap(r =>
      (r.tracklist || []).flatMap(t => t.extraartists || [])
    );
    const mainArtists = validReleases.flatMap(r =>
      (r.artists || []).map(a => ({ ...a, role: a.role || 'Main Artist' }))
    );

    const allExtraArtists = mergeArtists([...topLevelArtists, ...trackLevelArtists, ...mainArtists]);
    debugTrace.push('credits:' + 'top=' + topLevelArtists.length +
      ',track=' + trackLevelArtists.length +
      ',main=' + mainArtists.length +
      ',merged=' + allExtraArtists.length);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.json({
      ...primary,
      extraartists: allExtraArtists,
      tracklist: mergeTracklists(validReleases.map(r => r.tracklist || [])),
      _debug: debugTrace
    });

  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
