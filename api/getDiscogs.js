// api/getDiscogs.js

// ⭐️ 해결책: Vercel 기본 환경(CommonJS)에 맞게 module.exports를 사용합니다.
module.exports = async function handler(req, res) {
  // CORS 에러 방지 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // 프론트엔드에서 보낸 파라미터 받기
  const { albumTitle, artistName } = req.query;
  const token = process.env.DISCOGS_TOKEN;

  if (!token) {
    return res.status(500).json({ error: "Discogs token missing in Vercel Settings", extraartists: [], tracklist: [] });
  }

  if (!albumTitle || !artistName) {
    return res.status(400).json({ error: "Missing parameters", extraartists: [], tracklist: [] });
  }

  try {
    const cleanAlbumTitle = albumTitle.replace(/\(.*\)/g, '').trim();
    const searchUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(cleanAlbumTitle)}&artist=${encodeURIComponent(artistName)}&type=release&token=${token}`;
    const headers = { 'User-Agent': 'UltimateMusicHub/Vercel' };

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      return res.status(200).json({ extraartists: [], tracklist: [] });
    }

    const releaseId = searchData.results[0].id;
    const releaseUrl = `https://api.discogs.com/releases/${releaseId}?token=${token}`;
    const releaseRes = await fetch(releaseUrl, { headers });
    const releaseData = await releaseRes.json();

    return res.status(200).json({
      extraartists: releaseData.extraartists || [],
      tracklist: releaseData.tracklist || []
    });

  } catch (error) {
    console.error("Vercel Backend Error:", error);
    // 에러가 나도 500 상태코드와 함께 빈 배열을 내려보내 프론트엔드 멈춤을 방지합니다.
    return res.status(500).json({ error: error.message, extraartists: [], tracklist: [] });
  }
}