export default async function handler(req, res) {
    const { albumTitle, artistName } = req.query;

    if (!albumTitle || !artistName) {
        return res.status(400).json({ error: "앨범 이름과 아티스트 이름이 필요합니다." });
    }

    try {
        // 🚀 1순위: Discogs API
        const discogsData = await searchDiscogs(albumTitle, artistName);
        if (discogsData && discogsData.extraartists && discogsData.extraartists.length > 0) {
            discogsData.extraartists.unshift({ role: '💿 Data Source', name: 'Discogs Official' });
            return res.status(200).json(discogsData);
        }

        // 🚀 2순위: MusicBrainz
        const mbData = await searchMusicBrainz(albumTitle, artistName);
        if (mbData && mbData.extraartists && mbData.extraartists.length > 0) {
            mbData.extraartists.unshift({ role: '🧠 Data Source', name: 'MusicBrainz Open DB' });
            return res.status(200).json(mbData);
        }

        // 🚀 3순위: ManiaDB (아티스트 페이지 타겟팅 + EUC-KR 디코더 탑재)
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
// 🛠 1. Discogs 검색
// ==========================================
async function searchDiscogs(title, artist) {
    const token = process.env.DISCOGS_TOKEN;
    if (!token) return null;
    
    const searchUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&type=release&token=${token}`;
    const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/1.0' } });
    if (!searchRes.ok) return null;
    
    const searchJson = await searchRes.json();
    if (!searchJson.results || searchJson.results.length === 0) return null;

    const detailRes = await fetch(`https://api.discogs.com/releases/${searchJson.results[0].id}`, { 
        headers: { 'User-Agent': 'MusicHubEngine/1.0' } 
    });
    return detailRes.ok ? await detailRes.json() : null; 
}

// ==========================================
// 🛠 2. MusicBrainz 검색
// ==========================================
async function searchMusicBrainz(title, artist) {
    const headers = { 'User-Agent': 'MusicHubEngine/1.0', 'Accept': 'application/json' };
    const searchRes = await fetch(`https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(`release:"${title}" AND artist:"${artist}"`)}&fmt=json&limit=1`, { headers });
    
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

        // [1단계] 앨범 이름 대신 "아티스트 이름"으로 먼저 검색하여 아티스트 페이지를 찾습니다!
        const artApiUrl = `http://www.maniadb.com/api/search/${encodeURIComponent(artist)}/?sr=artist&display=1&key=example&v=0.5`;
        const artRes = await fetch(artApiUrl);
        
        if (artRes.ok) {
            const artXml = await artRes.text();
            const linkMatch = artXml.match(/<link>(http:\/\/www\.maniadb\.com\/artist\/\d+)<\/link>/i);
            if (linkMatch) targetUrl = linkMatch[1]; 
        }

        // 아티스트 페이지를 못 찾았다면, 앨범 이름으로 백업 검색
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

        // [2단계] 타겟 페이지 접속 후 EUC-KR 해독
        const htmlRes = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!htmlRes.ok) return null;
        
        const arrayBuffer = await htmlRes.arrayBuffer();
        const decoder = new TextDecoder('euc-kr');
        const html = decoder.decode(arrayBuffer);

        let extraartists = [];
        let seen = new Set();
        
        // 🔥 [3단계] 무적의 정규식: "작사/작곡/편곡 :" 뒤에 나오는 한글, 영어, 숫자를 태그가 나오기 전까지만 포획!
        const regex = /(작사|작곡|편곡)\s*:\s*([a-zA-Z가-힣0-9\s,&/().]+)/g; 
        let m;
        
        while ((m = regex.exec(html)) !== null) {
            let roleType = m[1].trim();
            let rawNames = m[2].trim();
            
            let label = roleType === '작사' ? '작사 (Lyricist)' : 
                        roleType === '작곡' ? '작곡 (Composer)' : '편곡 (Arranger)';
            
            // 이름 분리 작업
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
