export default async function handler(req, res) {
    const { albumTitle, artistName } = req.query;

    if (!albumTitle || !artistName) {
        return res.status(400).json({ error: "앨범 이름과 아티스트 이름이 필요합니다." });
    }

    try {
        // 🚀 1순위: Discogs API 검색
        const discogsData = await searchDiscogs(albumTitle, artistName);
        if (discogsData && discogsData.extraartists && discogsData.extraartists.length > 0) {
            // 출처를 뱃지처럼 추가해서 프론트엔드로 보냄
            discogsData.extraartists.unshift({ role: '💿 Data Source', name: 'Discogs Official' });
            return res.status(200).json(discogsData);
        }

        // 🚀 2순위: MusicBrainz API 검색 (Discogs에 세션이 없을 때 발동!)
        const mbData = await searchMusicBrainz(albumTitle, artistName);
        if (mbData && mbData.extraartists && mbData.extraartists.length > 0) {
            mbData.extraartists.unshift({ role: '🧠 Data Source', name: 'MusicBrainz Open DB' });
            return res.status(200).json(mbData);
        }

        // 🚀 3순위: ManiaDB API 검색 (한글 여부 상관없이 무조건 최후의 보루로 실행!)
        const maniaData = await searchManiaDB(albumTitle, artistName);
        if (maniaData && maniaData.tracklist && maniaData.tracklist.length > 0) {
            maniaData.extraartists.unshift({ role: '🇰🇷 Data Source', name: 'ManiaDB (한국 DB)' });
            return res.status(200).json(maniaData);
        }

        // 3곳을 다 뒤져도 없으면 깔끔하게 빈 배열 반환
        return res.status(200).json({ 
            extraartists: [{ role: 'System', name: '3개 글로벌 DB 모두 세션 정보 없음 🥲' }], 
            tracklist: [] 
        });

    } catch (error) {
        console.error("Backend DB Fetch Error:", error);
        return res.status(500).json({ error: error.message });
    }
}

// ==========================================
// 🛠 1. Discogs 헬퍼 함수
// ==========================================
async function searchDiscogs(title, artist) {
    const token = process.env.DISCOGS_TOKEN;
    if (!token) throw new Error("Vercel 환경변수에 DISCOGS_TOKEN이 없습니다.");
    
    const searchUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&type=release&token=${token}`;
    const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'UltimateMusicHub/1.0' } });
    if (!searchRes.ok) return null;
    
    const searchJson = await searchRes.json();
    if (!searchJson.results || searchJson.results.length === 0) return null;

    const releaseId = searchJson.results[0].id;
    const detailUrl = `https://api.discogs.com/releases/${releaseId}`;
    const detailRes = await fetch(detailUrl, { headers: { 'User-Agent': 'UltimateMusicHub/1.0' } });
    if (!detailRes.ok) return null;
    
    return await detailRes.json();
}

// ==========================================
// 🛠 2. MusicBrainz 헬퍼 함수 (강력한 2차 백업)
// ==========================================
async function searchMusicBrainz(title, artist) {
    const headers = { 
        'User-Agent': 'UltimateMusicHub/1.0 ( digging-engine@music.com )', 
        'Accept': 'application/json' 
    };
    
    const q = encodeURIComponent(`release:"${title}" AND artist:"${artist}"`);
    const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${q}&fmt=json&limit=1`;
    const searchRes = await fetch(searchUrl, { headers });
    if (!searchRes.ok) return null;
    
    const searchJson = await searchRes.json();
    if (!searchJson.releases || searchJson.releases.length === 0) return null;

    const releaseId = searchJson.releases[0].id;
    
    // 세션 크레딧(artist-rels)과 수록곡(recordings)을 한 번에 끌어옴
    const detailUrl = `https://musicbrainz.org/ws/2/release/${releaseId}?inc=artist-rels+recordings&fmt=json`;
    const detailRes = await fetch(detailUrl, { headers });
    if (!detailRes.ok) return null;
    
    const detailJson = await detailRes.json();

    // 프론트엔드가 이해할 수 있게 Discogs 포맷으로 변환 (Mapping)
    let extraartists = [];
    if (detailJson.relations) {
        detailJson.relations.forEach(rel => {
            if (rel['target-type'] === 'artist' && rel.artist) {
                // 악기 이름이나 역할(Role) 추출
                let role = rel.type;
                if (rel.attributes && rel.attributes.length > 0) {
                    role += ` (${rel.attributes.join(', ')})`;
                }
                extraartists.push({
                    role: role.charAt(0).toUpperCase() + role.slice(1), // 앞글자 대문자화
                    name: rel.artist.name
                });
            }
        });
    }

    let tracklist = [];
    if (detailJson.media && detailJson.media.length > 0) {
        detailJson.media[0].tracks.forEach(tr => {
            tracklist.push({ title: tr.title, extraartists: [] }); 
        });
    }

    return { extraartists, tracklist };
}

// ==========================================
// 🛠 3. ManiaDB 헬퍼 함수 (한국 음악 최후의 보루)
// ==========================================
async function searchManiaDB(title, artist) {
    // ManiaDB는 XML로 데이터를 주므로 무식하지만 확실한 정규식 파싱(Regex Parsing) 사용
    const url = `http://www.maniadb.com/api/search/${encodeURIComponent(title)}/?sr=album&display=1&key=example&v=0.5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    
    const xml = await res.text();

    // 수록곡 이름 뜯어내기
    const trackMatches = xml.match(/<maniadb:track[^>]*><title><!\[CDATA\[(.*?)\]\]><\/title>/g);
    let tracklist = [];
    if (trackMatches) {
        trackMatches.forEach(m => {
            const titleMatch = m.match(/<!\[CDATA\[(.*?)\]\]>/);
            if (titleMatch && titleMatch[1]) {
                tracklist.push({ title: titleMatch[1], extraartists: [] });
            }
        });
    }

    let extraartists = [];
    if (tracklist.length > 0) {
        extraartists.push({ role: 'Info', name: 'ManiaDB는 세션 크레딧 API를 미지원하여 수록곡 정보만 복구했습니다.' });
    }

    return { extraartists, tracklist };
}
