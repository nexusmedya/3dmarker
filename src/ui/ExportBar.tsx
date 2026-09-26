/** Mesh statistics and export buttons under the viewer. GLB carries the rig's animation clips. */
import { useState } from 'react';
import { Box3, Vector3 } from 'three';
import type { AnimationClip, Object3D } from 'three';
import type { I18nText } from '../core/types';
import { EXPORT_FORMATS, downloadBlob, exportObject, type ExportFormat } from '../core/export/exporters';
import type { ResultInfo } from '../app/store';
import { modelFileName, errorToText, formatSeconds } from '../app/format';
import { yieldToPaint } from '../app/throttle';
import { getDriver } from '../drivers';
import { useI18n } from './i18n';
import { IconAlert, IconBone, IconCheck, IconDownload, IconInfo } from './icons';

interface Props {
  result: ResultInfo | null;
  getObject: () => Object3D | null;
  stlSizeMm: number;
  onStlSize: (mm: number) => void;
  disabled: boolean;
  /** Clips exported with GLB (rigged models). */
  animations?: AnimationClip[];
  /** Download names get "-rigged". */
  rigged?: boolean;
}

export function MeshStatsLine({ result }: { result: ResultInfo }) {
  const { t, tx, int } = useI18n();
  const { stats } = result;
  const driver = getDriver(result.driverId);
  return (
    <div
      className="stats"
      data-testid="mesh-stats"
      data-triangles={stats.triangles}
      data-vertices={stats.vertices}
      data-watertight={stats.watertight ? 'true' : 'false'}
    >
      <span className="stat">
        <strong className="tabular">{int(stats.vertices)}</strong> {t('vertices')}
      </span>
      <span className="stat">
        <strong className="tabular">{int(stats.triangles)}</strong> {t('triangles')}
      </span>
      <span className={`badge ${stats.watertight ? 'badge-ok' : 'badge-muted'}`} title={t('watertightHint')}>
        {stats.watertight ? <IconCheck size={13} /> : <IconInfo size={13} />} {stats.watertight ? t('watertight') : t('openMesh')}
      </span>
      <span className="stat muted">
        {driver ? tx(driver.name) : result.driverId} · {t('elapsed', { s: formatSeconds(result.elapsedMs) })}
      </span>
    </div>
  );
}

export function ExportBar({ result, getObject, stlSizeMm, onStlSize, disabled, animations, rigged }: Props) {
  const { t, tx } = useI18n();
  const clips = animations?.length ? animations : null;
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  // Kept bilingual and localised at render, so a language switch updates it.
  const [error, setError] = useState<I18nText | null>(null);

  const run = async (format: ExportFormat) => {
    const obj = getObject();
    if (!obj || !result) return;
    setBusy(format);
    setError(null);
    try {
      // STL / PLY (and most of GLB) export synchronously: paint the spinner first.
      await yieldToPaint();
      let scale = 1;
      if (format === 'stl') {
        const size = new Box3().setFromObject(obj).getSize(new Vector3());
        const longest = Math.max(size.x, size.y, size.z);
        if (longest > 0) scale = stlSizeMm / longest;
      }
      const blob = await exportObject(obj, format, format === 'glb' && clips ? { scale, animations: clips } : { scale });
      downloadBlob(blob, modelFileName(result.sourceName, result.driverId, format, rigged ? 'rigged' : undefined));
    } catch (e) {
      console.error(e);
      setError(errorToText(e));
    } finally {
      setBusy(null);
    }
  };

  const off = disabled || !result;
  return (
    <div className="export">
      <div className="export-row">
        <span className="export-label">
          <IconDownload size={16} /> {t('exportTitle')}
        </span>
        <div className="export-buttons">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.format}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void run(f.format)}
              disabled={off || busy !== null}
              data-testid={`export-${f.format}`}
              title={`${f.label} — ${tx(f.description)}`}
              aria-busy={busy === f.format}
            >
              {busy === f.format ? <span className="spinner spinner-sm" aria-hidden="true" /> : null}
              {f.ext.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="stl-size" title={t('stlSizeHint')}>
          <span>{t('stlSize')}</span>
          <input
            className="input input-num"
            type="number"
            min={1}
            max={10000}
            step={1}
            value={stlSizeMm}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) onStlSize(Math.min(10000, v));
            }}
            data-testid="stl-size"
          />
        </label>
      </div>
      {clips && (
        <p className="muted small export-anim" data-testid="export-animations">
          <IconBone size={14} /> {t('exportAnimations', { n: clips.length })}
        </p>
      )}
      {error && (
        <p className="note note-danger small" role="alert">
          <IconAlert size={14} /> {t('exportFailed', { msg: tx(error) })}
        </p>
      )}
    </div>
  );
}
