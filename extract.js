#!/usr/bin/env node
/**
 * Railway Data Extractor for Central Asia & Eurasia
 * 
 * Queries the Overpass API for each country, extracts railway lines and stations,
 * and saves them as compact static JSON files for use by the web app.
 * 
 * Usage:
 *   node extract.js                  # Extract all countries
 *   node extract.js turkey iran      # Extract specific countries
 * 
 * Output:
 *   data/railways/{country}.json     # Railway line geometries
 *   data/stations/{country}.json     # Station locations and metadata
 *   data/manifest.json               # Index of available data files with timestamps
 * 
 * Host the /data folder alongside your index.html on GitHub Pages.
 */

const fs = require('fs');
const path = require('path');

// ===== CONFIGURATION =====

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];

const COUNTRIES = {
    'turkey':       { name: 'Turkey',       bbox: [35.81, 25.66, 42.11, 44.82], code: 'TR' },
    'romania':      { name: 'Romania',      bbox: [43.62, 20.26, 48.27, 29.69], code: 'RO' },
    'ukraine':      { name: 'Ukraine',      bbox: [44.39, 22.14, 52.38, 40.23], code: 'UA' },
    'russia':       { name: 'Russia',       bbox: [41.19, 27.31, 70.00, 100.0], code: 'RU' },  // Capped at 100°E
    'bulgaria':     { name: 'Bulgaria',     bbox: [41.24, 22.36, 44.22, 28.61], code: 'BG' },
    'iran':         { name: 'Iran',         bbox: [25.06, 44.05, 39.78, 63.32], code: 'IR' },
    'afghanistan':  { name: 'Afghanistan',  bbox: [29.38, 60.50, 38.49, 74.89], code: 'AF' },
    'pakistan':      { name: 'Pakistan',     bbox: [23.69, 60.87, 37.08, 77.84], code: 'PK' },
    'uzbekistan':   { name: 'Uzbekistan',   bbox: [37.18, 55.99, 45.59, 73.13], code: 'UZ' },
    'turkmenistan': { name: 'Turkmenistan', bbox: [35.14, 52.50, 42.80, 66.68], code: 'TM' },
    'azerbaijan':   { name: 'Azerbaijan',   bbox: [38.39, 44.77, 41.91, 50.63], code: 'AZ' },
    'kazakhstan':   { name: 'Kazakhstan',   bbox: [40.57, 46.49, 55.44, 87.31], code: 'KZ' }
};

// For large countries, split into tiles to avoid Overpass timeouts
const TILE_THRESHOLD_DEG = 15; // If bbox span > this in either axis, tile it
const TILE_SIZE_DEG = 10;

const DELAY_BETWEEN_QUERIES_MS = 5000;
const MAX_RETRIES = 3;

// ===== HELPERS =====

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function queryOverpass(query) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                console.log(`  → ${endpoint.includes('kumi') ? 'mirror' : 'primary'}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
                
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 180000); // 3 min timeout
                
                const resp = await fetch(endpoint, {
                    method: 'POST',
                    body: query,
                    signal: controller.signal
                });
                clearTimeout(timeout);
                
                if (resp.status === 429) {
                    const wait = 10000 * (attempt + 1);
                    console.log(`  ⚠ Rate limited. Waiting ${wait/1000}s...`);
                    await sleep(wait);
                    continue;
                }
                if (resp.status === 504 || resp.status === 503) {
                    console.log(`  ⚠ Server ${resp.status}. Trying next endpoint...`);
                    break;
                }
                if (!resp.ok) {
                    console.log(`  ⚠ HTTP ${resp.status}`);
                    continue;
                }
                
                const data = await resp.json();
                return data;
            } catch (e) {
                if (e.name === 'AbortError') {
                    console.log(`  ⚠ Timeout. ${attempt < MAX_RETRIES - 1 ? 'Retrying...' : 'Trying next endpoint...'}`);
                } else {
                    console.log(`  ⚠ Error: ${e.message}`);
                }
            }
        }
    }
    return null;
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getTiles(bbox) {
    const [s, w, n, e] = bbox;
    const latSpan = n - s;
    const lonSpan = e - w;
    
    if (latSpan <= TILE_THRESHOLD_DEG && lonSpan <= TILE_THRESHOLD_DEG) {
        return [bbox];
    }
    
    const tiles = [];
    for (let lat = s; lat < n; lat += TILE_SIZE_DEG) {
        for (let lon = w; lon < e; lon += TILE_SIZE_DEG) {
            tiles.push([
                lat,
                lon,
                Math.min(lat + TILE_SIZE_DEG, n),
                Math.min(lon + TILE_SIZE_DEG, e)
            ]);
        }
    }
    console.log(`  Split into ${tiles.length} tiles`);
    return tiles;
}

// ===== EXTRACTION =====

async function extractRailways(countryKey, country) {
    console.log(`\n🚂 Extracting railways for ${country.name}...`);
    
    const tiles = getTiles(country.bbox);
    const allWays = [];
    const seenIds = new Set();
    
    for (let i = 0; i < tiles.length; i++) {
        const [s, w, n, e] = tiles[i];
        if (tiles.length > 1) console.log(`  Tile ${i+1}/${tiles.length}: [${s.toFixed(1)},${w.toFixed(1)},${n.toFixed(1)},${e.toFixed(1)}]`);
        
        const query = `[out:json][timeout:180][bbox:${s},${w},${n},${e}];
way["railway"~"rail|narrow_gauge|light_rail|subway|tram|disused|abandoned|preserved|construction|proposed"];
out geom;`;
        
        const data = await queryOverpass(query);
        if (!data || !data.elements) {
            console.log(`  ⚠ No data returned for tile ${i+1}`);
            continue;
        }
        
        for (const el of data.elements) {
            if (seenIds.has(el.id)) continue;
            seenIds.add(el.id);
            
            if (!el.geometry || el.geometry.length < 2) continue;
            
            // Compact format: only store what we need
            allWays.push({
                id: el.id,
                type: el.tags?.railway || 'rail',
                // Reduce coordinate precision to 5 decimal places (~1.1m)
                geometry: el.geometry.map(p => [
                    Math.round(p.lat * 100000) / 100000,
                    Math.round(p.lon * 100000) / 100000
                ])
            });
        }
        
        if (i < tiles.length - 1) await sleep(DELAY_BETWEEN_QUERIES_MS);
    }
    
    console.log(`  ✅ ${allWays.length} railway segments (${seenIds.size} unique)`);
    return allWays;
}

async function extractStations(countryKey, country) {
    console.log(`🚉 Extracting stations for ${country.name}...`);
    
    const [s, w, n, e] = country.bbox;
    const bbox = `${s},${w},${n},${e}`;
    
    // First get towns for naming unnamed stations
    const townQuery = `[out:json][timeout:60][bbox:${bbox}];
node["place"~"city|town"];
out tags;`;
    
    const townData = await queryOverpass(townQuery);
    const towns = townData?.elements?.map(t => ({
        lat: t.lat, lon: t.lon, name: t.tags?.name || t.tags?.['name:en']
    })) || [];
    
    console.log(`  Found ${towns.length} towns`);
    await sleep(DELAY_BETWEEN_QUERIES_MS);
    
    // Now get stations
    const stationQuery = `[out:json][timeout:180][bbox:${bbox}];
(
  node["railway"~"station|halt|stop|service_station"];
  way["railway"~"station|halt|service_station"];
  node["public_transport"="station"]["train"="yes"];
  way["public_transport"="station"];
  way["building"="train_station"];
  node["name"~"[Ss]tation|[Vv]okzal|[Gg]ar|İstasyon|ایستگاه|вокзал|станция"];
);
out center tags;`;
    
    const data = await queryOverpass(stationQuery);
    if (!data || !data.elements) {
        console.log(`  ⚠ No stations found`);
        return [];
    }
    
    // Deduplicate
    const stationMap = new Map();
    
    for (const el of data.elements) {
        const lat = el.type === 'way' ? el.center?.lat : el.lat;
        const lon = el.type === 'way' ? el.center?.lon : el.lon;
        if (!lat || !lon) continue;
        
        // Filter building=train_station not near towns
        if (el.tags?.building === 'train_station' && towns.length > 0) {
            const nearTown = towns.some(t => haversine(lat, lon, t.lat, t.lon) <= 10);
            if (!nearTown) continue;
        }
        
        let name = el.tags?.name || el.tags?.['name:en'] || el.tags?.ref;
        
        if (!name) {
            let closestTown = null, minDist = Infinity;
            for (const town of towns) {
                const d = haversine(lat, lon, town.lat, town.lon);
                if (d < minDist && d < 5) { minDist = d; closestTown = town; }
            }
            if (closestTown?.name) {
                name = `${closestTown.name} Station`;
            } else {
                continue; // Skip truly unnamed stations in static data
            }
        }
        
        const key = `${lat.toFixed(4)},${lon.toFixed(4)}`; // ~11m dedup radius
        
        if (!stationMap.has(key) || name.toLowerCase().match(/station|vokzal|gar|istasyon/)) {
            stationMap.set(key, {
                id: el.id,
                lat: Math.round(lat * 100000) / 100000,
                lon: Math.round(lon * 100000) / 100000,
                name,
                nameEn: el.tags?.['name:en'] || null,
                type: el.tags?.railway || 'station'
            });
        }
    }
    
    const stations = Array.from(stationMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    console.log(`  ✅ ${stations.length} stations`);
    return stations;
}

// ===== MAIN =====

async function main() {
    const args = process.argv.slice(2);
    const countriesToExtract = args.length > 0 
        ? args.filter(a => COUNTRIES[a])
        : Object.keys(COUNTRIES);
    
    if (args.length > 0) {
        const invalid = args.filter(a => !COUNTRIES[a]);
        if (invalid.length) console.log(`⚠ Unknown countries: ${invalid.join(', ')}`);
    }
    
    console.log(`\n========================================`);
    console.log(`Railway Data Extractor`);
    console.log(`Countries: ${countriesToExtract.map(k => COUNTRIES[k].name).join(', ')}`);
    console.log(`========================================\n`);
    
    // Create output directories
    const dataDir = path.join(__dirname, '..', 'data');
    const railDir = path.join(dataDir, 'railways');
    const statDir = path.join(dataDir, 'stations');
    
    fs.mkdirSync(railDir, { recursive: true });
    fs.mkdirSync(statDir, { recursive: true });
    
    const manifest = {
        generated: new Date().toISOString(),
        countries: {}
    };
    
    for (const key of countriesToExtract) {
        const country = COUNTRIES[key];
        
        try {
            // Extract railways
            const railways = await extractRailways(key, country);
            const railFile = path.join(railDir, `${key}.json`);
            fs.writeFileSync(railFile, JSON.stringify(railways));
            const railSize = (fs.statSync(railFile).size / 1024).toFixed(0);
            console.log(`  📦 Railways: ${railFile} (${railSize} KB)`);
            
            await sleep(DELAY_BETWEEN_QUERIES_MS);
            
            // Extract stations
            const stations = await extractStations(key, country);
            const statFile = path.join(statDir, `${key}.json`);
            fs.writeFileSync(statFile, JSON.stringify(stations));
            const statSize = (fs.statSync(statFile).size / 1024).toFixed(0);
            console.log(`  📦 Stations: ${statFile} (${statSize} KB)`);
            
            manifest.countries[key] = {
                name: country.name,
                code: country.code,
                bbox: country.bbox,
                railwaySegments: railways.length,
                stations: stations.length,
                railwayFileKB: parseInt(railSize),
                stationFileKB: parseInt(statSize),
                extracted: new Date().toISOString()
            };
            
            await sleep(DELAY_BETWEEN_QUERIES_MS);
            
        } catch (e) {
            console.log(`  ❌ Failed: ${e.message}`);
            manifest.countries[key] = { name: country.name, error: e.message };
        }
    }
    
    // Write manifest
    const manifestFile = path.join(dataDir, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    console.log(`\n📋 Manifest: ${manifestFile}`);
    
    // Summary
    console.log(`\n========================================`);
    console.log(`SUMMARY`);
    console.log(`========================================`);
    let totalRail = 0, totalStat = 0, totalKB = 0;
    for (const [key, info] of Object.entries(manifest.countries)) {
        if (info.error) {
            console.log(`  ❌ ${info.name}: ${info.error}`);
        } else {
            console.log(`  ✅ ${info.name}: ${info.railwaySegments} railways, ${info.stations} stations (${info.railwayFileKB + info.stationFileKB} KB)`);
            totalRail += info.railwaySegments;
            totalStat += info.stations;
            totalKB += info.railwayFileKB + info.stationFileKB;
        }
    }
    console.log(`\n  Total: ${totalRail} railway segments, ${totalStat} stations, ${totalKB} KB`);
    console.log(`\nDone! Host the /data folder alongside index.html on GitHub Pages.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
