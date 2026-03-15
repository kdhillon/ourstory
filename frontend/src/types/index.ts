export type LocationLevel = 'point' | 'city' | 'country' | 'region';

export type PolityType = 'empire' | 'kingdom' | 'principality' | 'republic' | 'confederation' | 'sultanate' | 'papacy' | 'colony' | 'people' | 'other';

export type Category =
  | 'battle'
  | 'war'
  | 'politics'
  | 'religion'
  | 'disaster'
  | 'exploration'
  | 'science'
  | 'culture'
  | 'sport'
  | 'city'
  | 'region'
  // Polity subtypes
  | 'empire'
  | 'kingdom'
  | 'principality'
  | 'republic'
  | 'confederation'
  | 'sultanate'
  | 'papacy'
  | 'colony'
  | 'people'
  | 'other'
  | 'unknown';

export interface FeatureProperties {
  featureType: 'event' | 'city' | 'region' | 'polity';
  /** UUID primary key from the DB */
  id: string;
  /** Wikipedia article title slug, e.g. 'Battle_of_Thermopylae' — stable public identifier */
  slug: string;
  title: string;
  wikipediaTitle: string;
  wikipediaSummary: string;
  wikipediaUrl: string;
  yearStart: number | null;
  monthStart: number | null;
  dayStart: number | null;
  yearEnd: number | null;
  monthEnd: number | null;
  dayEnd: number | null;
  dateIsFuzzy: boolean;
  dateRangeMin: number | null;
  dateRangeMax: number | null;
  locationLevel?: LocationLevel;
  locationName: string;
  /** Slug of the linked location entity (city/region), if any. Used for cross-entity navigation. */
  locationSlug: string | null;
  /** Wikidata QID of the event's location entity. Used to cross-link to a matching polity. */
  locationWikidataQid?: string | null;
  /** Only present on city features. 'major' cities are always shown; 'minor' only above zoom 7. */
  cityImportance?: 'major' | 'minor';
  categories: Category[];
  primaryCategory: Category;
  /** Wikidata P31 (instance-of) QIDs, e.g. ['Q178561', 'Q188686']. Events only. */
  wikidataClasses?: string[];
  /** Polity subtype — only present on polity features. */
  polityType?: PolityType;
  /** True once polity_territories has polygon data for this polity. */
  hasTerritory?: boolean;
  /** Capital city name — polity features only. */
  capitalName?: string | null;
  /** Capital city Wikidata QID — polity features only. Used to cross-link to location. */
  capitalWikidataQid?: string | null;
  /** Sovereign/suzerain polity name — polity features only. e.g. "Holy Roman Empire" */
  sovereignName?: string | null;
  /** Sovereign polity slug — for navigation if the sovereign is in our dataset. */
  sovereignSlug?: string | null;
  /** Sovereign polity Wikidata QID. */
  sovereignQid?: string | null;
  /** Wikidata QID — location features only. Used for cross-linking from polity capitals. */
  wikidataQid?: string | null;
  /** Wikidata P361 (part-of) QIDs — parent events/conflicts this belongs to.
   *  e.g. Battle of Cannae → ['Q154430'] (Second Punic War) */
  partOf?: string[];
  /** Resolved partOf entries for display (populated at export time). */
  partOfResolved?: Array<{ qid: string; title: string; slug: string | null }>;
  /** Number of Wikipedia language editions covering this event. Higher = more globally significant.
   *  Null until backfill-sitelinks.py has been run. Events only. */
  sitelinksCount?: number | null;
  yearDisplay: string;
  dataVersion?: number;
  pipelineRun?: string;
}

export interface StoryBeat {
  sequence: number;
  chapter_title: string | null;
  event_qid: string | null;
  beat_title: string;
  narrative_text: string;
  date?: string; // only for narrative-only beats (no event_qid)
}

export interface StoryIndexEntry {
  slug: string;
  title: string;
  anchor_qid: string;
  detail_level: string;
  description?: string;
  beat_count: number;
}

export interface Story {
  id: string;
  slug: string;
  anchor_qid: string;
  detail_level: string;
  title: string;
  year_start: number | null;
  beats: StoryBeat[];
  generated_from: string;
  status: 'draft' | 'published';
}

export interface TimelineState {
  currentYear: number;
  stepSize: number;
  isPlaying: boolean;
  playbackSpeed: number; // years per second
}

export const YEAR_MIN = -600;
export const YEAR_MAX = 2025;
