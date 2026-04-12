// api/getDiscogs.js (Vercel ES Module 버전)

export default async function handler(req, res) {
  // 1. 응답 헤더 설정 (CORS 및 JSON 타입)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // 2. 파라미터 및 토큰 확인
  const { albumTitle, artistName } = req.query;
  const token = process.env.DISCOGS_TOKEN;

  if (!token) {
    console.error("환경변수 DISCOGS_TOKEN이 설정되지 않았습니다.");
    return res.status(500).json({ error: "Token missing", extraartists: [], tracklist: [] });
  }

  if (!albumTitle || !artistName) {
    return res.status(400).json({ error: "Missing query parameters", extraartists: [], tracklist: [] });
  }

  try {
    // 3. 검색어 정제 (괄호 안의 내용 제거 - 예: 'Album (Live)' -> 'Album')
    const cleanAlbumTitle = albumTitle.replace(/\(.*\)/g, '').trim();
    
    // 4. 디스코그스 검색 (Release ID 찾기)
    const searchUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(cleanAlbumTitle)}&artist=${encodeURIComponent(artistName)}&type=release&token=${token}`;
    
    // 디스코그스 API 필수 요구사항: User-Agent 헤더
    const headers = { 'User-Agent': 'MusicHub-Vercel-Module/1.0' };

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      console.log(`검색 결과 없음: ${cleanAlbumTitle} - ${artistName}`);
      return res.status(200).json({ extraartists: [], tracklist: [] });
    }

    // 5. 첫 번째 결과의 상세 정보 요청 (Release ID 사용)
    const releaseId = searchData.results[0].id;
    const releaseUrl = `https://api.discogs.com/releases/${releaseId}?token=${token}`;
    
    const releaseRes = await fetch(releaseUrl, { headers });
    const releaseData = await releaseRes.json();

    // 6. 성공 응답 (공통 세션 및 트랙리스트 포함)
    return res.status(200).json({
      extraartists: releaseData.extraartists || [],
      tracklist: releaseData.tracklist || []
    });

  } catch (error) {
    console.error("서버 내부 에러:", error);
    // 에러 발생 시 프론트엔드 크래시 방지를 위해 빈 구조 반환
    return res.status(500).json({ 
      error: "Internal Server Error", 
      message: error.message,
      extraartists: [], 
      tracklist: [] 
    });
  }
}