/**
 * Before / after view of an AI edit: a split slider (drag anywhere or use the
 * arrow keys on the range input) or the two images side by side.
 */
import { useId, useState, type CSSProperties } from 'react';
import type { I18nText, RGBAImage } from '../../core/types';
import { useI18n } from '../i18n';
import { RGBACanvas } from '../RGBACanvas';
import { IconColumns, IconCompare } from './icons';
import './ai.css';

const TEXT = {
  before: { tr: 'Önce', en: 'Before' },
  after: { tr: 'Sonra', en: 'After' },
  split: { tr: 'Önce / sonra ayırıcı', en: 'Before / after split' },
  slider: { tr: 'Kaydırarak karşılaştır', en: 'Slider' },
  side: { tr: 'Yan yana', en: 'Side by side' },
  mode: { tr: 'Karşılaştırma görünümü', en: 'Comparison view' },
  original: { tr: 'Orijinal görsel', en: 'Original image' },
  result: { tr: 'Yapay zekâ sonucu', en: 'AI result' },
} satisfies Record<string, I18nText>;

interface Props {
  before: RGBAImage | null;
  after: RGBAImage;
  testId?: string;
}

export function Compare({ before, after, testId = 'ai-compare' }: Props) {
  const { tx } = useI18n();
  const id = useId();
  const [mode, setMode] = useState<'slider' | 'side'>('slider');
  const [pos, setPos] = useState(50);
  const aspect = `${after.width} / ${after.height}`;

  if (!before) {
    return (
      <div className="ai-compare checker" style={{ aspectRatio: aspect }} data-testid={testId}>
        <RGBACanvas image={after} className="ai-compare-img" label={tx(TEXT.result)} />
      </div>
    );
  }

  return (
    <div className="ai-compare-wrap" data-testid={testId}>
      <div className="seg ai-compare-mode" role="group" aria-label={tx(TEXT.mode)}>
        <button type="button" className={`seg-btn${mode === 'slider' ? ' is-on' : ''}`} aria-pressed={mode === 'slider'} onClick={() => setMode('slider')}>
          <IconCompare size={13} /> {tx(TEXT.slider)}
        </button>
        <button type="button" className={`seg-btn${mode === 'side' ? ' is-on' : ''}`} aria-pressed={mode === 'side'} onClick={() => setMode('side')}>
          <IconColumns size={13} /> {tx(TEXT.side)}
        </button>
      </div>

      {mode === 'slider' ? (
        <div className="ai-compare checker" style={{ aspectRatio: aspect, '--split': `${pos}%` } as CSSProperties}>
          <RGBACanvas image={before} className="ai-compare-img" label={tx(TEXT.original)} />
          <div className="ai-compare-after">
            <RGBACanvas image={after} className="ai-compare-img" label={tx(TEXT.result)} />
          </div>
          <span className="ai-compare-handle" aria-hidden="true" />
          <span className="ai-compare-tag is-before" aria-hidden="true">
            {tx(TEXT.before)}
          </span>
          <span className="ai-compare-tag is-after" aria-hidden="true">
            {tx(TEXT.after)}
          </span>
          <input
            id={`${id}-split`}
            className="ai-compare-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={pos}
            aria-label={tx(TEXT.split)}
            aria-valuetext={`${tx(TEXT.before)} ${pos}% · ${tx(TEXT.after)} ${100 - pos}%`}
            data-testid={`${testId}-range`}
            onChange={(e) => setPos(Number(e.target.value))}
          />
        </div>
      ) : (
        <div className="ai-compare-side">
          <figure className="ai-compare-fig">
            <div className="ai-compare checker" style={{ aspectRatio: aspect }}>
              <RGBACanvas image={before} className="ai-compare-img" label={tx(TEXT.original)} />
            </div>
            <figcaption>{tx(TEXT.before)}</figcaption>
          </figure>
          <figure className="ai-compare-fig">
            <div className="ai-compare checker" style={{ aspectRatio: aspect }}>
              <RGBACanvas image={after} className="ai-compare-img" label={tx(TEXT.result)} />
            </div>
            <figcaption>{tx(TEXT.after)}</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
