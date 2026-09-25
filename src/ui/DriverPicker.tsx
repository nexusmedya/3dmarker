/** Driver <select> grouped by category, plus an info card for the selected driver. */
import type { Availability, Driver } from '../core/types';
import { DRIVERS } from '../drivers';
import { BADGE_HINTS, BADGE_LABELS, CATEGORY_LABELS, groupDrivers } from '../app/driverMeta';
import { useI18n } from './i18n';
import { IconAlert, IconCheck, IconCloud, IconCpu, IconInfo, IconWand } from './icons';

interface Props {
  driver: Driver;
  availability: Availability | 'checking' | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export function CategoryIcon({ category, size = 16 }: { category: Driver['category']; size?: number }) {
  if (category === 'ml') return <IconCpu size={size} />;
  if (category === 'cloud') return <IconCloud size={size} />;
  return <IconWand size={size} />;
}

export function Badges({ driver }: { driver: Driver }) {
  const { t, tx } = useI18n();
  return (
    <ul className="chips" aria-label={t('colBadges')}>
      {driver.badges.map((b) => (
        <li key={b} className={`chip chip-${b}`} title={tx(BADGE_HINTS[b])}>
          {tx(BADGE_LABELS[b])}
        </li>
      ))}
    </ul>
  );
}

export function DriverPicker({ driver, availability, onSelect, disabled }: Props) {
  const { t, tx } = useI18n();
  const groups = groupDrivers(DRIVERS);
  return (
    <section className="card" aria-labelledby="driver-title">
      <div className="card-head">
        <h2 id="driver-title" className="card-title">
          <CategoryIcon category={driver.category} /> {t('driverTitle')}
        </h2>
      </div>
      <label className="visually-hidden" htmlFor="driver-select">
        {t('driverTitle')}
      </label>
      <select
        id="driver-select"
        className="select select-lg"
        data-testid="driver-select"
        value={driver.id}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        aria-describedby="driver-desc"
      >
        {groups.map((g) => (
          <optgroup key={g.category} label={tx(CATEGORY_LABELS[g.category])}>
            {g.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {tx(d.name)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <div className="driver-info" data-testid="driver-info">
        <p id="driver-desc" className="driver-desc">
          {tx(driver.description)}
        </p>
        <Badges driver={driver} />
        <div className="driver-meta">
          {driver.downloadSizeMB ? <span className="muted small">{t('downloadSize', { mb: driver.downloadSizeMB })}</span> : null}
          <AvailabilityLine availability={availability} />
        </div>
      </div>
    </section>
  );
}

function AvailabilityLine({ availability }: { availability: Availability | 'checking' | null }) {
  const { t, tx } = useI18n();
  if (availability === null) return null;
  if (availability === 'checking') {
    return (
      <span className="status status-muted" data-testid="driver-availability">
        <span className="spinner spinner-sm" aria-hidden="true" /> {t('checking')}
      </span>
    );
  }
  if (!availability.ok) {
    return (
      <span className="status status-danger" data-testid="driver-availability" role="status">
        <IconAlert size={14} /> {availability.reason ? tx(availability.reason) : t('unavailable')}
      </span>
    );
  }
  return (
    <span className={`status ${availability.reason ? 'status-warn' : 'status-ok'}`} data-testid="driver-availability" role="status">
      {availability.reason ? <IconInfo size={14} /> : <IconCheck size={14} />} {availability.reason ? tx(availability.reason) : t('ready')}
    </span>
  );
}
