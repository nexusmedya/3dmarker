/**
 * Sculpt mode card: on / off toggle, the eight brushes, radius / strength /
 * falloff, invert / X symmetry / lock boundary, undo / redo / reset and the
 * shortcut list. Owns the SculptSession of the model on screen (created
 * lazily on the first toggle, re-created when the model object changes).
 * Unmounting the panel (leaving the Edit step) or losing the permission to
 * sculpt only ends sculpt mode: the session, with its undo history and the
 * pre-sculpt mesh for Reset, is kept for the same model. Reports edited mesh
 * stats (computed once per session: sculpting never changes the topology).
 */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import type { Mesh, Object3D } from 'three';
import type { I18nText } from '../../core/types';
import type { ViewerCore } from '../../app/viewer';
import type { BuiltModel } from '../../app/pipeline';
import { computeMeshStats, type MeshStats } from '../../core/mesh/stats';
import { browserStorage, loadJSON, saveJSON } from '../../app/persist';
import { errorToText } from '../../app/format';
import { yieldToPaint } from '../../core/yield';
import { BRUSH_IDS, DEFAULT_BRUSH, type BrushId, type BrushSettings, type Falloff, type SculptState } from '../../sculpt/types';
import { FALLOFFS } from '../../sculpt/falloff';
import { RADIUS_MAX, RADIUS_MIN, sanitizeBrushSettings } from '../../sculpt/settings';
import type { SculptSession } from '../../sculpt/session';
import { useI18n } from '../i18n';
import { Switch } from '../ParamField';
import { IconAlert, IconInfo } from '../icons';
import { BrushIcon, IconKeyboard, IconRedo, IconReset, IconSculpt, IconUndo } from './icons';
import './sculpt.css';

export const BRUSH_TEXT: Record<BrushId, { name: I18nText; hint: I18nText }> = {
  draw: {
    name: { tr: 'Çiz', en: 'Draw' },
    hint: { tr: 'Yüzeyi dışarı iter (Ctrl: içeri oyar)', en: 'Pushes the surface out (Ctrl: carves in)' },
  },
  clay: {
    name: { tr: 'Kil', en: 'Clay' },
    hint: { tr: 'Önce çukurları doldurarak katman ekler', en: 'Builds up layers, filling cavities first' },
  },
  smooth: {
    name: { tr: 'Yumuşat', en: 'Smooth' },
    hint: { tr: 'Pürüzleri giderir (her fırçada Shift ile)', en: 'Evens out bumps (Shift with any brush)' },
  },
  flatten: {
    name: { tr: 'Düzleştir', en: 'Flatten' },
    hint: { tr: 'Fırçanın altındaki ortalama düzleme çeker', en: 'Pulls towards the average plane under the brush' },
  },
  inflate: {
    name: { tr: 'Şişir', en: 'Inflate' },
    hint: { tr: 'Köşe normalleri boyunca şişirir (Ctrl: söndürür)', en: 'Inflates along the vertex normals (Ctrl: deflates)' },
  },
  pinch: {
    name: { tr: 'Sıkıştır', en: 'Pinch' },
    hint: { tr: 'Kenarları keskinleştirmek için merkeze çeker', en: 'Pulls towards the centre to sharpen edges' },
  },
  grab: {
    name: { tr: 'Tut-çek', en: 'Grab' },
    hint: { tr: 'Fırçanın altını imleçle sürükler', en: 'Drags the vertices under the brush with the pointer' },
  },
  crease: {
    name: { tr: 'Kırışık', en: 'Crease' },
    hint: { tr: 'Keskin bir oyuk çizer (Ctrl: sırt)', en: 'Draws a sharp groove (Ctrl: ridge)' },
  },
};

export const FALLOFF_TEXT: Record<Falloff, I18nText> = {
  smooth: { tr: 'Yumuşak', en: 'Smooth' },
  sphere: { tr: 'Küre', en: 'Sphere' },
  linear: { tr: 'Doğrusal', en: 'Linear' },
  sharp: { tr: 'Keskin', en: 'Sharp' },
  constant: { tr: 'Sabit', en: 'Constant' },
};

const TEXT = {
  title: { tr: 'Heykel modu', en: 'Sculpt mode' },
  start: { tr: 'Heykeli başlat', en: 'Start sculpting' },
  stop: { tr: 'Bitir', en: 'Done' },
  intro: {
    tr: 'Modeli Blender tarzı fırçalarla elle şekillendirin: yüz hatlarını derinleştirin, burnu, dudakları ve kulakları belirginleştirin.',
    en: 'Shape the model by hand with Blender-style brushes: deepen facial features, bring out the nose, lips and ears.',
  },
  howTo: {
    tr: 'Modelin üzerinde sürükleyin; boş alanda sürüklemek görünümü döndürür.',
    en: 'Drag on the model to sculpt; dragging in empty space orbits the view.',
  },
  noModel: { tr: 'Heykel için önce bir model oluşturun.', en: 'Generate a model first to sculpt it.' },
  disabled: {
    tr: 'Heykel şu anda kullanılamıyor: model oluşturuluyor ya da modele iskelet eklenmiş (heykel için iskeleti kaldırın).',
    en: 'Sculpting is unavailable right now: a model is being generated, or the model is rigged (remove the rig to sculpt).',
  },
  noMeshes: {
    tr: 'Bu modelde düzenlenebilir mesh yok (iskeletli mesh’ler heykellenemez).',
    en: 'This model has no editable mesh (rigged meshes can’t be sculpted).',
  },
  preparing: { tr: 'Mesh hazırlanıyor…', en: 'Preparing the mesh…' },
  failed: { tr: 'Heykel başlatılamadı: {msg}', en: 'Could not start sculpting: {msg}' },
  brushes: { tr: 'Fırçalar', en: 'Brushes' },
  radius: { tr: 'Yarıçap', en: 'Radius' },
  radiusHint: { tr: 'Model boyutuna göre', en: 'Relative to the model size' },
  strength: { tr: 'Güç', en: 'Strength' },
  falloff: { tr: 'Azalma eğrisi', en: 'Falloff' },
  invert: { tr: 'Ters çevir (Ctrl)', en: 'Invert (Ctrl)' },
  symmetry: { tr: 'X simetrisi (X)', en: 'X symmetry (X)' },
  lockBoundary: { tr: 'Açık kenarları sabitle', en: 'Lock open edges' },
  lockBoundaryHint: {
    tr: 'Açık yüzeylerin (kabartma) siluet kenarı yerinde kalır.',
    en: 'The silhouette rim of open surfaces (relief) stays in place.',
  },
  undo: { tr: 'Geri al', en: 'Undo' },
  redo: { tr: 'Yinele', en: 'Redo' },
  reset: { tr: 'Sıfırla', en: 'Reset' },
  resetHint: { tr: 'Heykelden önceki hâline döndür (geri alınabilir)', en: 'Back to the pre-sculpt mesh (undoable)' },
  strokesOne: { tr: '{n} fırça darbesi', en: '{n} stroke' },
  strokesMany: { tr: '{n} fırça darbesi', en: '{n} strokes' },
  remeshWarn: {
    tr: 'Mesh seçeneklerini değiştirmek yüzeyi yeniden örer ve heykel düzenlemelerini siler.',
    en: 'Changing the mesh options rebuilds the surface and discards sculpt edits.',
  },
  emptyStroke: {
    tr: 'Fırça hiçbir noktaya değmedi: model bu fırça için çok seyrek. Fırçayı büyütün ya da daha yüksek çözünürlükte üretin.',
    en: 'The brush touched no vertices: the mesh is too coarse for this brush. Enlarge the brush or generate at a higher resolution.',
  },
  coarse: {
    tr: 'Mesh bu fırça boyutu için seyrek: noktalar fırçadan daha aralıklı, darbeler etkisiz kalabilir. Fırçayı büyütün ya da daha yüksek çözünürlükte üretin.',
    en: 'The mesh is sparse for this brush size: its points are further apart than the brush, so strokes may do nothing. Enlarge the brush or generate at a higher resolution.',
  },
  refined: {
    tr: 'Mesh heykel için sıklaştırıldı: {from} → {to} üçgen.',
    en: 'The mesh was subdivided for sculpting: {from} → {to} triangles.',
  },
  shortcuts: { tr: 'Kısayollar', en: 'Shortcuts' },
  kBrush: { tr: 'Fırça seç', en: 'Pick a brush' },
  kRadius: { tr: 'Yarıçap küçült / büyüt', en: 'Radius smaller / larger' },
  kStrength: { tr: 'Güç azalt / artır', en: 'Strength lower / higher' },
  kInvert: { tr: 'Ters yönde çalış', en: 'Work inverted' },
  kSmooth: { tr: 'Yumuşat', en: 'Smooth' },
  kSymmetry: { tr: 'Simetriyi aç / kapat', en: 'Toggle symmetry' },
  kUndo: { tr: 'Geri al', en: 'Undo' },
  kRedo: { tr: 'Yinele', en: 'Redo' },
  drag: { tr: 'sürükle', en: 'drag' },
} satisfies Record<string, I18nText>;

const STORE_KEY = 'sculpt-brush';

function loadSettings(): BrushSettings {
  return sanitizeBrushSettings(loadJSON(browserStorage(), STORE_KEY), DEFAULT_BRUSH);
}

/** Summed stats over every mesh of `root` (watertight only if all are). */
export function objectStats(root: Object3D): MeshStats {
  let vertices = 0, triangles = 0, watertight = true, any = false;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const s = computeMeshStats(mesh.geometry);
    vertices += s.vertices;
    triangles += s.triangles;
    watertight &&= s.watertight;
    any = true;
  });
  return { vertices, triangles, watertight: any && watertight };
}

const IDLE: SculptState = { active: false, canUndo: false, canRedo: false, strokes: 0 };

/**
 * The session kept while the panel is unmounted (one at a time): coming back
 * to the Edit step picks up its history. Disposed when another model shows up.
 */
let parked: SculptSession | null = null;

/** Keep `session` for later (deactivated); any other kept session is disposed. */
function parkSession(session: SculptSession): void {
  if (parked && parked !== session) parked.dispose();
  session.setActive(false);
  parked = session.isDisposed ? null : session;
}

/** Dispose the kept session unless it belongs to `target` (and still edits its meshes). */
function dropStaleParked(target: Object3D | null): void {
  if (parked && (parked.root !== target || !parked.attached)) {
    parked.dispose();
    parked = null;
  }
}

/** The kept session for `target` (taken out of the slot), or null. */
function takeParked(target: Object3D | null): SculptSession | null {
  dropStaleParked(target);
  const s = parked;
  parked = null;
  return s;
}

/** Mesh stats per session (and the geometries they were computed for). */
const sessionStats = new WeakMap<SculptSession, { geometries: object[]; stats: MeshStats }>();

/** Stats of the session's model, recomputed only when its geometries were swapped. */
function statsOf(session: SculptSession): MeshStats {
  const geometries = session.geometries();
  const hit = sessionStats.get(session);
  if (hit && hit.geometries.length === geometries.length && hit.geometries.every((g, i) => g === geometries[i])) return hit.stats;
  const stats = objectStats(session.root);
  sessionStats.set(session, { geometries, stats });
  return stats;
}
/** Stats are reported this long after the last edit (one update per burst of undo / redo). */
const STATS_DELAY_MS = 350;

interface Props {
  coreRef: MutableRefObject<ViewerCore | null>;
  model: BuiltModel | null;
  enabled: boolean;
  /** `strokes`: the session's stroke count after the edit (0 once undone / reset back to where it started). */
  onEdited: (stats: MeshStats, strokes?: number) => void;
  onActiveChange: (active: boolean) => void;
  /** A new session was created: its stroke count starts from the geometry as it is now. */
  onSessionStart?: () => void;
}

export function SculptPanel({ coreRef, model, enabled, onEdited, onActiveChange, onSessionStart }: Props) {
  const { lang, tx, int } = useI18n();
  const percent = (v: number) => (lang === 'tr' ? `%${int(Math.round(v * 100))}` : `${int(Math.round(v * 100))}%`);
  const id = useId();
  const [settings, setSettings] = useState<BrushSettings>(loadSettings);
  const [state, setState] = useState<SculptState>(IDLE);
  const [preparing, setPreparing] = useState(false);
  const [noMeshes, setNoMeshes] = useState(false);
  const [error, setError] = useState<I18nText | null>(null);
  /** The last stroke reached no vertex (cleared by the next edit). */
  const [emptyStroke, setEmptyStroke] = useState(false);
  /** Mesh density of the session: median edge and bounding radius (world), refinement at start. */
  const [density, setDensity] = useState<{ median: number; radius: number; refined: { before: number; after: number } | null } | null>(null);

  const sessionRef = useRef<SculptSession | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const cbRef = useRef({ onEdited, onActiveChange, onSessionStart });
  cbRef.current = { onEdited, onActiveChange, onSessionStart };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const object = model?.object ?? null;
  const objectRef = useRef(object);
  objectRef.current = object;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setActiveFlag = useCallback((on: boolean) => {
    if (activeRef.current === on) return;
    activeRef.current = on;
    cbRef.current.onActiveChange(on);
  }, []);

  /** Detach the session from the panel: disposed (`keep` false) or parked for a later mount. */
  const releaseSession = useCallback(
    (keep: boolean) => {
      if (statsTimer.current) clearTimeout(statsTimer.current);
      statsTimer.current = null;
      unsubRef.current?.();
      unsubRef.current = null;
      const s = sessionRef.current;
      sessionRef.current = null;
      if (s) {
        if (keep) parkSession(s);
        else s.dispose();
      }
      if (mountedRef.current) {
        setState(IDLE);
        setEmptyStroke(false);
        setDensity(null);
      }
      setActiveFlag(false);
    },
    [setActiveFlag],
  );

  // A new model ends the session (the edits stay in the geometry); unmounting
  // (leaving the step) keeps it, with its undo history, for this model.
  useEffect(() => {
    setNoMeshes(false);
    setError(null);
    dropStaleParked(object);
    return () => releaseSession(objectRef.current === object);
  }, [object, releaseSession]);

  // Losing the permission to sculpt (a job running, the model rigged) only ends sculpt mode.
  useEffect(() => {
    if (enabled) return;
    sessionRef.current?.setActive(false);
    setActiveFlag(false);
  }, [enabled, setActiveFlag]);

  useEffect(() => {
    saveJSON(browserStorage(), STORE_KEY, settings);
  }, [settings]);

  const scheduleStats = useCallback((session: SculptSession) => {
    if (statsTimer.current) clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => {
      statsTimer.current = null;
      if (sessionRef.current !== session) return;
      cbRef.current.onEdited(statsOf(session), session.state.strokes);
    }, STATS_DELAY_MS);
  }, []);

  /** Make `s` the panel's session and follow its events. */
  const attach = useCallback(
    (s: SculptSession) => {
      sessionRef.current = s;
      if (s.settings !== settingsRef.current) s.setSettings(settingsRef.current);
      setEmptyStroke(false);
      setDensity({ median: s.medianEdgeLength, radius: s.boundingRadius, refined: s.refined });
      unsubRef.current = s.subscribe((e) => {
        if (e.type === 'settings') setSettings(e.settings);
        else if (e.type === 'empty-stroke') setEmptyStroke(true);
        else {
          setState(e.state);
          if (e.type === 'edit') {
            setEmptyStroke(false);
            // Re-meshed (syncGeometry): the density changed.
            setDensity((d) => (d && d.median === s.medianEdgeLength ? d : { median: s.medianEdgeLength, radius: s.boundingRadius, refined: s.refined }));
            scheduleStats(s);
          }
        }
      });
    },
    [scheduleStats],
  );

  const start = useCallback(async () => {
    const core = coreRef.current;
    const target = objectRef.current;
    if (!core || !target || !enabledRef.current) return;
    setError(null);
    const usable = (s: SculptSession | null) => !!s && s.root === target && s.attached && s.host === core;
    if (sessionRef.current && !usable(sessionRef.current)) releaseSession(false);
    let session = sessionRef.current;
    if (!session) {
      const kept = takeParked(target);
      if (kept && usable(kept)) {
        // Re-meshed while away (discard / mesh options): its history no longer
        // applies; synced before attaching so that is not reported as an edit.
        kept.syncGeometry();
        attach(kept);
        session = kept;
      } else kept?.dispose();
    }
    if (!session) {
      setPreparing(true);
      let Session: typeof SculptSession;
      try {
        // Lazy: the session pulls in three-mesh-bvh (kept out of the main chunk).
        [{ SculptSession: Session }] = await Promise.all([import('../../sculpt/session'), yieldToPaint()]); // show "Preparing…" before welding / BVH build
      } catch (e) {
        setPreparing(false);
        console.error(e);
        if (mountedRef.current) setError(errorToText(e));
        return;
      }
      setPreparing(false);
      if (!mountedRef.current || objectRef.current !== target || !enabledRef.current || coreRef.current !== core) return;
      try {
        session = new Session(core, target, { settings: settingsRef.current });
      } catch (e) {
        console.error(e);
        setError(errorToText(e));
        return;
      }
      if (session.meshCount === 0) {
        session.dispose();
        setNoMeshes(true);
        return;
      }
      const stats = statsOf(session); // once, while "Preparing…" shows: strokes never change the topology
      attach(session);
      cbRef.current.onSessionStart?.();
      // A coarse mesh was subdivided: report its new size (not an edit: 0 strokes).
      if (session.refined) cbRef.current.onEdited(stats, 0);
    }
    session.setActive(true);
    setState(session.state);
    setActiveFlag(true);
  }, [attach, coreRef, releaseSession, setActiveFlag]);

  const stop = useCallback(() => {
    sessionRef.current?.setActive(false);
    setActiveFlag(false);
  }, [setActiveFlag]);

  const update = (patch: Partial<BrushSettings>) => {
    const session = sessionRef.current;
    if (session) session.setSettings(patch);
    else setSettings((s) => sanitizeBrushSettings({ ...s, ...patch }, s));
  };

  const active = state.active;
  const blocked: I18nText | null = !model ? TEXT.noModel : !enabled ? TEXT.disabled : noMeshes ? TEXT.noMeshes : null;
  const coarse = !!density && density.median > settings.radius * density.radius;
  const radiusPct = ((settings.radius - RADIUS_MIN) / (RADIUS_MAX - RADIUS_MIN)) * 100;

  return (
    <section className="card sculpt-panel" aria-labelledby={`${id}-title`} data-testid="sculpt-panel" data-active={active ? 'true' : 'false'}>
      <div className="card-head">
        <h2 id={`${id}-title`} className="card-title">
          <IconSculpt /> {tx(TEXT.title)}
        </h2>
        <button
          type="button"
          className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={active}
          onClick={() => (active ? stop() : void start())}
          disabled={!!blocked || preparing}
          data-testid="sculpt-toggle"
          aria-busy={preparing}
        >
          {preparing ? <span className="spinner spinner-sm" aria-hidden="true" /> : null}
          {preparing ? tx(TEXT.preparing) : active ? tx(TEXT.stop) : tx(TEXT.start)}
        </button>
      </div>

      {blocked ? (
        <p className="note small" data-testid="sculpt-blocked">
          <IconInfo size={14} /> {tx(blocked)}
        </p>
      ) : !active ? (
        <p className="note small">
          <IconInfo size={14} /> {tx(TEXT.intro)}
        </p>
      ) : null}

      {error && (
        <p className="note note-danger small" role="alert">
          <IconAlert size={14} /> {tx(TEXT.failed, { msg: tx(error) })}
        </p>
      )}

      {active && (
        <div className="sculpt-body">
          <p className="muted small">{tx(TEXT.howTo)}</p>

          {density?.refined && (
            <p className="note small" data-testid="sculpt-refined">
              <IconInfo size={14} /> {tx(TEXT.refined, { from: int(density.refined.before), to: int(density.refined.after) })}
            </p>
          )}
          {emptyStroke ? (
            <p className="note sculpt-warn small" role="status" data-testid="sculpt-empty-stroke">
              <IconAlert size={14} /> {tx(TEXT.emptyStroke)}
            </p>
          ) : coarse ? (
            <p className="note sculpt-warn small" data-testid="sculpt-coarse">
              <IconAlert size={14} /> {tx(TEXT.coarse)}
            </p>
          ) : null}

          <div className="sculpt-brushes" role="group" aria-label={tx(TEXT.brushes)}>
            {BRUSH_IDS.map((b, i) => (
              <button
                key={b}
                type="button"
                className={`sculpt-brush${settings.brush === b ? ' is-on' : ''}`}
                aria-pressed={settings.brush === b}
                title={`${tx(BRUSH_TEXT[b].name)} (${i + 1}) — ${tx(BRUSH_TEXT[b].hint)}`}
                onClick={() => update({ brush: b })}
                data-testid={`brush-${b}`}
              >
                <kbd aria-hidden="true">{i + 1}</kbd>
                <BrushIcon brush={b} size={20} />
                <span>{tx(BRUSH_TEXT[b].name)}</span>
              </button>
            ))}
          </div>

          <div className="field">
            <div className="field-row">
              <label className="field-label" htmlFor={`${id}-radius`}>
                {tx(TEXT.radius)}
              </label>
              <span className="muted small tabular" title={tx(TEXT.radiusHint)}>
                {percent(settings.radius)}
              </span>
            </div>
            <input
              id={`${id}-radius`}
              className="range"
              type="range"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              step={0.005}
              value={settings.radius}
              style={{ '--pct': `${radiusPct}%` } as CSSProperties}
              onChange={(e) => update({ radius: Number(e.target.value) })}
              data-testid="sculpt-radius"
            />
          </div>

          <div className="field">
            <div className="field-row">
              <label className="field-label" htmlFor={`${id}-strength`}>
                {tx(TEXT.strength)}
              </label>
              <span className="muted small tabular">{percent(settings.strength)}</span>
            </div>
            <input
              id={`${id}-strength`}
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.strength}
              style={{ '--pct': `${settings.strength * 100}%` } as CSSProperties}
              onChange={(e) => update({ strength: Number(e.target.value) })}
              data-testid="sculpt-strength"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={`${id}-falloff`}>
              {tx(TEXT.falloff)}
            </label>
            <select
              id={`${id}-falloff`}
              className="select"
              value={settings.falloff}
              onChange={(e) => update({ falloff: e.target.value as Falloff })}
              data-testid="sculpt-falloff"
            >
              {FALLOFFS.map((f) => (
                <option key={f} value={f}>
                  {tx(FALLOFF_TEXT[f])}
                </option>
              ))}
            </select>
          </div>

          <div className="sculpt-toggles">
            <Switch checked={settings.invert} onChange={(v) => update({ invert: v })} label={tx(TEXT.invert)} testId="sculpt-invert" />
            <Switch checked={settings.symmetryX} onChange={(v) => update({ symmetryX: v })} label={tx(TEXT.symmetry)} testId="sculpt-symmetry" />
            <Switch
              checked={settings.lockBoundary}
              onChange={(v) => update({ lockBoundary: v })}
              label={tx(TEXT.lockBoundary)}
              describedBy={`${id}-lock-hint`}
              testId="sculpt-lock"
            />
            <p id={`${id}-lock-hint`} className="field-hint">
              {tx(TEXT.lockBoundaryHint)}
            </p>
          </div>

          <div className="sculpt-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => sessionRef.current?.undo()}
              disabled={!state.canUndo}
              title={`${tx(TEXT.undo)} (Ctrl/⌘ + Z)`}
              data-testid="sculpt-undo"
            >
              <IconUndo size={15} /> {tx(TEXT.undo)}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => sessionRef.current?.redo()}
              disabled={!state.canRedo}
              title={`${tx(TEXT.redo)} (Ctrl/⌘ + Shift + Z)`}
              data-testid="sculpt-redo"
            >
              <IconRedo size={15} /> {tx(TEXT.redo)}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => sessionRef.current?.reset()}
              disabled={state.strokes === 0}
              title={tx(TEXT.resetHint)}
              data-testid="sculpt-reset"
            >
              <IconReset size={15} /> {tx(TEXT.reset)}
            </button>
            <span className="sculpt-count tabular" data-testid="sculpt-strokes" data-strokes={state.strokes} aria-live="polite">
              {tx(state.strokes === 1 ? TEXT.strokesOne : TEXT.strokesMany, { n: int(state.strokes) })}
            </span>
          </div>

          {model?.remesh && (
            <p className="note small">
              <IconInfo size={14} /> {tx(TEXT.remeshWarn)}
            </p>
          )}

          <details className="sculpt-keys">
            <summary>
              <IconKeyboard size={15} /> {tx(TEXT.shortcuts)}
            </summary>
            <dl>
              <dt><kbd>1</kbd>–<kbd>8</kbd></dt>
              <dd>{tx(TEXT.kBrush)}</dd>
              <dt><kbd>[</kbd> <kbd>]</kbd></dt>
              <dd>{tx(TEXT.kRadius)}</dd>
              <dt><kbd>Shift</kbd> + <kbd>[</kbd> <kbd>]</kbd></dt>
              <dd>{tx(TEXT.kStrength)}</dd>
              <dt><kbd>Ctrl/⌘</kbd> + {tx(TEXT.drag)}</dt>
              <dd>{tx(TEXT.kInvert)}</dd>
              <dt><kbd>Shift</kbd> + {tx(TEXT.drag)}</dt>
              <dd>{tx(TEXT.kSmooth)}</dd>
              <dt><kbd>X</kbd></dt>
              <dd>{tx(TEXT.kSymmetry)}</dd>
              <dt><kbd>Ctrl/⌘</kbd> + <kbd>Z</kbd></dt>
              <dd>{tx(TEXT.kUndo)}</dd>
              <dt><kbd>Ctrl/⌘</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></dt>
              <dd>{tx(TEXT.kRedo)}</dd>
            </dl>
          </details>
        </div>
      )}
    </section>
  );
}
