/** Collapsible card with a form generated from a ParamSpec list. */
import type { ReactNode } from 'react';
import type { ParamSpec, ParamValue, ParamValues } from '../core/types';
import { useI18n } from './i18n';
import { ParamField } from './ParamField';

interface Props {
  id: string;
  title: string;
  icon?: ReactNode;
  specs: ParamSpec[];
  values: ParamValues;
  onChange: (key: string, value: ParamValue) => void;
  onReset: () => void;
  note?: ReactNode;
  badge?: ReactNode;
}

export function ParamForm({ id, title, icon, specs, values, onChange, onReset, note, badge }: Props) {
  const { t } = useI18n();
  return (
    <details className="card card-collapsible" open data-testid={`${id}-section`}>
      <summary className="card-head">
        <h2 className="card-title">
          {icon} {title} {badge}
        </h2>
        {specs.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={(e) => {
              e.preventDefault();
              onReset();
            }}
          >
            {t('reset')}
          </button>
        )}
      </summary>
      {note}
      {specs.length === 0 ? (
        <p className="muted small">{t('noParams')}</p>
      ) : (
        <div className="fields">
          {specs.map((s) => (
            <ParamField key={s.key} spec={s} value={values[s.key]} onChange={(v) => onChange(s.key, v)} />
          ))}
        </div>
      )}
    </details>
  );
}
