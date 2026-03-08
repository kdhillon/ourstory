import { createContext, useContext } from 'react';

export const TranslationContext = createContext<Record<string, string>>({});

/** Returns the translation map (wikidataQid → translated label). */
export function useTranslations() {
  return useContext(TranslationContext);
}
