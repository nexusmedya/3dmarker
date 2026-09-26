/** Sticky top bar: logo, section links, AI providers, language and theme toggles. */
import type { Lang } from '../core/types';
import type { Theme } from '../app/store';
import { useI18n } from './i18n';
import { IconGithub, IconKey, IconMoon, IconSun, LogoMark } from './icons';

interface Props {
  theme: Theme;
  onLang: (lang: Lang) => void;
  onTheme: (theme: Theme) => void;
  /** Enabled AI providers (the badge on the AI providers button). */
  aiCount?: number;
  onAiSettings?: () => void;
}

/** Source-code link in the top bar; hidden unless VITE_REPO_URL is set at build time. */
export const REPO_URL: string | undefined = (import.meta.env.VITE_REPO_URL as string | undefined) || undefined;

export function TopBar({ theme, onLang, onTheme, aiCount = 0, onAiSettings }: Props) {
  const { lang, t } = useI18n();
  const aiTitle = `${t('aiProviders')} · ${t('aiProvidersCount', { n: aiCount })}`;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#studio" aria-label={t('appName')}>
          <LogoMark />
          <span className="brand-name">{t('appName')}</span>
          <span className="pill pill-accent">{t('beta')}</span>
        </a>
        <nav className="topnav" aria-label={t('navLabel')}>
          <a href="#studio">{t('navStudio')}</a>
          <a href="#how">{t('navHow')}</a>
          <a href="#drivers">{t('navDrivers')}</a>
          <a href="#pricing">{t('navPricing')}</a>
          <a href="#faq">{t('navFaq')}</a>
        </nav>
        <div className="topbar-actions">
          {onAiSettings && (
            <button
              type="button"
              className="btn btn-secondary btn-sm topbar-ai"
              onClick={onAiSettings}
              aria-haspopup="dialog"
              aria-label={aiTitle}
              title={aiTitle}
              data-testid="ai-settings-open"
            >
              <IconKey size={15} />
              <span className="topbar-ai-label">{t('aiProviders')}</span>
              <span className={`count-badge${aiCount > 0 ? ' is-on' : ''}`} data-testid="ai-settings-count" aria-hidden="true">
                {aiCount}
              </span>
            </button>
          )}
          <div className="seg" role="group" aria-label="Language / Dil">
            {(['tr', 'en'] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                className={`seg-btn${lang === l ? ' is-on' : ''}`}
                aria-pressed={lang === l}
                onClick={() => onLang(l)}
                data-testid={`lang-${l}`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? t('themeLight') : t('themeDark')}
            title={theme === 'dark' ? t('themeLight') : t('themeDark')}
            data-testid="theme-toggle"
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          {REPO_URL && (
            <a className="icon-btn" href={REPO_URL} target="_blank" rel="noreferrer" aria-label={t('sourceCode')} title={t('sourceCode')}>
              <IconGithub />
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
