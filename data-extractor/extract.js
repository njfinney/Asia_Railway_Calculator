#!/usr/bin/env node
/**
 * Railway Data Extractor for Central Asia & Eurasia
 * 
 * Modes (for parallel GitHub Actions jobs):
 *   node extract.js stations turkey romania ...
 *   node extract.js railways turkey romania ...
 *   node extract.js all turkey                    
 * 
 * Station extraction focuses on MAJOR stations only (railway=station near 
 * cities/towns). Rural halts/stops are loaded on-demand via Overpass 
 * when users use the map picker in the web app.
 * 
 * Output:  data/railways/{country}.json
 *          data/stations/{country}.json
 *          data/manifest.json
 */

const fs = require('fs');
const path = require('path');

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];

// Countries grouped by size for tiling strategy
const COUNTRIES_SMALL = {
    'bulgaria':     { name: 'Bulgaria',     bbox: [41.24, 22.36, 44.22, 28.61], code: 'BG' },
    'azerbaijan':   { name: 'Azerbaijan',   bbox: [38.39, 44.77, 41.91, 50.63], code: 'AZ' },
    'turkmenistan': { name: 'Turkmenistan', bbox: [35.14, 52.50, 42.80, 66.68], code: 'TM' },
    'afghanistan':  { name: 'Afghanistan',  bbox: [29.38, 60.50, 38.49, 74.89], code: 'AF' },
};
const COUNTRIES_MEDIUM = {
    'romania':      { name: 'Romania',      bbox: [43.62, 20.26, 48.27, 29.69], code: 'RO' },
    'uzbekistan':   { name: 'Uzbekistan',   bbox: [37.18, 55.99, 45.59, 73.13], code: 'UZ' },
    'turkey':       { name: 'Turkey',       bbox: [35.81, 25.66, 42.11, 44.82], code: 'TR' },
};
const COUNTRIES_LARGE = {
    'iran':         { name: 'Iran',         bbox: [25.06, 44.05, 39.78, 63.32], code: 'IR' },
    'pakistan':      { name: 'Pakistan',     bbox: [23.69, 60.87, 37.08, 77.84], code: 'PK' },
    'ukraine':      { name: 'Ukraine',      bbox: [44.39, 22.14, 52.38, 40.23], code: 'UA' },
    'kazakhstan':   { name: 'Kazakhstan',   bbox: [40.57, 46.49, 55.44, 87.31], code: 'KZ' },
};
const COUNTRIES_XLARGE = {
    'russia':       { name: 'Russia',       bbox: [41.19, 27.31, 70.00, 100.0], code: 'RU' },
};

const ALL_COUNTRIES = { ...COUNTRIES_SMALL, ...COUNTRIES_MEDIUM, ...COUNTRIES_LARGE, ...COUNTRIES_XLARGE };

const TILE_SIZES = { small: 20, medium: 8, large: 6, xlarge: 5 };
const DELAY_MS = 8000;
const MAX_RETRIES = 3;
const QUERY_TIMEOUT_S = 120;

// ===== HELPERS =====

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getCountrySize(key) {
    if (COUNTRIES_SMALL[key]) return 'small';
    if (COUNTRIES_MEDIUM[key]) return 'medium';
    if (COUNTRIES_LARGE[key]) return 'large';
    return 'xlarge';
}

async function queryOverpass(query) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const label = endpoint.includes('kumi') ? 'mirror' : 'primary';
                console.log(`  → ${label}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 200000);
                const resp = await fetch(endpoint, { method: 'POST', body: query, signal: controller.signal });
                clearTimeout(timer);

                if (resp.status === 429) {
                    const wait = 15000 * (attempt + 1);
                    console.log(`  ⚠ Rate limited. Waiting ${wait/1000}s...`);
                    await sleep(wait);
                    continue;
                }
                if (resp.status >= 500) { console.log(`  ⚠ Server ${resp.status}`); break; }
                if (!resp.ok) { console.log(`  ⚠ HTTP ${resp.status}`); await sleep(5000); continue; }
                return await resp.json();
            } catch (e) {
                console.log(`  ⚠ ${e.name === 'AbortError' ? 'Timeout' : e.message}`);
                if (attempt === MAX_RETRIES - 1) break;
                await sleep(5000);
            }
        }
    }
    return null;
}

function getTiles(bbox, tileSize) {
    const [s, w, n, e] = bbox;
    if ((n - s) <= tileSize && (e - w) <= tileSize) return [bbox];
    const tiles = [];
    for (let lat = s; lat < n; lat += tileSize)
        for (let lon = w; lon < e; lon += tileSize)
            tiles.push([lat, lon, Math.min(lat + tileSize, n), Math.min(lon + tileSize, e)]);
    return tiles;
}

// ===== RAILWAYS =====

async function extractRailways(key, country) {
    const size = getCountrySize(key);
    const tiles = getTiles(country.bbox, TILE_SIZES[size]);
    console.log(`\n🚂 Railways: ${country.name} (${size}, ${tiles.length} tile${tiles.length > 1 ? 's' : ''})`);

    const allWays = [];
    const seenIds = new Set();

    for (let i = 0; i < tiles.length; i++) {
        const [s, w, n, e] = tiles[i];
        if (tiles.length > 1) console.log(`  Tile ${i+1}/${tiles.length}`);

        // Only extract rail types that matter for routing — skip tram/subway/abandoned/disused
        const query = `[out:json][timeout:${QUERY_TIMEOUT_S}][bbox:${s},${w},${n},${e}];
way["railway"~"rail|narrow_gauge|light_rail|construction|proposed"];
out geom;`;

        const data = await queryOverpass(query);
        if (!data?.elements) {
            console.log(`  ⚠ No data for tile ${i+1}`);
            if (i < tiles.length - 1) await sleep(DELAY_MS);
            continue;
        }

        let tileNew = 0;
        for (const el of data.elements) {
            if (seenIds.has(el.id)) continue;
            seenIds.add(el.id);
            if (!el.geometry || el.geometry.length < 2) continue;
            allWays.push({
                id: el.id,
                type: el.tags?.railway || 'rail',
                geometry: el.geometry.map(p => [
                    Math.round(p.lat * 100000) / 100000,
                    Math.round(p.lon * 100000) / 100000
                ])
            });
            tileNew++;
        }
        console.log(`  +${tileNew} segments (${allWays.length} total)`);
        if (i < tiles.length - 1) await sleep(DELAY_MS);
    }

    console.log(`  ✅ ${allWays.length} railway segments`);
    return allWays;
}

// ===== STATIONS (MAJOR ONLY) =====

async function extractStations(key, country) {
    console.log(`\n🚉 Stations: ${country.name} (major only)`);
    const [s, w, n, e] = country.bbox;

    // ONLY railway=station — not halt/stop/service_station
    // Excludes metro/subway stations
    const query = `[out:json][timeout:${QUERY_TIMEOUT_S}][bbox:${s},${w},${n},${e}];
(
  node["railway"="station"]["station"!="subway"]["station"!="light_rail"];
  way["railway"="station"];
  node["public_transport"="station"]["train"="yes"];
);
out center tags;`;

    const data = await queryOverpass(query);
    if (!data?.elements) { console.log(`  ⚠ No stations`); return []; }
    console.log(`  Raw: ${data.elements.length}`);

    const stationMap = new Map();
    for (const el of data.elements) {
        const lat = el.type === 'way' ? el.center?.lat : el.lat;
        const lon = el.type === 'way' ? el.center?.lon : el.lon;
        if (!lat || !lon) continue;

        let name = el.tags?.['name:en'] || el.tags?.name || el.tags?.ref;
        if (!name) continue;
        name = name.trim();

        const mapKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
        if (!stationMap.has(mapKey)) {
            stationMap.set(mapKey, {
                id: el.id,
                lat: Math.round(lat * 100000) / 100000,
                lon: Math.round(lon * 100000) / 100000,
                name,
                nameLocal: (el.tags?.name && el.tags.name !== name) ? el.tags.name : undefined,
                type: el.tags?.railway || 'station'
            });
        }
    }

    const stations = Array.from(stationMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    console.log(`  ✅ ${stations.length} major stations`);
    return stations;
}

// ===== MAIN =====

async function main() {
    const args = process.argv.slice(2);
    let mode = 'all';
    let countryArgs = args;
    if (['stations', 'railways', 'all'].includes(args[0])) {
        mode = args[0];
        countryArgs = args.slice(1);
    }

    const keys = countryArgs.length > 0
        ? countryArgs.filter(a => ALL_COUNTRIES[a])
        : Object.keys(ALL_COUNTRIES);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Mode: ${mode} | Countries: ${keys.map(k => ALL_COUNTRIES[k].name).join(', ')}`);
    console.log(`${'='.repeat(50)}\n`);

    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(path.join(dataDir, 'railways'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'stations'), { recursive: true });

    const manifestPath = path.join(dataDir, 'manifest.json');
    let manifest = { generated: null, countries: {} };
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}

    for (const key of keys) {
        const country = ALL_COUNTRIES[key];
        const entry = manifest.countries[key] || {};

        try {
            if (mode === 'all' || mode === 'railways') {
                const railways = await extractRailways(key, country);
                const fp = path.join(dataDir, 'railways', `${key}.json`);
                fs.writeFileSync(fp, JSON.stringify(railways));
                const kb = (fs.statSync(fp).size / 1024).toFixed(0);
                console.log(`  📦 ${kb} KB`);
                Object.assign(entry, { railwaySegments: railways.length, railwayFileKB: +kb, railwaysExtracted: new Date().toISOString() });
                await sleep(DELAY_MS);
            }

            if (mode === 'all' || mode === 'stations') {
                const stations = await extractStations(key, country);
                const fp = path.join(dataDir, 'stations', `${key}.json`);
                fs.writeFileSync(fp, JSON.stringify(stations));
                const kb = (fs.statSync(fp).size / 1024).toFixed(0);
                console.log(`  📦 ${kb} KB`);
                Object.assign(entry, { stations: stations.length, stationFileKB: +kb, stationsExtracted: new Date().toISOString() });
                await sleep(DELAY_MS);
            }

            Object.assign(entry, { name: country.name, code: country.code, bbox: country.bbox });
            delete entry.error;
        } catch (e) {
            console.log(`  ❌ ${country.name}: ${e.message}`);
            entry.error = e.message;
            entry.name = country.name;
        }
        manifest.countries[key] = entry;
    }

    manifest.generated = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`\n${'='.repeat(50)}\nSUMMARY\n${'='.repeat(50)}`);
    for (const [k, v] of Object.entries(manifest.countries)) {
        if (v.error) console.log(`  ❌ ${v.name}: ${v.error}`);
        else console.log(`  ✅ ${v.name}: ${v.railwaySegments||'?'} rail, ${v.stations||'?'} stations (${(v.railwayFileKB||0)+(v.stationFileKB||0)} KB)`);
    }
    console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
