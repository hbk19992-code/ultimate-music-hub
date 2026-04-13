export default async function handler(req, res) {
    const { albumTitle, artistName } = req.query;

    if (!albumTitle || !artistName) {
        return res.status(400).json({ error: "앨범 이름과 아티스트 이름이 필요합니다." });
    }

    try {
        // 🚀 1순위: Discogs API (글로벌 표준)
        const discogsData = await searchDiscogs(albumTitle, artistName);
        if (discogsData && discogsData.extraartists && discogsData.extraartists.length > 0) {
            discogsData.extraartists.unshift({ role: '💿 Data Source', name: 'Discogs Official' });
            return res.status(200).json(discogsData);
        }

        // 🚀 2순위: MusicBrainz (오픈 DB 백업)
        const mbData = await searchMusicBrainz(albumTitle, artistName);
        if (mbData && mbData.extraartists && mbData.extraartists.length > 0) {
            mbData.extraartists.unshift({ role: '🧠 Data Source', name: 'MusicBrainz Open DB' });
            return res.status(200).json(mbData);
        }

        // 🚀 3순위: ManiaDB (한국 음악 전용 정밀 스크래핑)
        const maniaData = await searchManiaDB(albumTitle, artistName);
        if (maniaData && (maniaData.extraartists.length > 0 || maniaData.tracklist.length > 0)) {
            maniaData.extraartists.unshift({ role: '🇰🇷 Data Source', name: 'ManiaDB (Scraping Mode)' });
            return res.status(200).json(maniaData);
        }

        // 모든 소스 실패 시
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
// 🛠 1. Discogs 검색 엔진
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
// 🛠 2. MusicBrainz 검색 엔진
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
// 🛠 3. ManiaDB 딥 스크래핑 엔진 (최종 보완판)
// ==========================================
async function searchManiaDB(title, artist) {
    try {
        // [1단계] API 검색어 꼬임 방지: 아티스트 이름으로만 검색해서 앨범 목록을 가져옵니다.
        const apiUrl = `http://www.maniadb.com/api/search/${encodeURIComponent(artist)}/?sr=album&display=10&key=example&v=0.5`;
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) return null;
        
        const xml = await apiRes.text();
        
        // [2단계] [digital single] 같은 꼬리표를 무시하고 앨범 고유 링크를 찾습니다.
        let albumUrl = null;
        const cleanSearchTitle = title.toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').trim();
        
        const items = xml.split('<item ');
        for (let i = 1; i < items.length; i++) {
            const tMatch = items[i].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i);
            const lMatch = items[i].match(/<link>(http:\/\/www\.maniadb\.com\/album\/\d+)<\/link>/i);
            if (tMatch && lMatch) {
                const itemTitle = tMatch[1].toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').trim();
                // 타이틀이 겹치면 해당 URL 획득!
                if (itemTitle.includes(cleanSearchTitle) || cleanSearchTitle.includes(itemTitle)) {
                    albumUrl = lMatch[1];
                    break;
                }
            }
        }

        // 아티스트 검색으로 못 찾았다면, 앨범명으로 한 번 더 찌릅니다 (Fallback)
        if (!albumUrl) {
            const fallbackUrl = `http://www.maniadb.com/api/search/${encodeURIComponent(title)}/?sr=album&display=3&key=example&v=0.5`;
            const fbRes = await fetch(fallbackUrl);
            const fbXml = await fbRes.text();
            const fbLinkMatch = fbXml.match(/<link>(http:\/\/www\.maniadb\.com\/album\/\d+)<\/link>/i);
            if (fbLinkMatch) albumUrl = fbLinkMatch[1];
        }

        if (!albumUrl) return null;

        // [3단계] 고유 URL로 접속해서 HTML 페이지 전체를 가져옵니다.
        const htmlRes = await fetch(albumUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!htmlRes.ok) return null;
        const html = await htmlRes.text();

        let extraartists = [];
        let tracklist = [];
        let seen = new Set();

        // 수록곡명 추출 (HTML에서 직접 추출)
        const trackMatches = html.match(/class="tracktitle"[^>]*>(.*?)<\/a>/gi);
        if (trackMatches) {
            trackMatches.forEach(m => {
                const t = m.match(/>([^<]+)<\/a>/);
                if (t) tracklist.push({ title: t[1].trim(), extraartists: [] });
            });
        }

        // 🔥 [4단계] 정밀 메스: 작사, 작곡, 편곡이 딱 붙어있어도 완벽히 절개합니다.
        const regex = /(작사|작곡|편곡)\s*:\s*([^<]+(?:<a[^>]*>[^<]+<\/a>[^<]*)*)/gi;
        let m;
        while ((m = regex.exec(html)) !== null) {
            let roleType = m[1].trim();
            // 태그 다 지우기
            let namesRaw = m[2].replace(/<\/?[^>]+(>|$)/g, "").trim(); 
            
            // 핵심: 다음 역할 이름이 나오기 전까지만 자르기! (London Fog 작곡: Park... -> London Fog)
            namesRaw = namesRaw.split(/(?:작사|작곡|편곡)\s*:/)[0].trim();
            
            let label = roleType === '작사' ? '작사 (Lyricist)' : 
                        roleType === '작곡' ? '작곡 (Composer)' : '편곡 (Arranger)';
            
            // 콤마(,)나 앰퍼샌드(&)로 공동 작업자 분리
            let names = namesRaw.split(/[,&/]/).map(n => n.trim()).filter(n => n);
            
            names.forEach(name => {
                if (name.length > 0 && name.length < 20 && !seen.has(label + name)) {
                    seen.add(label + name);
                    extraartists.push({ role: label, name: name });
                }
            }
            );
        }

        return { extraartists, tracklist };
    } catch (e) {
        console.error("ManiaDB Error:", e);
        return null;
    }
}