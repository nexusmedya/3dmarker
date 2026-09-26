/**
 * Style grid for the AI preparation: search (both languages, diacritics
 * ignored), category chips and a radio group of swatches with a roving
 * tabindex (arrow keys / Home / End move and select, like native radios).
 * The first entry, "None", keeps the original look.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { I18nText } from '../../core/types';
import type { StyleCategory, StylePreset } from '../../ai/types';
import { STYLES, STYLE_CATEGORIES, getStyle } from '../../ai/styles';
import { useI18n } from '../i18n';
import { IconCheck, IconX } from '../icons';
import { IconBan, IconSearch } from './icons';
import { filterStyles } from './logic';
import './ai.css';

const TEXT = {
  label: { tr: 'Stil', en: 'Style' },
  search: { tr: 'Stil ara…', en: 'Search styles…' },
  searchLabel: { tr: 'Stillerde ara', en: 'Search styles' },
  all: { tr: 'Tümü', en: 'All' },
  categories: { tr: 'Stil kategorileri', en: 'Style categories' },
  none: { tr: 'Yok', en: 'None' },
  noneHint: { tr: 'Orijinal görünümü koru', en: 'Keep the original look' },
  count: { tr: '{n} stil', en: '{n} styles' },
  noMatch: { tr: '“{q}” ile eşleşen stil yok.', en: 'No styles match “{q}”.' },
  noMatchCat: { tr: 'Bu kategoride eşleşen stil yok.', en: 'No matching styles in this category.' },
  clearFilters: { tr: 'Filtreleri temizle', en: 'Clear filters' },
  clearSearch: { tr: 'Aramayı temizle', en: 'Clear search' },
  selected: { tr: 'Seçili: {name}', en: 'Selected: {name}' },
} satisfies Record<string, I18nText>;

interface Props {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

/** Columns of a CSS grid, from its children's positions (1 when unknown, e.g. without layout). */
function gridColumns(grid: HTMLElement | null): number {
  const kids = grid ? (Array.from(grid.children) as HTMLElement[]) : [];
  if (kids.length < 2) return 1;
  const top = kids[0].offsetTop;
  let n = 0;
  while (n < kids.length && kids[n].offsetTop === top) n++;
  return n >= kids.length ? 1 : Math.max(1, n);
}

export function StylePicker({ value, onChange, disabled }: Props) {
  const { tx } = useI18n();
  const id = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<StyleCategory | 'all'>('all');
  const gridRef = useRef<HTMLDivElement>(null);

  const selected = getStyle(value);
  const list = useMemo(() => filterStyles(STYLES, query, category), [query, category]);
  const counts = useMemo(() => {
    const byCat = new Map<StyleCategory | 'all', number>([['all', 0]]);
    for (const s of filterStyles(STYLES, query, 'all')) {
      byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
      byCat.set('all', (byCat.get('all') ?? 0) + 1);
    }
    return byCat;
  }, [query]);
  // Grid entries: "None" first, then the matching styles.
  const items: (StylePreset | null)[] = useMemo(() => [null, ...list], [list]);
  const checkedIndex = items.findIndex((it) => (it?.id ?? null) === (selected?.id ?? null));
  const tabIndexAt = checkedIndex >= 0 ? checkedIndex : 0;

  const choose = (index: number, focus: boolean) => {
    const item = items[index];
    if (item === undefined || disabled) return;
    onChange(item ? item.id : null);
    if (focus) (gridRef.current?.children[index] as HTMLElement | undefined)?.focus();
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const current = Math.max(0, Array.prototype.indexOf.call(gridRef.current?.children ?? [], document.activeElement));
    const cols = gridColumns(gridRef.current);
    const last = items.length - 1;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
        next = current >= last ? 0 : current + 1;
        break;
      case 'ArrowLeft':
        next = current <= 0 ? last : current - 1;
        break;
      case 'ArrowDown':
        next = Math.min(last, current + cols);
        break;
      case 'ArrowUp':
        next = Math.max(0, current - cols);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case ' ':
      case 'Enter':
        next = current;
        break;
    }
    if (next === null) return;
    e.preventDefault();
    choose(next, true);
  };

  const filtered = query.trim() !== '' || category !== 'all';

  return (
    <div className={`ai-styles${disabled ? ' is-disabled' : ''}`} data-testid="style-picker">
      <div className="ai-styles-head">
        <span id={`${id}-label`} className="field-label">
          {tx(TEXT.label)}
        </span>
        <span className="muted small truncate" aria-live="polite">
          {selected ? tx(TEXT.selected, { name: tx(selected.name) }) : tx(TEXT.noneHint)}
        </span>
      </div>

      <div className="ai-search">
        <IconSearch size={15} />
        <input
          type="search"
          className="input"
          value={query}
          placeholder={tx(TEXT.search)}
          aria-label={tx(TEXT.searchLabel)}
          disabled={disabled}
          data-testid="style-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery('');
            }
          }}
        />
        {query && (
          <button type="button" className="icon-btn ai-search-clear" onClick={() => setQuery('')} aria-label={tx(TEXT.clearSearch)} title={tx(TEXT.clearSearch)} disabled={disabled}>
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="ai-cats" role="group" aria-label={tx(TEXT.categories)}>
        {[{ id: 'all' as const, name: TEXT.all }, ...STYLE_CATEGORIES].map((c) => (
          <button
            key={c.id}
            type="button"
            className={`ai-cat${category === c.id ? ' is-on' : ''}`}
            aria-pressed={category === c.id}
            disabled={disabled}
            data-testid={`style-cat-${c.id}`}
            onClick={() => setCategory(c.id)}
          >
            {tx(c.name)}
            <span className="ai-cat-count tabular">{counts.get(c.id) ?? 0}</span>
          </button>
        ))}
      </div>

      <div
        ref={gridRef}
        className="ai-style-grid"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-disabled={disabled || undefined}
        onKeyDown={onGridKey}
      >
        {items.map((s, i) => {
          const checked = i === checkedIndex;
          const name = s ? tx(s.name) : tx(TEXT.none);
          return (
            <div
              key={s?.id ?? 'none'}
              role="radio"
              aria-checked={checked}
              aria-disabled={disabled || undefined}
              tabIndex={disabled ? -1 : i === tabIndexAt ? 0 : -1}
              className={`ai-style${checked ? ' is-on' : ''}${s ? '' : ' is-none'}`}
              title={s ? `${name} · ${tx(STYLE_CATEGORIES.find((c) => c.id === s.category)?.name ?? TEXT.label)}` : tx(TEXT.noneHint)}
              data-testid={`style-${s?.id ?? 'none'}`}
              onClick={() => choose(i, false)}
            >
              <span className="ai-style-swatch" style={s ? { background: s.swatch } : undefined}>
                {!s && <IconBan size={20} />}
                {checked && (
                  <span className="ai-style-check">
                    <IconCheck size={12} />
                  </span>
                )}
              </span>
              <span className="ai-style-name">{name}</span>
            </div>
          );
        })}
      </div>

      <div className="ai-styles-foot small">
        <span className="muted tabular">{tx(TEXT.count, { n: list.length })}</span>
        {filtered && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            onClick={() => {
              setQuery('');
              setCategory('all');
            }}
          >
            {tx(TEXT.clearFilters)}
          </button>
        )}
      </div>
      {list.length === 0 && (
        <p className="muted small" role="status">
          {query.trim() ? tx(TEXT.noMatch, { q: query.trim() }) : tx(TEXT.noMatchCat)}
        </p>
      )}
    </div>
  );
}
