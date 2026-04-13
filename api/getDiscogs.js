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

        // 🚀 3순위: ManiaDB (한국 음악 전용 스크래핑 엔진)
        // API가 주지 않는 작사/작곡 정보를 웹페이지에서 직접 추출합니다.
        const maniaData = await searchManiaDB(albumTitle, artistName);
        if (maniaData && (maniaData.extraartists.length > 0 || maniaData.tracklist.length > 0)) {
            maniaData.extraartists.unshift({ role: '🇰🇷 Data Source', name: 'ManiaDB (Scraping Mode)' });
            return res.status(200).json(maniaData);
        }

        // 모든 소스 실패 시
        return res.status(200).json({ 
            extraartists: [{ role: 'System', name: '검색된 모든 DB에 세션 정보가 없습니다.' }], 
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
    if (!token) throw new Error("DISCOGS_TOKEN 환경변수가 설정되지 않았습니다.");
    
    const searchUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&type=release&token=${token}`;
    const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MusicHubEngine/1.0' } });
    if (!searchRes.ok) return null;
    
    const searchJson = await searchRes.json();
    if (!searchJson.results || searchJson.results.length === 0) return null;

    const releaseId = searchJson.results[0].id;
    const detailRes = await fetch(`https://api.discogs.com/releases/${releaseId}`, { 
        headers: { 'User-Agent': 'MusicHubEngine/1.0' } 
    });
    return detailRes.ok ? await detailRes.ok.json() : null;
}

// ==========================================
// 🛠 2. MusicBrainz 검색 엔진
// ==========================================
async function searchMusicBrainz(title, artist) {
    const headers = { 'User-Agent': 'MusicHubEngine/1.0 ( contact@example.com )', 'Accept': 'application/json' };
    const q = encodeURIComponent(`release:"${title}" AND artist:"${artist}"`);
    const searchRes = await fetch(`https://musicbrainz.org/ws/2/release/?query=${q}&fmt=json&limit=1`, { headers });
    
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
// 🛠 3. ManiaDB 스크래핑 엔진 (가장 강력함)
// ==========================================
async function searchManiaDB(title, artist) {
    try {
        const apiUrl = `http://www.maniadb.com/api/search/${encodeURIComponent(title + ' ' + artist)}/?sr=album&display=1&key=example&v=0.5`;
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) return null;
        
        const xml = await apiRes.text();
        const linkMatch = xml.match(/<link>(http:\/\/www\.maniadb\.com\/album\/\d+)<\/link>/);
        if (!linkMatch) return null;
        
        const albumUrl = linkMatch[1];
        const htmlRes = await fetch(albumUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!htmlRes.ok) return null;
        
        const html = await htmlRes.text();
        let extraartists = [];
        let tracklist = [];
        let seen = new Set();

        // 트랙리스트 기본 추출
        const trackMatches = xml.match(/<maniadb:track[^>]*><title><!\[CDATA\[(.*?)\]\]><\/title>/g);
        if (trackMatches) {
            trackMatches.forEach(m => {
                const t = m.match(/<!\[CDATA\[(.*?)\]\]>/);
                if (t) tracklist.push({ title: t[1], extraartists: [] });
            });
        }

        // 🔥 웹페이지 텍스트에서 작사/작곡/편곡 데이터 강제 추출
        const patterns = [
            { regex: /작사\s*:\s*([^<&\n]+)/g, label: '작사 (Lyricist)' },
            { regex: /작곡\s*:\s*([^<&\n]+)/g, label: '작곡 (Composer)' },
            { regex: /편곡\s*:\s*([^<&\n]+)/g, label: '편곡 (Arranger)' }
        ];

        patterns.forEach(p => {
            let m;
            while ((m = p.regex.exec(html)) !== null) {
                let name = m[1].trim().replace(/<\/?[^>]+(>|$)/g, "").split(',')[0].trim(); 
                if (name && name.length < 30 && !seen.has(p.label + name)) {
                    seen.add(p.label + name);
                    extraartists.push({ role: p.label, name: name });
                }
            }
        });

        return { extraartists, tracklist };
    } catch (e) { return null; }
}
