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

        // 🚀 3순위: ManiaDB (🔥 EUC-KR 번역기 탑재 스크래핑 엔진 🔥)
        const maniaData = await searchManiaDB(albumTitle, artistName);
        if (maniaData && maniaData.extraartists.length > 0) {
            maniaData.extraartists.unshift({ role: '🇰🇷 Data Source', name: 'ManiaDB (EUC-KR Bot)' });
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
// 🛠 1. Discogs
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
// 🛠 2. MusicBrainz
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
// 🛠 3. ManiaDB (EUC-KR 디코더 + 딥 스크래핑)
// ==========================================
async function searchManiaDB(title, artist) {
    try {
        // [1단계] ManiaDB 공식 API로 앨범 고유 링크를 먼저 알아냅니다. (API는 UTF-8 지원)
        const query = encodeURIComponent(title + ' ' + artist);
        const apiUrl = `http://www.maniadb.com/api/search/${query}/?sr=album&display=5&key=example&v=0.5`;
        const apiRes = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!apiRes.ok) return null;
        
        const xml = await apiRes.text();
        
        // 검색된 앨범 중 첫 번째 링크(URL) 획득
        const linkMatch = xml.match(/<link>(http:\/\/www\.maniadb\.com\/album\/\d+)<\/link>/i);
        if (!linkMatch) return null;
        
        const albumUrl = linkMatch[1];
        
        // [2단계] 알아낸 앨범 페이지로 직접 접속 (여기서부터 EUC-KR의 마수가 뻗칩니다)
        const htmlRes = await fetch(albumUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!htmlRes.ok) return null;
        
        // 🔥 [3단계 핵심] 텍스트가 아닌 '원시 데이터(Buffer)'로 받은 뒤 EUC-KR 번역기로 돌립니다!
        const arrayBuffer = await htmlRes.arrayBuffer();
        const decoder = new TextDecoder('euc-kr');
        const html = decoder.decode(arrayBuffer);
        
        // [4단계] 불순물 제거: &nbsp;와 HTML 태그를 두 칸 공백(  )으로 완전히 밀어버립니다.
        let cleanHtml = html.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
        cleanHtml = cleanHtml.replace(/<[^>]+>/g, '  ');

        let extraartists = [];
        let seen = new Set();

        // [5단계] 번역된 한글(작사/작곡/편곡)을 기준으로 이름만 쏙 빼옵니다.
        const regex = /(작사|작곡|편곡)\s*:\s*([^\s][^:]+?)(?=\s{2,}|작사|작곡|편곡|$)/g;
        let m;
        
        while ((m = regex.exec(cleanHtml)) !== null) {
            let roleType = m[1].trim();
            let namesRaw = m[2].trim();
            
            let label = roleType === '작사' ? '작사 (Lyricist)' : 
                        roleType === '작곡' ? '작곡 (Composer)' : '편곡 (Arranger)';
            
            // 쉼표(,), 앰퍼샌드(&), 슬래시(/)로 묶인 공동 작업자 분리
            let names = namesRaw.split(/[,&/]/).map(n => n.trim()).filter(n => n);
            
            names.forEach(name => {
                if (name.length > 0 && name.length < 25 && !seen.has(label + name)) {
                    seen.add(label + name);
                    extraartists.push({ role: label, name: name });
                }
            });
        }

        return { extraartists, tracklist: [] };
    } catch (e) {
        console.error("ManiaDB EUC-KR Scraping Error:", e);
        return null;
    }
}
