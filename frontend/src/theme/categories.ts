import type { Category } from '../types';

export const CATEGORY_COLORS: Record<Category, string> = {
  battle:        '#EF5350',  // bright red
  war:           '#7B0000',  // dark maroon
  politics:      '#9C27B0',  // purple
  religion:      '#F4B400',  // amber
  disaster:      '#FF6D00',  // orange
  exploration:   '#009688',  // teal
  science:       '#3F51B5',  // indigo
  culture:       '#2E7D32',  // green
  city:          '#4285F4',  // blue
  region:        '#00897B',  // dark teal
  // Polity subtypes
  empire:        '#8B0000',  // deep crimson
  kingdom:       '#1A237E',  // midnight blue
  principality:  '#4E342E',  // dark brown (sub-sovereign states)
  republic:      '#1B5E20',  // dark green
  confederation: '#4A148C',  // deep purple
  sultanate:     '#BF360C',  // burnt sienna
  papacy:        '#F9A825',  // gold
  colony:        '#5D4037',  // dark brown (colonial / dependent territories)
  people:        '#78909C',  // slate (ethnic groups, tribes, indigenous peoples)
  other:         '#607D8B',  // blue-grey (unclassified polities)
  unknown:       '#9E9E9E',  // grey
};

export const CATEGORY_LABELS: Record<Category, string> = {
  battle:        'Battle',
  war:           'War',
  politics:      'Politics',
  religion:      'Religion',
  disaster:      'Disaster',
  exploration:   'Exploration',
  science:       'Science',
  culture:       'Culture',
  city:          'City',
  region:        'Region',
  // Polity subtypes
  empire:        'Empire',
  kingdom:       'Kingdom',
  principality:  'Principality',
  republic:      'Republic',
  confederation: 'Confederation',
  sultanate:     'Sultanate',
  papacy:        'Papacy',
  colony:        'Colony',
  people:        'Peoples',
  other:         'Other',
  unknown:       'Unknown',
};

export const EVENT_CATEGORIES: Category[] = [
  'battle',
  'war',
  'politics',
  'religion',
  'disaster',
  'exploration',
  'science',
  'culture',
];

export const LOCATION_CATEGORIES: Category[] = [
  'city',
  'region',
];

export const POLITY_CATEGORIES: Category[] = [
  'empire',
  'kingdom',
  'principality',
  'republic',
  'confederation',
  'sultanate',
  'papacy',
  'colony',
  'people',
  'other',
];

export const ALL_CATEGORIES: Category[] = [
  ...EVENT_CATEGORIES,
  ...LOCATION_CATEGORIES,
  ...POLITY_CATEGORIES,
];

export function getCategoryColor(category: Category): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.unknown;
}

