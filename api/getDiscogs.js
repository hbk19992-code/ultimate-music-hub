export default async function handler(req, res) {
    const { albumTitle, artistName, sessionName, deepSearch } = req.query;

    // 🔥 [V25.0] 스나이퍼 모드 고급 검색 (artist와 credit 파라미터 분리 적용)
    if (deepSearch === 'true' && artistName && sessionName) {
        try {
            const token = process.env.DISCOGS_TOKEN;
            if (!token) throw new Error("DISCOGS_TOKEN 누락");
            
            const art = encodeURIComponent(artistName);
            const cred = encodeURIComponent(sessionName);
            
            // 단순 통검색(q)이 아닌, artist 필드와 credit(세션) 필드를 명시해서 정확도 100배 상승
            const searchUrl = `https://api.discogs.com/database/search?artist=${art}&credit=${cred}&token=${token}&per_page=100`;
            
            const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/2.0' } });
            const searchJson = searchRes.ok ? await searchRes.json() : { results: [] };
            
            // Miles Davis - Bitches Brew 같은 형태에서 "Bitches Brew"만 빼내고 중복은 날려버림
            const titles = [...new Set(searchJson.results.map(r => {
                let t = r.title.split(' - ');
                return t.length > 1 ? t[1].trim() : r.title;
            }))];
            
            return res.status(200).json({ matchedTitles: titles });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // --- 개별 앨범 디테일 검색 (기존 로직 유지) ---
    if (!albumTitle || !artistName) return res.status(400).json({ error: "앨범 이름과 아티스트 이름이 필요합니다." });

    try {
        const discogsData = await searchDiscogs(albumTitle, artistName);
        if (discogsData && discogsData.extraartists && discogsData.extraartists.length > 0) {
            discogsData.extraartists.unshift({ role: '💿 Data Source', name: 'Discogs Official' });
            return res.status(200).json(discogsData);
        }

        const mbData = await searchMusicBrainz(albumTitle, artistName);
        if (mbData && mbData.extraartists && mbData.extraartists.length > 0) {
            mbData.extraartists.unshift({ role: '🧠 Data Source', name: 'MusicBrainz Open DB' });
            return res.status(200).json(mbData);
        }

        const maniaData = await searchManiaDB(albumTitle, artistName);
        if (maniaData && maniaData.extraartists.length > 0) {
            maniaData.extraartists.unshift({ role: '🇰🇷 Data Source', name: 'ManiaDB (Artist Page Bot)' });
            return res.status(200).json(maniaData);
        }

        return res.status(200).json({ extraartists: [{ role: 'System', name: '검색된 모든 DB에 세션 정보가 없습니다 🥲' }], tracklist: [] });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

async function searchDiscogs(title, artist) {
    const token = process.env.DISCOGS_TOKEN;
    if (!token) return null;
    const query = encodeURIComponent(`${title} ${artist}`);
    let searchUrl = `https://api.discogs.com/database/search?q=${query}&type=master&token=${token}`;
    let searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
    let searchJson = searchRes.ok ? await searchRes.json() : { results: [] };
    let releaseId = null;

    if (searchJson.results && searchJson.results.length > 0) {
        const masterId = searchJson.results[0].id;
        const masterRes = await fetch(`https://api.discogs.com/masters/${masterId}`, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
        if (masterRes.ok) { const masterData = await masterRes.json(); releaseId = masterData.main_release; }
    } else {
        searchUrl = `https://api.discogs.com/database/search?q=${query}&type=release&token=${token}`;
        searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
        searchJson = searchRes.ok ? await searchRes.json() : { results: [] };
        if (searchJson.results && searchJson.results.length > 0) releaseId = searchJson.results[0].id;
    }

    if (!releaseId) return null;
    const detailRes = await fetch(`https://api.discogs.com/releases/${releaseId}`, { headers: { 'User-Agent': 'MusicHubEngine/1.1' } });
    return detailRes.ok ? await detailRes.json() : null; 
}

async function searchMusicBrainz(title, artist) {
    const headers = { 'User-Agent': 'MusicHubEngine/1.1', 'Accept': 'application/json' };
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
        let extraartists = []; let seen = new Set();
        const regex = /(작사|작곡|편곡)\s*:\s*([a-zA-Z가-힣0-9\s,&/().]+)/g; let m;
        while ((m = regex.exec(html)) !== null) {
            let roleType = m[1].trim(); let rawNames = m[2].trim();
            let label = roleType === '작사' ? '작사 (Lyricist)' : roleType === '작곡' ? '작곡 (Composer)' : '편곡 (Arranger)';
            let names = rawNames.split(/[,&/]/).map(n => n.trim()).filter(n => n);
            names.forEach(name => {
                if (name.length > 0 && name.length < 25 && !seen.has(label + name)) {
                    seen.add(label + name); extraartists.push({ role: label, name: name });
                }
            });
        }
        return { extraartists, tracklist: [] };
    } catch (e) { return null; }
}
