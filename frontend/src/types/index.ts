export type LocationLevel = 'point' | 'city' | 'country' | 'region';

export type Category =
  | 'battle'
  | 'war'
  | 'politics'
  | 'founding'
  | 'religion'
  | 'disaster'
  | 'discovery'
  | 'exploration'
  | 'science'
  | 'culture'
  | 'city'
  | 'region'
  | 'country'
  | 'unknown';

export interface FeatureProperties {
  featureType: 'event' | 'city' | 'region' | 'country';
  /** UUID primary key from the DB */
  id: string;
  /** Wikipedia article title slug, e.g. 'Battle_of_Thermopylae' — stable public identifier */
  slug: string;
  title: string;
  wikipediaTitle: string;
  wikipediaSummary: string;
  wikipediaUrl: string;
  yearStart: number | null;
  yearEnd: number | null;
  dateIsFuzzy: boolean;
  dateRangeMin: number | null;
  dateRangeMax: number | null;
  locationLevel?: LocationLevel;
  locationName: string;
  /** Slug of the linked location entity (city/region), if any. Used for cross-entity navigation. */
  locationSlug: string | null;
  /** Only present on city features. 'major' cities are always shown; 'minor' only above zoom 7. */
  cityImportance?: 'major' | 'minor';
  categories: Category[];
  primaryCategory: Category;
  /** Wikidata P31 (instance-of) QIDs, e.g. ['Q178561', 'Q188686']. Events only. */
  wikidataClasses?: string[];
  yearDisplay: string;
  dataVersion?: number;
  pipelineRun?: string;
}

export interface TimelineState {
  currentYear: number;
  stepSize: number;
  isPlaying: boolean;
  playbackSpeed: number; // years per second
}

export const YEAR_MIN = -600;
export const YEAR_MAX = 2025;
