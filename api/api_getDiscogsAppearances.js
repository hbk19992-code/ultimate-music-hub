// /api/getDiscogsAppearances.js
// Kurt Rosenwinkel 같은 사이드맨/세션 참여작을 발굴하는 신규 엔드포인트
// role !== "Main" 인 모든 릴리스를 가져옴

export default async function handler(req, res) {
  const { artistName } = req.query;
  if (!artistName) {
    return res.status(400).json({ error: 'artistName is required' });
  }
  
  const TOKEN = process.env.DISCOGS_TOKEN;
  const headers = {
    'User-Agent': 'CanYouDigIt/1.0 +https://owb-digging.app'
  };
  
  try {
    // 1) 아티스트 검색 → ID 획득
    const searchUrl = `https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist${TOKEN ? `&token=${TOKEN}` : ''}`;
    const search = await fetch(searchUrl, { headers });
    if (!search.ok) {
      return res.status(search.status).json({ error: 'Discogs search failed', appearances: [] });
    }
    const sData = await search.json();
    if (!sData.results?.length) {
      return res.json({ appearances: [], total: 0 });
    }
    
    // 정확 일치 우선, 없으면 첫 번째
    const exactMatch = sData.results.find(r =>
      r.title?.toLowerCase() === artistName.toLowerCase()
    );
    const artistId = (exactMatch || sData.results[0]).id;
    
    // 2) 릴리스 전체 가져오기 (sort=year desc, 최대 100개)
    const relUrl = `https://api.discogs.com/artists/${artistId}/releases?per_page=100&sort=year&sort_order=desc${TOKEN ? `&token=${TOKEN}` : ''}`;
    const rel = await fetch(relUrl, { headers });
    if (!rel.ok) {
      return res.status(rel.status).json({ error: 'Discogs releases fetch failed', appearances: [] });
    }
    const rData = await rel.json();
    
    // 3) role !== "Main" 인 것만 (= 사이드맨/피처링)
    //    Discogs role 값: "Main" (본인 리더작), "TrackAppearance", "Appearance", "UnofficialRelease" 등
    const appearances = (rData.releases || [])
      .filter(r => r.role && r.role !== 'Main' && r.artist && r.title)
      .map(r => ({
        title: r.title,
        artist: r.artist,
        year: r.year || null,
        role: r.role,
        thumb: r.thumb || '',
        discogsId: r.id,
        type: r.type || 'release'
      }));
    
    // 4) 중복 제거 (같은 제목+아티스트 조합)
    const seen = new Set();
    const unique = appearances.filter(a => {
      const key = `${a.title.toLowerCase()}_${a.artist.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    // 캐시 (1시간 + SWR)
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.json({
      appearances: unique,
      total: unique.length,
      artistId
    });
  } catch (e) {
    res.status(500).json({ error: e.message, appearances: [] });
  }
}
