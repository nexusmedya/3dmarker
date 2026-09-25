/** React access to the current language. */
import { createContext, useContext, useMemo } from 'react';
import type { I18nText, Lang } from '../core/types';
import { formatInt, t, tx, type UIKey } from '../app/i18n';

const LangContext = createContext<Lang>('en');

export const LangProvider = LangContext.Provider;

export interface I18n {
  lang: Lang;
  t: (key: UIKey, vars?: Record<string, string | number>) => string;
  tx: (text: I18nText, vars?: Record<string, string | number>) => string;
  int: (n: number) => string;
}

export function useI18n(): I18n {
  const lang = useContext(LangContext);
  return useMemo(
    () => ({
      lang,
      t: (key, vars) => t(key, lang, vars),
      tx: (text, vars) => tx(text, lang, vars),
      int: (n) => formatInt(n, lang),
    }),
    [lang],
  );
}
