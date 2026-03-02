import type { Category } from '../types';

export const CATEGORY_COLORS: Record<Category, string> = {
  battle:      '#DB4436',  // red
  war:         '#B71C1C',  // dark red
  politics:    '#9C27B0',  // purple
  founding:    '#0F9D58',  // green
  religion:    '#F4B400',  // amber
  disaster:    '#FF6D00',  // orange
  discovery:   '#00BCD4',  // cyan
  exploration: '#009688',  // teal
  science:     '#3F51B5',  // indigo
  culture:     '#E91E63',  // pink
  city:        '#4285F4',  // blue
  region:      '#00897B',  // dark teal
  country:     '#546E7A',  // blue-grey
  unknown:     '#9E9E9E',  // grey
};

export const CATEGORY_LABELS: Record<Category, string> = {
  battle:      'Battle',
  war:         'War',
  politics:    'Politics',
  founding:    'Founding',
  religion:    'Religion',
  disaster:    'Disaster',
  discovery:   'Discovery',
  exploration: 'Exploration',
  science:     'Science',
  culture:     'Culture',
  city:        'City',
  region:      'Region',
  country:     'Country',
  unknown:     'Other',
};

export const EVENT_CATEGORIES: Category[] = [
  'battle',
  'war',
  'politics',
  'founding',
  'religion',
  'disaster',
  'discovery',
  'exploration',
  'science',
  'culture',
];

export const LOCATION_CATEGORIES: Category[] = [
  'city',
  'region',
  'country',
];

export const ALL_CATEGORIES: Category[] = [
  ...EVENT_CATEGORIES,
  ...LOCATION_CATEGORIES,
];

export function getCategoryColor(category: Category): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.unknown;
}
