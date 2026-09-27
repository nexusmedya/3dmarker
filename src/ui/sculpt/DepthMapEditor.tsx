/**
 * Modal 2D depth painter for depth results: grayscale / turbo view with an
 * optional image overlay, raise / lower / smooth / flatten / erase brushes
 * (Shift = smooth, Ctrl/Cmd = raise ↔ lower), radius / strength / falloff,
 * undo / redo, wheel zoom around the pointer, Space-drag or middle-drag pan,
 * a before / after toggle, Apply (onApply(newDepth), then onClose) / Cancel.
 * Closing with edits (Esc, X, Cancel) asks first; Esc again keeps editing.
 * The brush maths live in src/sculpt/depthBrush.ts.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DepthMap, I18nText, Mask, RGBAImage } from '../../core/types';
import type { Falloff } from '../../sculpt/types';
import { FALLOFFS } from '../../sculpt/falloff';
import { DEPTH_BRUSH_IDS, DepthEditState, spacedPoints, unionRect, type DepthBrushId, type Rect } from '../../sculpt/depthBrush';
import { imageForSize, renderDepthRegion, type DepthColormap } from '../../sculpt/depthRender';
import { useI18n } from '../i18n';
import { Switch } from '../ParamField';
import { IconLayers, IconX } from '../icons';
import { DepthBrushIcon, IconCompare, IconRedo, IconUndo, IconZoomFit } from './icons';
import { FALLOFF_TEXT } from './SculptPanel';
import './sculpt.css';

export const DEPTH_BRUSH_TEXT: Record<DepthBrushId, { name: I18nText; hint: I18nText }> = {
  raise: { name: { tr: 'Yükselt', en: 'Raise' }, hint: { tr: 'Yakınlaştırır (izleyiciye doğru)', en: 'Brings closer (towards the viewer)' } },
  lower: { name: { tr: 'Alçalt', en: 'Lower' }, hint: { tr: 'Uzaklaştırır', en: 'Pushes further away' } },
  smooth: { name: { tr: 'Yumuşat', en: 'Smooth' }, hint: { tr: 'Gürültüyü ve basamakları yumuşatır', en: 'Smooths noise and steps' } },
  flatten: { name: { tr: 'Düzleştir', en: 'Flatten' }, hint: { tr: 'Fırça altındaki ortalamaya çeker', en: 'Pulls towards the average under the brush' } },
  erase: { name: { tr: 'Geri getir', en: 'Restore' }, hint: { tr: 'Orijinal derinliğe döndürür', en: 'Paints the original depth back' } },
};

const TEXT = {
  title: { tr: 'Derinlik haritası düzenleyici', en: 'Depth map editor' },
  close: { tr: 'Kapat', en: 'Close' },
  brushes: { tr: 'Fırçalar', en: 'Brushes' },
  radius: { tr: 'Yarıçap', en: 'Radius' },
  strength: { tr: 'Güç', en: 'Strength' },
  falloff: { tr: 'Azalma eğrisi', en: 'Falloff' },
  maskOnly: { tr: 'Yalnızca nesnenin içine boya', en: 'Paint inside the subject only' },
  view: { tr: 'Görünüm', en: 'View' },
  gray: { tr: 'Gri', en: 'Gray' },
  turbo: { tr: 'Renkli', en: 'Colour' },
  overlay: { tr: 'Görsel katmanı', en: 'Image overlay' },
  before: { tr: 'Önce / sonra', en: 'Before / after' },
  showingBefore: { tr: 'Önce (orijinal)', en: 'Before (original)' },
  undo: { tr: 'Geri al', en: 'Undo' },
  redo: { tr: 'Yinele', en: 'Redo' },
  fit: { tr: 'Sığdır', en: 'Fit' },
  cancel: { tr: 'İptal', en: 'Cancel' },
  apply: { tr: 'Uygula', en: 'Apply' },
  edits: { tr: '{n} düzenleme', en: '{n} edits' },
  discardAsk: { tr: '{n} düzenleme silinsin mi?', en: 'Discard {n} edits?' },
  keepEditing: { tr: 'Düzenlemeye devam', en: 'Keep editing' },
  discard: { tr: 'Vazgeç ve kapat', en: 'Discard' },
  help: {
    tr: 'Sürükle: boya · Shift: yumuşat · Ctrl/⌘: yükselt ↔ alçalt · [ ]: yarıçap · Tekerlek: yakınlaş · Boşluk + sürükle / orta tuş: kaydır · Ctrl/⌘ + Z: geri al',
    en: 'Drag: paint · Shift: smooth · Ctrl/⌘: raise ↔ lower · [ ]: radius · Wheel: zoom · Space + drag / middle button: pan · Ctrl/⌘ + Z: undo',
  },
  canvas: { tr: 'Derinlik haritası (açık = yakın)', en: 'Depth map (bright = near)' },
} satisfies Record<string, I18nText>;

interface Props {
  open: boolean;
  depth: DepthMap;
  mask: Mask | null;
  image: RGBAImage;
  onApply: (depth: DepthMap) => void;
  onClose: () => void;
}

export function DepthMapEditor(props: Props) {
  if (!props.open) return null;
  const content = <DepthEditorDialog {...props} />;
  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}

interface View {
  zoom: number;
  x: number;
  y: number;
}

interface PaintState {
  pointerId: number;
  last: { x: number; y: number };
  carry: number;
  brush: DepthBrushId;
}

interface PanState {
  pointerId: number;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;

function DepthEditorDialog({ depth, mask, image, onApply, onClose }: Props) {
  const { lang, tx, int } = useI18n();
  const percent = (v: number) => (lang === 'tr' ? `%${int(Math.round(v * 100))}` : `${int(Math.round(v * 100))}%`);
  const id = useId();
  const edit = useMemo(() => new DepthEditState(depth, mask), [depth, mask]);
  const { width: w, height: h } = edit;
  const overlayImage = useMemo(() => imageForSize(image, w, h), [image, w, h]);
  const maxRadius = Math.max(8, Math.round(Math.max(w, h) / 4));

  const [tool, setTool] = useState<DepthBrushId>('raise');
  const [radius, setRadius] = useState(() => Math.max(3, Math.round(Math.min(w, h) * 0.04)));
  const [strength, setStrength] = useState(0.5);
  const [falloff, setFalloff] = useState<Falloff>('smooth');
  const [colormap, setColormap] = useState<DepthColormap>('gray');
  const [overlay, setOverlay] = useState(0.25);
  const [maskOnly, setMaskOnly] = useState(true);
  const [before, setBefore] = useState(false);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  /** Closing with edits asks first (Esc / X / Cancel are easy to hit by accident). */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const bufRef = useRef<{ ctx: CanvasRenderingContext2D; img: ImageData } | null>(null);
  const paintRef = useRef<PaintState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const spaceRef = useRef(false);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const optsRef = useRef({ tool, radius, strength, falloff, before });
  optsRef.current = { tool, radius, strength, falloff, before };

  edit.maskOnly = maskOnly;

  const viewOptions = useMemo(
    () => ({ colormap, image: overlayImage, imageOpacity: overlay, mask: edit.mask }),
    [colormap, overlayImage, overlay, edit],
  );

  /** Repaint `rect` (or everything) of the current / original depth into the canvas. */
  const paint = useCallback(
    (rect?: Rect | null) => {
      const buf = bufRef.current;
      if (!buf) return;
      const src = optsRef.current.before ? edit.original : edit.data;
      const r = rect ?? { x0: 0, y0: 0, x1: w, y1: h };
      renderDepthRegion(buf.img.data, src, w, h, viewOptions, r);
      buf.ctx.putImageData(buf.img, 0, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    },
    [edit, w, h, viewOptions],
  );

  // Canvas buffer (2D context may be missing, e.g. in tests).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    bufRef.current = ctx ? { ctx, img: ctx.createImageData(w, h) } : null;
    return () => {
      bufRef.current = null;
    };
  }, [w, h]);

  useEffect(() => {
    paint();
  }, [paint, before]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(r.width / w, r.height / h) * 0.94));
    setView({ zoom, x: (r.width - w * zoom) / 2, y: (r.height - h * zoom) / 2 });
  }, [w, h]);

  // Focus, fit, body scroll lock; restore focus on close.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    fit();
    return () => {
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [fit]);

  // Wheel zoom around the pointer (native: React's wheel listener is passive).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const v = viewRef.current;
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))));
      const k = zoom / v.zoom;
      setView({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  const toDepth = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  };

  const placeCursor = (clientX?: number, clientY?: number) => {
    const el = cursorRef.current, stage = stageRef.current;
    if (!el || !stage) return;
    if (clientX !== undefined && clientY !== undefined) {
      const r = stage.getBoundingClientRect();
      pointerRef.current = { x: clientX - r.left, y: clientY - r.top };
    }
    const p = pointerRef.current;
    if (!p || optsRef.current.before || panRef.current || spaceRef.current) {
      el.style.display = 'none';
      return;
    }
    const d = 2 * optsRef.current.radius * viewRef.current.zoom;
    el.style.display = 'block';
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.width = el.style.height = `${d}px`;
  };

  useEffect(() => placeCursor(), [radius, view, before]);

  const dabAt = (p: { x: number; y: number }, brush: DepthBrushId): Rect | null => {
    const o = optsRef.current;
    return edit.dab({ x: p.x, y: p.y, radius: o.radius, strength: o.strength, brush, falloff: o.falloff });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (paintRef.current || panRef.current || confirmDiscard) return;
    // The zoom / Fit HUD sits on the stage: its buttons neither paint nor lose their click to pointer capture.
    if (e.target instanceof Element && e.target.closest('.dme-hud, button, input, select')) return;
    const stage = stageRef.current!;
    const pan = e.button === 1 || (e.button === 0 && spaceRef.current);
    if (!pan && (e.button !== 0 || optsRef.current.before)) return;
    e.preventDefault();
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // synthetic event
    }
    if (pan) {
      const v = viewRef.current;
      panRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      placeCursor();
      return;
    }
    let brush: DepthBrushId = e.shiftKey ? 'smooth' : optsRef.current.tool;
    if (e.ctrlKey || e.metaKey) brush = brush === 'raise' ? 'lower' : brush === 'lower' ? 'raise' : brush;
    const p = toDepth(e.clientX, e.clientY);
    edit.beginStroke();
    paintRef.current = { pointerId: e.pointerId, last: p, carry: 0, brush };
    paint(dabAt(p, brush));
    placeCursor(e.clientX, e.clientY);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && e.pointerId === pan.pointerId) {
      setView((v) => ({ ...v, x: pan.vx + e.clientX - pan.sx, y: pan.vy + e.clientY - pan.sy }));
      return;
    }
    placeCursor(e.clientX, e.clientY);
    const st = paintRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    const native = e.nativeEvent;
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    let dirty: Rect | null = null;
    for (const ev of samples.length > 0 ? samples : [native]) {
      const p = toDepth(ev.clientX, ev.clientY);
      const { points, carry } = spacedPoints(st.last, p, Math.max(0.5, optsRef.current.radius * 0.25), st.carry);
      for (const q of points) dirty = unionRect(dirty, dabAt(q, st.brush));
      st.last = p;
      st.carry = carry;
    }
    if (dirty) paint(dirty);
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current && e.pointerId === panRef.current.pointerId) {
      panRef.current = null;
      placeCursor(e.clientX, e.clientY);
      return;
    }
    const st = paintRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    paintRef.current = null;
    if (edit.endStroke()) bump();
  };

  const undo = () => {
    paintRef.current = null;
    const r = edit.undo();
    if (r) {
      paint(r);
      bump();
    }
  };
  const redo = () => {
    paintRef.current = null;
    const r = edit.redo();
    if (r) {
      paint(r);
      bump();
    }
  };

  const apply = () => {
    if (paintRef.current) {
      paintRef.current = null;
      edit.endStroke();
    }
    onApply(edit.toDepthMap());
    onClose();
  };

  // Back from the confirm: its buttons are gone, give the keys back to the dialog.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current && !confirmDiscard) dialogRef.current?.focus();
    asked.current = confirmDiscard;
  }, [confirmDiscard]);

  /** Esc / X / Cancel: close at once when nothing was edited, else ask. */
  const requestClose = () => {
    if (paintRef.current) {
      paintRef.current = null;
      if (edit.endStroke()) bump();
    }
    if (edit.strokes > 0) setConfirmDiscard(true);
    else onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Modal: shortcuts of the page (generate, sculpt) must not see these keys.
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      // A second Esc answers "keep editing": pressing it twice never loses work.
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
      return;
    }
    if (e.key === 'Tab') {
      trapFocus(e, dialogRef.current);
      return;
    }
    if (inField || confirmDiscard) return;
    if (mod && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && (e.key === 'y' || e.key === 'Y' || e.code === 'KeyY')) {
      e.preventDefault();
      redo();
    } else if (mod) {
      return;
    } else if (e.key === ' ' && target.tagName !== 'BUTTON') {
      e.preventDefault();
      spaceRef.current = true;
      placeCursor();
    } else if (e.key === '[' || e.key === '{' || e.code === 'BracketLeft') {
      e.preventDefault();
      if (e.shiftKey) setStrength((s) => Math.max(0, Math.round((s - 0.05) * 100) / 100));
      else setRadius((r) => Math.max(1, Math.round(r / 1.2)));
    } else if (e.key === ']' || e.key === '}' || e.code === 'BracketRight') {
      e.preventDefault();
      if (e.shiftKey) setStrength((s) => Math.min(1, Math.round((s + 0.05) * 100) / 100));
      else setRadius((r) => Math.min(maxRadius, Math.max(r + 1, Math.round(r * 1.2))));
    } else if (/^[1-5]$/.test(e.key)) {
      e.preventDefault();
      setTool(DEPTH_BRUSH_IDS[Number(e.key) - 1]);
    }
  };

  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === ' ') {
      spaceRef.current = false;
      placeCursor();
    }
  };

  const pct = (v: number, lo: number, hi: number) => ({ '--pct': `${((v - lo) / (hi - lo || 1)) * 100}%` }) as CSSProperties;

  return (
    <div className="dme-backdrop">
      <div
        ref={dialogRef}
        className="dme"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        data-testid="depth-editor"
      >
        <header className="dme-head">
          <h2 id={`${id}-title`} className="card-title">
            <IconLayers /> {tx(TEXT.title)}
          </h2>
          <span className="muted small tabular">
            {w} × {h}
          </span>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label={tx(TEXT.close)} title={tx(TEXT.close)} data-testid="depth-close">
            <IconX size={18} />
          </button>
        </header>

        <div className="dme-body">
          <aside className="dme-side">
            <div className="dme-brushes" role="group" aria-label={tx(TEXT.brushes)}>
              {DEPTH_BRUSH_IDS.map((b, i) => (
                <button
                  key={b}
                  type="button"
                  className={`sculpt-brush${tool === b ? ' is-on' : ''}`}
                  aria-pressed={tool === b}
                  title={`${tx(DEPTH_BRUSH_TEXT[b].name)} (${i + 1}) — ${tx(DEPTH_BRUSH_TEXT[b].hint)}`}
                  onClick={() => setTool(b)}
                  data-testid={`depth-brush-${b}`}
                >
                  <kbd aria-hidden="true">{i + 1}</kbd>
                  <DepthBrushIcon brush={b} size={20} />
                  <span>{tx(DEPTH_BRUSH_TEXT[b].name)}</span>
                </button>
              ))}
            </div>

            <div className="field">
              <div className="field-row">
                <label className="field-label" htmlFor={`${id}-radius`}>
                  {tx(TEXT.radius)}
                </label>
                <span className="muted small tabular">{int(radius)} px</span>
              </div>
              <input
                id={`${id}-radius`}
                className="range"
                type="range"
                min={1}
                max={maxRadius}
                step={1}
                value={radius}
                style={pct(radius, 1, maxRadius)}
                onChange={(e) => setRadius(Number(e.target.value))}
                data-testid="depth-radius"
              />
            </div>
            <div className="field">
              <div className="field-row">
                <label className="field-label" htmlFor={`${id}-strength`}>
                  {tx(TEXT.strength)}
                </label>
                <span className="muted small tabular">{percent(strength)}</span>
              </div>
              <input
                id={`${id}-strength`}
                className="range"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={strength}
                style={pct(strength, 0, 1)}
                onChange={(e) => setStrength(Number(e.target.value))}
                data-testid="depth-strength"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-falloff`}>
                {tx(TEXT.falloff)}
              </label>
              <select id={`${id}-falloff`} className="select" value={falloff} onChange={(e) => setFalloff(e.target.value as Falloff)}>
                {FALLOFFS.map((f) => (
                  <option key={f} value={f}>
                    {tx(FALLOFF_TEXT[f])}
                  </option>
                ))}
              </select>
            </div>
            {edit.mask && <Switch checked={maskOnly} onChange={setMaskOnly} label={tx(TEXT.maskOnly)} testId="depth-mask-only" />}

            <div className="field">
              <span className="field-label">{tx(TEXT.view)}</span>
              <div className="seg" role="group" aria-label={tx(TEXT.view)}>
                {(['gray', 'turbo'] as const).map((c) => (
                  <button key={c} type="button" className={`seg-btn${colormap === c ? ' is-on' : ''}`} aria-pressed={colormap === c} onClick={() => setColormap(c)} data-testid={`depth-colormap-${c}`}>
                    {tx(TEXT[c])}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <div className="field-row">
                <label className="field-label" htmlFor={`${id}-overlay`}>
                  {tx(TEXT.overlay)}
                </label>
                <span className="muted small tabular">{percent(overlay)}</span>
              </div>
              <input
                id={`${id}-overlay`}
                className="range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={overlay}
                style={pct(overlay, 0, 1)}
                onChange={(e) => setOverlay(Number(e.target.value))}
                data-testid="depth-overlay"
              />
            </div>

            <div className="sculpt-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={!edit.canUndo} data-testid="depth-undo" title={`${tx(TEXT.undo)} (Ctrl/⌘ + Z)`}>
                <IconUndo size={15} /> {tx(TEXT.undo)}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={redo} disabled={!edit.canRedo} data-testid="depth-redo" title={`${tx(TEXT.redo)} (Ctrl/⌘ + Shift + Z)`}>
                <IconRedo size={15} /> {tx(TEXT.redo)}
              </button>
            </div>
            <button
              type="button"
              className={`btn btn-sm ${before ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={before}
              onClick={() => setBefore((b) => !b)}
              data-testid="depth-before"
            >
              <IconCompare size={15} /> {tx(TEXT.before)}
            </button>
            <p className="field-hint">{tx(TEXT.help)}</p>
          </aside>

          <div
            ref={stageRef}
            className={`dme-stage checker${before ? ' is-before' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onLostPointerCapture={endPointer}
            onPointerLeave={() => {
              pointerRef.current = null;
              placeCursor();
            }}
            onContextMenu={(e) => e.preventDefault()}
            data-testid="depth-stage"
          >
            <canvas
              ref={canvasRef}
              className="dme-canvas"
              role="img"
              aria-label={tx(TEXT.canvas)}
              style={{
                width: w,
                height: h,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                imageRendering: view.zoom >= 2 ? 'pixelated' : 'auto',
              }}
            />
            <div ref={cursorRef} className="dme-cursor" aria-hidden="true" />
            <div className="dme-hud">
              {before && <span className="pill pill-accent">{tx(TEXT.showingBefore)}</span>}
              <span className="pill tabular">{percent(view.zoom)}</span>
              <button type="button" className="icon-btn" onClick={fit} aria-label={tx(TEXT.fit)} title={tx(TEXT.fit)} data-testid="depth-fit">
                <IconZoomFit size={16} />
              </button>
            </div>
          </div>
        </div>

        <footer className="dme-foot">
          <span className="muted small tabular grow" data-testid="depth-edits" data-edits={edit.strokes}>
            {tx(TEXT.edits, { n: int(edit.strokes) })}
          </span>
          {confirmDiscard ? (
            <div className="dme-confirm" role="alertdialog" aria-labelledby={`${id}-discard`} data-testid="depth-discard-confirm">
              <span id={`${id}-discard`} className="dme-confirm-text">
                {tx(TEXT.discardAsk, { n: int(edit.strokes) })}
              </span>
              <button type="button" className="btn btn-secondary" autoFocus onClick={() => setConfirmDiscard(false)} data-testid="depth-keep">
                {tx(TEXT.keepEditing)}
              </button>
              <button type="button" className="btn btn-secondary dme-discard" onClick={onClose} data-testid="depth-discard">
                {tx(TEXT.discard)}
              </button>
            </div>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" onClick={requestClose} data-testid="depth-cancel">
                {tx(TEXT.cancel)}
              </button>
              <button type="button" className="btn btn-primary" onClick={apply} data-testid="depth-apply">
                {tx(TEXT.apply)}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/** Keep Tab / Shift+Tab inside the dialog. */
function trapFocus(e: ReactKeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (items.length === 0) return;
  const first = items[0], last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
