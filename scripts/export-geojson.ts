/**
 * export-geojson.ts
 *
 * Queries the local Postgres database and writes a GeoJSON FeatureCollection
 * to ../frontend/src/data/seed.geojson, ready for the frontend to consume.
 *
 * Usage: npm run export
 */

import { Client } from 'pg';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../frontend/src/data/seed.geojson');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://ourstory:ourstory@localhost:5432/ourstory';

interface EventRow {
  id: string;
  slug: string | null;
  title: string;
  wikipedia_title: string;
  wikipedia_summary: string | null;
  wikipedia_url: string;
  year_start: number;
  year_end: number | null;
  date_is_fuzzy: boolean;
  date_range_min: number | null;
  date_range_max: number | null;
  location_level: 'point' | 'city' | 'country' | 'region';
  lng: number;
  lat: number;
  location_name: string;
  location_slug: string | null;
  categories: string[];
  p31_qids: string[];
  data_version: number;
  pipeline_run: string;
}

interface LocationRow {
  id: string;
  slug: string | null;
  name: string;
  wikipedia_title: string;
  wikipedia_summary: string | null;
  wikipedia_url: string;
  lng: number;
  lat: number;
  founded_year: number | null;
  founded_is_fuzzy: boolean;
  founded_range_min: number | null;
  founded_range_max: number | null;
  dissolved_year: number | null;
  location_type: string;
  p31_qids: string[];
  data_version: number;
  pipeline_run: string;
}

function displayYear(year: number): string {
  if (year === 0) return 'Year 0';
  if (year < 0) return `${Math.abs(year)} BCE`;
  return `${year} CE`;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  // -- Events (join to locations for coordinates and location_slug) --
  const eventsResult = await client.query<EventRow>(`
    SELECT
      e.id,
      e.slug,
      e.title,
      e.wikipedia_title,
      e.wikipedia_summary,
      e.wikipedia_url,
      e.year_start,
      e.year_end,
      e.date_is_fuzzy,
      e.date_range_min,
      e.date_range_max,
      e.location_level,
      CASE WHEN e.location_level = 'point' THEN e.lng ELSE l.lng END AS lng,
      CASE WHEN e.location_level = 'point' THEN e.lat ELSE l.lat END AS lat,
      e.location_name,
      l.slug AS location_slug,
      e.categories,
      e.p31_qids,
      e.data_version,
      e.pipeline_run
    FROM events e
    LEFT JOIN locations l ON e.location_wikidata_qid = l.wikidata_qid
    WHERE (e.location_level = 'point' AND e.lng IS NOT NULL)
       OR (e.location_wikidata_qid IS NOT NULL AND l.wikidata_qid IS NOT NULL)
    ORDER BY e.year_start
  `);

  // -- Locations (cities only for map pins) --
  const locationsResult = await client.query<LocationRow>(`
    SELECT
      id, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
      lng, lat, founded_year, founded_is_fuzzy,
      founded_range_min, founded_range_max, dissolved_year, location_type,
      p31_qids, data_version, pipeline_run
    FROM locations
    ORDER BY founded_year NULLS LAST
  `);

  await client.end();

  const features: object[] = [];

  // Event features
  for (const row of eventsResult.rows) {
    if (row.lng == null || row.lat == null) {
      console.warn(`Skipping event "${row.title}" — no resolvable coordinates`);
      continue;
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Number(row.lng), Number(row.lat)],
      },
      properties: {
        featureType: 'event',
        id: row.id,
        slug: row.slug ?? row.wikipedia_title.replace(/ /g, '_'),
        title: row.title,
        wikipediaTitle: row.wikipedia_title,
        wikipediaSummary: row.wikipedia_summary ?? '',
        wikipediaUrl: row.wikipedia_url,
        yearStart: row.year_start,
        yearEnd: row.year_end,
        dateIsFuzzy: row.date_is_fuzzy,
        dateRangeMin: row.date_range_min,
        dateRangeMax: row.date_range_max,
        locationLevel: row.location_level,
        locationName: row.location_name,
        locationSlug: row.location_slug ?? null,
        categories: row.categories,
        primaryCategory: row.categories[0] ?? 'unknown',
        wikidataClasses: row.p31_qids ?? [],
        yearDisplay: displayYear(row.year_start),
        dataVersion: row.data_version,
        pipelineRun: row.pipeline_run,
      },
    });
  }

  // Location features (cities, regions, and countries — all are first-class entities)
  for (const row of locationsResult.rows) {
    if (row.lng == null || row.lat == null) continue;

    const locType = row.location_type as 'city' | 'region' | 'country';
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Number(row.lng), Number(row.lat)],
      },
      properties: {
        featureType: locType,
        id: row.id,
        slug: row.slug ?? row.wikipedia_title.replace(/ /g, '_'),
        title: row.name,
        wikipediaTitle: row.wikipedia_title,
        wikipediaSummary: row.wikipedia_summary ?? '',
        wikipediaUrl: row.wikipedia_url,
        yearStart: row.founded_year,
        yearEnd: row.dissolved_year,
        dateIsFuzzy: row.founded_is_fuzzy,
        dateRangeMin: row.founded_range_min,
        dateRangeMax: row.founded_range_max,
        locationName: row.name,
        locationSlug: null,
        categories: [locType],
        primaryCategory: locType,
        yearDisplay: row.founded_year != null ? displayYear(row.founded_year) : 'Unknown',
        wikidataClasses: row.p31_qids ?? [],
        ...(locType === 'city' ? { cityImportance: row.wikipedia_summary ? 'major' : 'minor' } : {}),
        dataVersion: row.data_version,
        pipelineRun: row.pipeline_run,
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    features,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2));
  console.log(`Wrote ${features.length} features to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
