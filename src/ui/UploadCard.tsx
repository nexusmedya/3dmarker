/** Upload: drag & drop / file picker / samples, and the image preview with its mask overlay. */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Mask } from '../core/types';
import type { SourceImage } from '../app/pipeline';
import { SAMPLES, type SampleSpec } from '../app/samples';
import { coveragePercent, maskOverlay } from '../app/overlay';
import { getDriver } from '../drivers';
import { useI18n } from './i18n';
import { RGBACanvas } from './RGBACanvas';
import { Switch } from './ParamField';
import { IconImage, IconUpload, IconX } from './icons';

interface Props {
  source: SourceImage | null;
  loading: boolean;
  mask: Mask | null;
  showMask: boolean;
  onShowMask: (show: boolean) => void;
  onFile: (file: File) => void;
  onSample: (spec: SampleSpec) => void;
  onClear: () => void;
}

export function UploadCard({ source, loading, mask, showMask, onShowMask, onFile, onSample, onClear }: Props) {
  const { t, tx } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const overlay = useMemo(() => (mask ? maskOverlay(mask) : null), [mask]);
  const coverage = useMemo(() => (mask ? coveragePercent(mask) : null), [mask]);

  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/')) ?? e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  const dragProps = { onDragOver, onDragLeave: () => setDragging(false), onDrop };

  const input = (
    <input
      ref={inputRef}
      id="file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/*"
      className="visually-hidden"
      data-testid="file-input"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onFile(file);
        e.target.value = '';
      }}
    />
  );

  return (
    <section className="card" aria-labelledby="image-title">
      <div className="card-head">
        <h2 id="image-title" className="card-title">
          <IconImage /> {t('imageTitle')}
        </h2>
        {source && (
          <div className="card-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => inputRef.current?.click()}>
              {t('changeImage')}
            </button>
            <button type="button" className="icon-btn" onClick={onClear} aria-label={t('removeImage')} title={t('removeImage')}>
              <IconX size={16} />
            </button>
          </div>
        )}
      </div>

      {source ? (
        <>
          {input}
          <div className={`preview checker${dragging ? ' is-dragging' : ''}`} {...dragProps}>
            <span className="preview-frame">
              <RGBACanvas image={source.image} className="preview-img" label={t('previewAlt')} />
              {showMask && overlay && <RGBACanvas image={overlay} className="preview-overlay" />}
            </span>
            {loading && <div className="preview-busy">{t('readingImage')}</div>}
            {dragging && <div className="preview-busy">{t('dropActive')}</div>}
          </div>
          <div className="preview-meta">
            <span className="truncate" title={source.name}>
              {source.name}
            </span>
            <span className="muted">
              {t('imageInfo', { w: source.image.width, h: source.image.height })}
              {coverage !== null && <> · {t('foreground', { pct: coverage })}</>}
            </span>
          </div>
          <Switch
            id="show-mask"
            checked={showMask && !!mask}
            disabled={!mask}
            onChange={onShowMask}
            label={t('showMask')}
            testId="mask-toggle"
          />
        </>
      ) : (
        <label className={`dropzone${dragging ? ' is-dragging' : ''}`} {...dragProps}>
          {input}
          <span className="dropzone-icon">
            <IconUpload size={22} />
          </span>
          <span className="dropzone-title">{loading ? t('readingImage') : dragging ? t('dropActive') : t('dropTitle')}</span>
          <span className="dropzone-body">{t('dropBody')}</span>
          <span className="dropzone-formats">{t('dropFormats')}</span>
        </label>
      )}

      <div className="samples">
        <span className="samples-label">{t('trySample')}</span>
        <div className="samples-row">
          {SAMPLES.map((s, i) => {
            const d = getDriver(s.driverId);
            return (
              <button
                key={s.id}
                type="button"
                className="sample"
                data-testid={`sample-${i}`}
                onClick={() => onSample(s)}
                title={d ? t('sampleWorksWith', { driver: tx(d.name) }) : undefined}
                disabled={loading}
              >
                <SampleThumb spec={s} />
                <span>{tx(s.name)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SampleThumb({ spec }: { spec: SampleSpec }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(64 * dpr);
    const h = Math.round((64 * dpr * spec.height) / spec.width);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) spec.draw(ctx, w, h);
  }, [spec]);
  return <canvas ref={ref} className="sample-thumb checker" aria-hidden="true" />;
}
