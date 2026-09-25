/** Compact SaaS landing below the studio: hero, steps, driver table, pricing, FAQ. */
import { DRIVERS } from '../drivers';
import { CATEGORY_SHORT, bestFor, groupDrivers, outputKind } from '../app/driverMeta';
import { FAQ, HERO, HIGHLIGHTS, PLANS, SECTION_TITLES, STEPS } from '../app/content';
import { useI18n } from './i18n';
import { Badges, CategoryIcon } from './DriverPicker';
import { IconCheck, IconCpu, IconCube, IconShield, IconSparkles } from './icons';

const HIGHLIGHT_ICONS = [IconShield, IconCpu, IconCube];

interface Props {
  onTryDriver: (id: string) => void;
}

export function Landing({ onTryDriver }: Props) {
  const { t, tx } = useI18n();
  const drivers = groupDrivers(DRIVERS).flatMap((g) => g.drivers);
  return (
    <div className="landing">
      <section className="hero container" aria-labelledby="hero-title">
        <p className="eyebrow">
          <IconSparkles size={14} /> {tx(HERO.eyebrow)}
        </p>
        <h2 id="hero-title" className="hero-title">
          {tx(HERO.title)}
        </h2>
        <p className="hero-body">{tx(HERO.body)}</p>
        <div className="hero-ctas">
          <a className="btn btn-primary btn-lg" href="#studio">
            {tx(HERO.cta)}
          </a>
          <a className="btn btn-secondary btn-lg" href="#drivers">
            {tx(HERO.secondary)}
          </a>
        </div>
        <ul className="highlights">
          {HIGHLIGHTS.map((h, i) => {
            const Icon = HIGHLIGHT_ICONS[i % HIGHLIGHT_ICONS.length];
            return (
            <li key={i} className="highlight">
              <Icon size={18} />
              <div>
                <strong>{tx(h.title)}</strong>
                <p>{tx(h.body)}</p>
              </div>
            </li>
            );
          })}
        </ul>
      </section>

      <section id="how" className="section container" aria-labelledby="how-title">
        <h2 id="how-title" className="section-title">
          {tx(SECTION_TITLES.how)}
        </h2>
        <p className="section-sub">{tx(SECTION_TITLES.howSub)}</p>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={i} className="step">
              <span className="step-num" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{tx(s.title)}</h3>
              <p>{tx(s.body)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="drivers" className="section container" aria-labelledby="drivers-title">
        <h2 id="drivers-title" className="section-title">
          {tx(SECTION_TITLES.drivers)}
        </h2>
        <p className="section-sub">{tx(SECTION_TITLES.driversSub)}</p>
        <div className="table-wrap">
          <table className="table" data-testid="driver-table">
            <thead>
              <tr>
                <th scope="col">{t('colDriver')}</th>
                <th scope="col">{t('colCategory')}</th>
                <th scope="col">{t('colOutput')}</th>
                <th scope="col">{t('colBadges')}</th>
                <th scope="col">{t('colDownload')}</th>
                <th scope="col">{t('colBestFor')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('tryIt')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{tx(d.name)}</th>
                  <td>
                    <span className="cat">
                      <CategoryIcon category={d.category} size={14} /> {tx(CATEGORY_SHORT[d.category])}
                    </span>
                  </td>
                  <td>{tx(outputKind(d))}</td>
                  <td>
                    <Badges driver={d} />
                  </td>
                  <td className="tabular">{d.downloadSizeMB ? `~${d.downloadSizeMB} MB` : t('none')}</td>
                  <td>{tx(bestFor(d))}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onTryDriver(d.id)}>
                      {t('tryIt')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="pricing" className="section container" aria-labelledby="pricing-title">
        <h2 id="pricing-title" className="section-title">
          {tx(SECTION_TITLES.pricing)}
        </h2>
        <p className="section-sub">{tx(SECTION_TITLES.pricingSub)}</p>
        <div className="plans">
          {PLANS.map((p) => (
            <article key={p.id} className={`plan${p.highlighted ? ' is-highlighted' : ''}`} aria-labelledby={`plan-${p.id}`}>
              <header>
                <h3 id={`plan-${p.id}`}>{tx(p.name)}</h3>
                <p className="plan-price">
                  <strong>{tx(p.price)}</strong> <span className="muted">/ {tx(p.period)}</span>
                </p>
                <p className="muted">{tx(p.blurb)}</p>
              </header>
              <ul className="plan-features">
                {p.features.map((f, i) => (
                  <li key={i}>
                    <IconCheck size={16} /> {tx(f)}
                  </li>
                ))}
              </ul>
              {p.comingSoon ? (
                <button type="button" className="btn btn-secondary btn-block" disabled aria-disabled="true">
                  {tx(p.cta)}
                </button>
              ) : (
                <a className="btn btn-primary btn-block" href="#studio">
                  {tx(p.cta)}
                </a>
              )}
            </article>
          ))}
        </div>
      </section>

      <section id="faq" className="section container" aria-labelledby="faq-title">
        <h2 id="faq-title" className="section-title">
          {tx(SECTION_TITLES.faq)}
        </h2>
        <div className="faq">
          {FAQ.map((f, i) => (
            <details key={i} className="faq-item">
              <summary>{tx(f.q)}</summary>
              <p>{tx(f.a)}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="footer container">
        <p className="muted small">
          © {new Date().getFullYear()} {t('appName')} · {t('footerNote')}
        </p>
      </footer>
    </div>
  );
}
