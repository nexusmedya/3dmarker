/** One generated form control per ParamSpec kind (number / boolean / select / text). */
import { useId, useState, type CSSProperties } from 'react';
import type { NumberParam, ParamSpec, ParamValue } from '../core/types';
import { useI18n } from './i18n';
import { IconEye, IconEyeOff } from './icons';

interface Props {
  spec: ParamSpec;
  value: ParamValue | undefined;
  onChange: (value: ParamValue) => void;
  disabled?: boolean;
}

export function ParamField({ spec, value, onChange, disabled }: Props) {
  const { tx } = useI18n();
  const id = useId();
  const hintId = spec.hint ? `${id}-hint` : undefined;
  const label = tx(spec.label);
  const hint = spec.hint ? (
    <p id={hintId} className="field-hint">
      {tx(spec.hint)}
    </p>
  ) : null;

  switch (spec.kind) {
    case 'number':
      return (
        <div className="field" data-testid={`param-${spec.key}`}>
          <NumberField spec={spec} id={id} label={label} hintId={hintId} value={typeof value === 'number' ? value : spec.default} onChange={onChange} disabled={disabled} />
          {hint}
        </div>
      );
    case 'boolean':
      return (
        <div className="field" data-testid={`param-${spec.key}`}>
          <Switch id={id} checked={typeof value === 'boolean' ? value : spec.default} onChange={onChange} label={label} describedBy={hintId} disabled={disabled} />
          {hint}
        </div>
      );
    case 'select':
      return (
        <div className="field" data-testid={`param-${spec.key}`}>
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <select
            id={id}
            className="select"
            value={typeof value === 'string' ? value : spec.default}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby={hintId}
            disabled={disabled}
          >
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>
                {tx(o.label)}
              </option>
            ))}
          </select>
          {hint}
        </div>
      );
    case 'text':
      return (
        <div className="field" data-testid={`param-${spec.key}`}>
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          {spec.secret ? (
            <SecretInput id={id} value={typeof value === 'string' ? value : ''} placeholder={spec.placeholder} onChange={onChange} hintId={hintId} disabled={disabled} />
          ) : (
            <input
              id={id}
              className="input"
              type="text"
              value={typeof value === 'string' ? value : ''}
              placeholder={spec.placeholder}
              onChange={(e) => onChange(e.target.value)}
              aria-describedby={hintId}
              disabled={disabled}
            />
          )}
          {hint}
        </div>
      );
  }
}

function decimals(step: number): number {
  const s = String(step);
  return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
}

function NumberField({
  spec,
  id,
  label,
  hintId,
  value,
  onChange,
  disabled,
}: {
  spec: NumberParam;
  id: string;
  label: string;
  hintId?: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  // Local text so typing "0." or clearing the box does not fight the controlled value.
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(spec.max, Math.max(spec.min, v));
  const shown = value.toFixed(decimals(spec.step));
  const commit = (text: string) => {
    const v = Number(text);
    if (text.trim() !== '' && Number.isFinite(v)) onChange(clamp(v));
    setDraft(null);
  };
  const pct = ((value - spec.min) / (spec.max - spec.min || 1)) * 100;
  return (
    <>
      <div className="field-row">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <input
          className="input input-num"
          type="number"
          inputMode="decimal"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={draft ?? shown}
          aria-label={label}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= spec.min && v <= spec.max) onChange(v);
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
      </div>
      <input
        id={id}
        className="range"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        aria-describedby={hintId}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => {
          setDraft(null);
          onChange(Number(e.target.value));
        }}
      />
    </>
  );
}

function SecretInput({
  id,
  value,
  placeholder,
  onChange,
  hintId,
  disabled,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  hintId?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <div className="input-group">
      <input
        id={id}
        className="input"
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hintId}
        disabled={disabled}
      />
      <button type="button" className="icon-btn" onClick={() => setVisible((v) => !v)} aria-label={visible ? t('hide') : t('show')} title={visible ? t('hide') : t('show')}>
        {visible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
      </button>
    </div>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  label,
  describedBy,
  disabled,
  testId,
}: {
  id?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  describedBy?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label className={`switch${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </label>
  );
}
