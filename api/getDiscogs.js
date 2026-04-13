export default async function handler(req, res) {
    const { albumTitle, artistName } = req.query;

    if (!albumTitle || !artistName) {
        return res.status(400).json({ error: "앨범 이름과 아티스트 이름이 필요합니다." });
    }

    try {
        // 🚀 1순위: Discogs API (마스터 릴리즈 딥 서치 적용)
        const discogsData = await searchDiscogs(albumTitle, artistName);
        if (discogsData && discogsData.extraartists && discogsData.extraartists.length > 0) {
            discogsData.extraartists.unshift({ role: '💿 Data Source', name: 'Discogs Official' });
            return res.status(200).json(discogsData);
        }

        // 🚀 2순위: MusicBrainz (유연한 통합 검색 적용)
        const mbData = await searchMusicBrainz(albumTitle, artistName);
        if (mbData && mbData.extraartists && mbData.extraartists.length > 0) {
            mbData.extraartists.unshift({ role: '🧠 Data Source', name: 'MusicBrainz Open DB' });
            return res.status(200).json(mbData);
        }

        // 🚀 3순위: ManiaDB (한국 음악 전용 봇)
        const maniaData = await searchManiaDB(albumTitle, artistName);
        if (maniaData && maniaData.extraartists.length > 0) {
            maniaData.extraartists.unshift({ role: '🇰🇷 Data Source', name: 'ManiaDB (Artist Page Bot)' });
            return res.status(200).json(maniaData);
        }

        return res.status(200).json({ 
            extraartists: [{ role: 'System', name: '검색된 모든 DB에 세션 정보가 없습니다 🥲' }], 
            tracklist: [] 
        });

    } catch (error) {
        console.error("Backend Error:", error);
        return res.status(500).json({ error: error.message });
    }
}

// ==========================================
// 🛠 1. Discogs 검색 (마스터 릴리즈 역추적 엔진)
// ==========================================
async function searchDiscogs(title, artist) {
    const token = process.env.DISCOGS_TOKEN;
    if (!token) return null;
    
    // 💡 깐깐한 필드 매칭 대신, 사람이 구글에 검색하듯 유연한 'q' (통합 검색) 사용
    const query = encodeURIComponent(`${title} ${artist}`);
    
    // 1단계: 수백 개의 판본을 묶어주는 'Master' 앨범을 먼저 찾습니다.
    let searchUrl = `https://api.discogs.com/database/search?q=${query}&type=master&token=${token}`;
    let searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
    let searchJson = searchRes.ok ? await searchRes.json() : { results: [] };

    let releaseId = null;

    if (searchJson.results && searchJson.results.length > 0) {
        // 마스터 앨범을 찾았다면, 그 마스터의 대표격인 'main_release' 번호를 알아냅니다.
        const masterId = searchJson.results[0].id;
        const masterRes = await fetch(`https://api.discogs.com/masters/${masterId}`, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
        if (masterRes.ok) {
            const masterData = await masterRes.json();
            releaseId = masterData.main_release; 
        }
    } else {
        // 마스터가 없는 앨범이라면 일반 'Release'로 재검색 (Fallback)
        searchUrl = `https://api.discogs.com/database/search?q=${query}&type=release&token=${token}`;
        searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
        searchJson = searchRes.ok ? await searchRes.json() : { results: [] };
        if (searchJson.results && searchJson.results.length > 0) {
            releaseId = searchJson.results[0].id;
        }
    }

    if (!releaseId) return null;

    // 2단계: 알아낸 최종 Release ID로 꽉 찬 크레딧 정보를 가져옵니다.
    const detailRes = await fetch(`https://api.discogs.com/releases/${releaseId}`, { 
        headers: { 'User-Agent': 'MusicHubEngine/1.1' } 
    });
    return detailRes.ok ? await detailRes.json() : null; 
}

// ==========================================
// 🛠 2. MusicBrainz 검색 (유연한 검색 쿼리로 수정)
// ==========================================
async function searchMusicBrainz(title, artist) {
    const headers = { 'User-Agent': 'MusicHubEngine/1.1', 'Accept': 'application/json' };
    
    // 💡 MusicBrainz 역시 깐깐한 조건 검색 대신, 통검색으로 이름 불일치 문제 해결
    const query = encodeURIComponent(`${title} ${artist}`);
    const searchRes = await fetch(`https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=1`, { headers });
    
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    if (!searchJson.releases || searchJson.releases.length === 0) return null;

    const detailRes = await fetch(`https://musicbrainz.org/ws/2/release/${searchJson.releases[0].id}?inc=artist-rels+recordings&fmt=json`, { headers });
    if (!detailRes.ok) return null;
    const detailJson = await detailRes.json();

    let extraartists = [];
    if (detailJson.relations) {
        detailJson.relations.forEach(rel => {
            if (rel['target-type'] === 'artist') {
                let role = rel.type + (rel.attributes?.length ? ` (${rel.attributes.join(', ')})` : "");
                extraartists.push({ role: role.charAt(0).toUpperCase() + role.slice(1), name: rel.artist.name });
            }
        });
    }
    return { extraartists, tracklist: [] };
}

// ==========================================
// 🛠 3. ManiaDB 아티스트 페이지 딥 스크래핑 엔진
// ==========================================
async function searchManiaDB(title, artist) {
    try {
        let targetUrl = null;
        const artApiUrl = `http://www.maniadb.com/api/search/${encodeURIComponent(artist)}/?sr=artist&display=1&key=example&v=0.5`;
        const artRes = await fetch(artApiUrl);
        
        if (artRes.ok) {
            const artXml = await artRes.text();
            const linkMatch = artXml.match(/<link>(http:\/\/www\.maniadb\.com\/artist\/\d+)<\/link>/i);
            if (linkMatch) targetUrl = linkMatch[1]; 
        }

        if (!targetUrl) {
            const cleanTitle = title.replace(/\[.*?\]|\(.*?\)/g, '').trim();
            const albApiUrl = `http://www.maniadb.com/api/search/${encodeURIComponent(cleanTitle)}/?sr=album&display=5&key=example&v=0.5`;
            const albRes = await fetch(albApiUrl);
            if (albRes.ok) {
                const albXml = await albRes.text();
                const albLinkMatch = albXml.match(/<link>(http:\/\/www\.maniadb\.com\/album\/\d+)<\/link>/i);
                if (albLinkMatch) targetUrl = albLinkMatch[1];
            }
        }

        if (!targetUrl) return null;

        const htmlRes = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!htmlRes.ok) return null;
        
        const arrayBuffer = await htmlRes.arrayBuffer();
        const decoder = new TextDecoder('euc-kr');
        const html = decoder.decode(arrayBuffer);

        let extraartists = [];
        let seen = new Set();
        
        const regex = /(작사|작곡|편곡)\s*:\s*([a-zA-Z가-힣0-9\s,&/().]+)/g; 
        let m;
        
        while ((m = regex.exec(html)) !== null) {
            let roleType = m[1].trim();
            let rawNames = m[2].trim();
            
            let label = roleType === '작사' ? '작사 (Lyricist)' : 
                        roleType === '작곡' ? '작곡 (Composer)' : '편곡 (Arranger)';
            
            let names = rawNames.split(/[,&/]/).map(n => n.trim()).filter(n => n);
            
            names.forEach(name => {
                if (name.length > 0 && name.length < 25 && !seen.has(label + name)) {
                    seen.add(label + name);
                    extraartists.push({ role: label, name: name });
                }
            });
        }

        return { extraartists, tracklist: [] };
    } catch (e) {
        console.error("ManiaDB Scraping Error:", e);
        return null;
    }
}
