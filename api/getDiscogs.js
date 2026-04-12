// netlify/functions/getDiscogs.js

exports.handler = async function(event, context) {
  // 1. 프론트엔드에서 보낸 앨범명과 아티스트명 받기
  const { albumTitle, artistName } = event.queryStringParameters;
  const token = process.env.DISCOGS_TOKEN; // Netlify에 저장된 토큰

  // 토큰이 없으면 에러 반환
  if (!token) {
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Discogs token is missing in Netlify environment variables.", extraartists: [], tracklist: [] }) 
    };
  }

  // 검색어가 없으면 에러 반환
  if (!albumTitle || !artistName) {
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: "Missing albumTitle or artistName parameter", extraartists: [], tracklist: [] }) 
    };
  }

  try {
    // ⭐️ [STEP 1] 디스코그스에서 앨범 검색하여 고유 ID 찾기
    // 디저의 앨범명에 섞인 (Live), (Remastered) 등의 태그를 지워야 검색 성공률이 올라갑니다.
    const cleanAlbumTitle = albumTitle.replace(/\(.*\)/g, '').trim();
    const searchUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(cleanAlbumTitle)}&artist=${encodeURIComponent(artistName)}&type=release&token=${token}`;
    
    // 디스코그스는 User-Agent 헤더가 없으면 접속을 거부합니다 (403 Forbidden 에러 방지)
    const headers = { 'User-Agent': 'UltimateMusicHub/2.0' };

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    // 검색 결과가 없으면 빈 배열 반환 (프론트엔드에서 "정보 없음"으로 예쁘게 처리됨)
    if (!searchData.results || searchData.results.length === 0) {
      return { 
        statusCode: 200, 
        body: JSON.stringify({ extraartists: [], tracklist: [] }) 
      };
    }

    // ⭐️ [STEP 2] 검색된 첫 번째 앨범의 고유 ID(Release ID) 가져오기
    const releaseId = searchData.results[0].id;

    // ⭐️ [STEP 3] 해당 고유 ID로 '상세 앨범 정보' 다시 요청하기 (여기에 모든 세션 정보가 들어있음!)
    const releaseUrl = `https://api.discogs.com/releases/${releaseId}?token=${token}`;
    const releaseRes = await fetch(releaseUrl, { headers });
    const releaseData = await releaseRes.json();

    // ⭐️ [STEP 4] 프론트엔드가 기다리는 핵심 데이터 2가지를 골라서 전달!
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*" // CORS 에러 방지
      },
      body: JSON.stringify({
        extraartists: releaseData.extraartists || [], // 앨범 전체 공통 세션
        tracklist: releaseData.tracklist || []        // 개별 곡(Track) 전용 세션
      })
    };

  } catch (error) {
    console.error("Discogs Backend Error:", error);
    // 서버 에러가 나더라도 앱이 멈추지 않도록 빈 배열 반환
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message, extraartists: [], tracklist: [] })
    };
  }
};