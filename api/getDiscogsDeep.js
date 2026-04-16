// /api/getDiscogsDeep.js  V5 - Ultra-Light (1 request per stage)
//
// V4 문제: stage 1 (아티스트 검색 + 디스코그래피 페이지) 두 요청이 느릴 때 timeout
//
// V5 해결: 각 stage가 Discogs에 딱 1개 요청만 보냄.
// 타임아웃 8.5초 (Vercel 10초 함수 제한 내).
// 프론트엔드가 8개 stage를 순차 호출. 각 호출은 1-4초에 끝남.

export default async function handler(req, res) {
try {
return await mainHandler(req, res);
} catch (topError) {
console.error(’[getDiscogsDeep] TOP:’, topError);
return res.status(500).json({
error: `crash: ${topError?.message || String(topError)}`,
results: [], done: false, nextStage: null
});
}
}

async function mainHandler(req, res) {
const { artistName, stage, artistId: artistIdParam } = req.query;
if (!artistName) {
return res.status(400).json({ error: ‘artistName required’, results: [], done: true, nextStage: null });
}
if (typeof fetch !== ‘function’) {
return res.status(500).json({
error: ‘fetch unavailable (need Node 18+)’,
results: [], done: true, nextStage: null
});
}

const TOKEN = process.env.DISCOGS_TOKEN;
const headers = { ‘User-Agent’: ‘CanYouDigIt/1.0 +https://owb-digging.app’ };
const tokenQ = TOKEN ? `&token=${TOKEN}` : ‘’;
const artistNameLower = artistName.toLowerCase();

// 단일 fetch, 8.5초 타임아웃
const fetchJson = async (url) => {
const ctrl = new AbortController();
const timeoutId = setTimeout(() => ctrl.abort(), 8500);
try {
const r = await fetch(url, { headers, signal: ctrl.signal });
clearTimeout(timeoutId);
if (r.status === 429) return { _rateLimited: true };
if (!r.ok) return { _httpError: r.status };
return await r.json();
} catch (e) {
clearTimeout(timeoutId);
return { _fetchError: e?.message || ‘unknown’ };
}
};

const parseSearch = (d, badge, role) => {
if (!d || d._rateLimited || d._httpError || d._fetchError || !d.results) return [];
const out = [];
const seen = new Set();
d.results.forEach(r => {
if (!r.title || seen.has(r.id)) return;
seen.add(r.id);
const ft = (r.title || ‘’).toLowerCase();
if (!ft.includes(artistNameLower)) return;
const parts = r.title.split(’ - ‘);
let albumTitle, albumArtist = ‘’;
if (parts.length >= 2) {
albumArtist = parts[0].trim();
albumTitle = parts.slice(1).join(’ - ’).trim();
} else {
albumTitle = r.title;
}
if (albumArtist.toLowerCase() === artistNameLower) return;
out.push({
title: albumTitle,
artist: albumArtist || ‘Various’,
year: r.year || null,
role,
thumb: r.thumb || ‘’,
discogsId: r.id,
_badge: badge
});
});
return out;
};

const parseReleases = (d) => {
if (!d || d._rateLimited || d._httpError || d._fetchError || !d.releases) return [];
const out = [];
const seen = new Set();
d.releases.forEach(r => {
if (seen.has(r.id)) return;
seen.add(r.id);
if (r.role && r.role !== ‘Main’ && r.artist && r.title) {
out.push({
title: r.title,
artist: r.artist,
year: r.year || null,
role: r.role,
thumb: r.thumb || ‘’,
discogsId: r.id,
_badge: ‘SIDEMAN’
});
}
});
return out;
};

const s = parseInt(stage || ‘1’, 10);

// ========= STAGE 1: 아티스트 ID 확보 (1 req) =========
if (s === 1) {
const sData = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=artist&per_page=10${tokenQ}`
);
if (!sData || sData._fetchError) {
return res.status(200).json({
error: `Stage 1: Discogs 응답 없음 (${sData?._fetchError || 'null'})`,
results: [], done: true, nextStage: null
});
}
if (sData._rateLimited) {
return res.status(200).json({
error: ‘Discogs rate limit - 1분 후 재시도’,
results: [], done: true, nextStage: null
});
}
if (sData._httpError) {
return res.status(200).json({
error: `Discogs HTTP ${sData._httpError}`,
results: [], done: true, nextStage: null
});
}
if (!sData.results?.length) {
return res.status(200).json({
error: ‘Discogs에서 아티스트를 찾을 수 없음’,
results: [], done: true, nextStage: null
});
}
const exactMatch = sData.results.find(r => r.title?.toLowerCase() === artistNameLower);
const artist = exactMatch || sData.results[0];
return res.status(200).json({
results: [], done: false, nextStage: 2, artistId: artist.id,
stageLabel: `아티스트 확인 (ID: ${artist.id})`
});
}

// ========= STAGE 2: Disco page 4 (1 req) =========
if (s === 2) {
if (!artistIdParam) return res.status(200).json({ error: ‘artistId missing’, results: [], done: false, nextStage: 3 });
const d = await fetchJson(
`https://api.discogs.com/artists/${artistIdParam}/releases?per_page=100&page=4&sort=year&sort_order=desc${tokenQ}`
);
return res.status(200).json({
results: parseReleases(d), done: false, nextStage: 3, artistId: artistIdParam,
stageLabel: ‘디스코그래피 4페이지’
});
}

// ========= STAGE 3: Disco page 5 (1 req) =========
if (s === 3) {
if (!artistIdParam) return res.status(200).json({ error: ‘artistId missing’, results: [], done: false, nextStage: 4 });
const d = await fetchJson(
`https://api.discogs.com/artists/${artistIdParam}/releases?per_page=100&page=5&sort=year&sort_order=desc${tokenQ}`
);
return res.status(200).json({
results: parseReleases(d), done: false, nextStage: 4, artistId: artistIdParam,
stageLabel: ‘디스코그래피 5페이지’
});
}

// ========= STAGE 4: V.A. Compilation page 1 (1 req) =========
if (s === 4) {
const d = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=1${tokenQ}`
);
return res.status(200).json({
results: parseSearch(d, ‘V.A.’, ‘V.A. Compilation’), done: false, nextStage: 5,
artistId: artistIdParam, stageLabel: ‘V.A. 컴필레이션 1페이지’
});
}

// ========= STAGE 5: V.A. Compilation page 2 (1 req) =========
if (s === 5) {
const d = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName)}&type=release&format=Compilation&per_page=100&page=2${tokenQ}`
);
return res.status(200).json({
results: parseSearch(d, ‘V.A.’, ‘V.A. Compilation’), done: false, nextStage: 6,
artistId: artistIdParam, stageLabel: ‘V.A. 컴필레이션 2페이지’
});
}

// ========= STAGE 6: summit keyword (1 req) =========
if (s === 6) {
const d = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName + ' summit')}&type=release&per_page=50${tokenQ}`
);
return res.status(200).json({
results: parseSearch(d, ‘DEEP’, ‘Deep Search’), done: false, nextStage: 7,
artistId: artistIdParam, stageLabel: ‘summit 키워드’
});
}

// ========= STAGE 7: tribute keyword (1 req) =========
if (s === 7) {
const d = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName + ' tribute')}&type=release&per_page=50${tokenQ}`
);
return res.status(200).json({
results: parseSearch(d, ‘DEEP’, ‘Deep Search’), done: false, nextStage: 8,
artistId: artistIdParam, stageLabel: ‘tribute 키워드’
});
}

// ========= STAGE 8: guest/session keyword (1 req) =========
if (s === 8) {
const d = await fetchJson(
`https://api.discogs.com/database/search?q=${encodeURIComponent(artistName + ' guest')}&type=release&per_page=50${tokenQ}`
);
return res.status(200).json({
results: parseSearch(d, ‘DEEP’, ‘Deep Search’), done: true, nextStage: null,
artistId: artistIdParam, stageLabel: ‘guest 키워드 (최종)’
});
}

return res.status(400).json({
error: `Unknown stage: ${s}`, results: [], done: true, nextStage: null
});
}