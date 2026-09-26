/**
 * Rig & animation card: auto-rig the model on screen as a humanoid (pose
 * landmarks from src/core/human when a person is detected in the front
 * image, else the silhouette heuristic), edit joints in the viewer, play the
 * built-in library or imported clips (BVH / FBX / GLB) and choose which
 * clips go into the GLB export (`model.animations`).
 *
 * The rig engine (src/rig, three-mesh-bvh, loaders) is loaded on first use.
 * The rig edits `model.object` in place and calls `onModelChanged` whenever
 * the model's meshes or `animations` change; `onActiveChange(true)` while the
 * model is rigged (the shell disables sculpting / re-meshing then). Switching
 * to another model or unmounting removes the rig again.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { SkinnedMesh } from 'three';
import type { ViewerCore } from '../../app/viewer';
import type { BuiltModel } from '../../app/pipeline';
import { errorToText } from '../../app/format';
import type { I18nText, Mask, Progress, RGBAImage } from '../../core/types';
import type { HandResult, PoseResult } from '../../core/human/types';
import { analyzeHuman } from '../../core/human/analyze';
import { boneLabel, mirrorBone } from '../../rig/bones';
import type * as RigEngine from '../../rig/engine';
import { ANIMATION_CATEGORIES, type AnimationCategory, type HumanoidBone, type JointLayout, type RigClip } from '../../rig/types';
import { useI18n } from '../i18n';
import { ProgressBar } from '../GeneratePanel';
import { IconAlert, IconCheck, IconInfo, IconX } from '../icons';
import { IconBone, IconImport, IconLoop, IconMove, IconPause, IconPlay, IconSearch, IconStop } from './icons';
import './rig.css';

type Engine = typeof RigEngine;
type JointMethod = RigEngine.JointMethod;

export const RIG_PANEL_TEXT = {
  title: { tr: 'Kemik ve animasyon', en: 'Rig & animation' },
  intro: {
    tr: 'Modele insansı bir iskelet ekler, deri ağırlıklarını hesaplar ve hazır animasyonları oynatır. En iyi sonuç T-pozundaki tam vücut modellerle alınır.',
    en: 'Adds a humanoid skeleton, computes skin weights and plays ready-made animations. Works best on full-body models in a T-pose.',
  },
  autoRig: { tr: 'Otomatik kemik (insansı)', en: 'Auto-rig (humanoid)' },
  cancel: { tr: 'İptal', en: 'Cancel' },
  noModel: { tr: 'Önce bir 3B model oluşturun.', en: 'Generate a 3D model first.' },
  disabled: { tr: 'İşlem sürerken kemik eklenemez.', en: 'Rigging is unavailable while a job is running.' },
  loading: { tr: 'Kemik modülü yükleniyor…', en: 'Loading the rigging module…' },
  detecting: { tr: 'Vücut noktaları algılanıyor…', en: 'Detecting body landmarks…' },
  placing: { tr: 'Eklemler yerleştiriliyor…', en: 'Placing the joints…' },
  foreign: {
    tr: 'Bu model kendi iskeletiyle geldi (kemikli GLB); yeniden kemiklendirilemez.',
    en: 'This model came with its own skeleton (skinned GLB); it cannot be rigged again.',
  },
  embedded: { tr: 'Modeldeki animasyonlar', en: 'Animations in the model' },
  noEmbedded: { tr: 'Modelde animasyon yok.', en: 'The model has no animations.' },
  bones: { tr: '{n} kemik', en: '{n} bones' },
  weighted: { tr: '{n} köşe ağırlıklandı', en: '{n} vertices weighted' },
  methodPose: { tr: 'vücut noktalarından', en: 'from body landmarks' },
  methodSilhouette: { tr: 'T-pozu silüetinden', en: 'from the T-pose silhouette' },
  methodArmsDown: { tr: 'kollar aşağıda silüetinden — eklemleri kontrol edin', en: 'from the arms-down silhouette — check the joints' },
  methodProportional: { tr: 'oranlardan (insan algılanmadı) — eklemleri düzenleyin', en: 'from proportions (no person detected) — adjust the joints' },
  showSkeleton: { tr: 'İskeleti göster', en: 'Show skeleton' },
  editJoints: { tr: 'Eklemleri düzenle', en: 'Edit joints' },
  mirror: { tr: 'Simetrik', en: 'Mirror' },
  editHint: {
    tr: 'Görüntüleyicide bir eklemi sürükleyin ya da seçip adım adım kaydırın; bırakınca ağırlıklar yeniden hesaplanır.',
    en: 'Drag a joint in the viewer, or select one and nudge it; weights are recomputed on release.',
  },
  selectedJoint: { tr: 'Seçili: {name}', en: 'Selected: {name}' },
  noJoint: { tr: 'Eklem seçilmedi', en: 'No joint selected' },
  reweighting: { tr: 'Ağırlıklar yeniden hesaplanıyor…', en: 'Recomputing the weights…' },
  removeRig: { tr: 'Kemikleri kaldır', en: 'Remove rig' },
  animations: { tr: 'Animasyonlar', en: 'Animations' },
  search: { tr: 'Animasyon ara', en: 'Search animations' },
  all: { tr: 'Tümü', en: 'All' },
  imported: { tr: 'İçe aktarılan', en: 'Imported' },
  play: { tr: 'Oynat', en: 'Play' },
  pause: { tr: 'Duraklat', en: 'Pause' },
  stop: { tr: 'Durdur (T-pozu)', en: 'Stop (T-pose)' },
  time: { tr: 'Zaman', en: 'Time' },
  speed: { tr: 'Hız', en: 'Speed' },
  loop: { tr: 'Döngü', en: 'Loop' },
  crossFade: { tr: 'Yumuşak geçiş', en: 'Cross-fade' },
  nothingPlaying: { tr: 'Oynatmak için bir animasyon seçin.', en: 'Pick an animation to play.' },
  noMatch: { tr: 'Eşleşen animasyon yok.', en: 'No matching animation.' },
  includeInExport: { tr: 'GLB dışa aktarımına ekle', en: 'Include in the GLB export' },
  exportCount: { tr: 'GLB’ye {n} animasyon eklenecek', en: '{n} animations go into the GLB' },
  selectAll: { tr: 'Tümü', en: 'All' },
  selectNone: { tr: 'Hiçbiri', en: 'None' },
  import: { tr: 'Animasyon içe aktar (BVH / FBX / GLB)', en: 'Import animation (BVH / FBX / GLB)' },
  importing: { tr: 'Animasyon içe aktarılıyor…', en: 'Importing the animation…' },
  importHint: {
    tr: 'Mixamo FBX (“Without Skin”), BVH hareket yakalama ya da animasyonlu GLB; kemik adları otomatik eşlenir.',
    en: 'Mixamo FBX (“Without Skin”), BVH motion capture or an animated GLB; bone names are matched automatically.',
  },
  loopClip: { tr: 'Döngüsel', en: 'Loops' },
  seconds: { tr: '{s} sn', en: '{s} s' },
} satisfies Record<string, I18nText>;

const T = RIG_PANEL_TEXT;

interface Props {
  coreRef: MutableRefObject<ViewerCore | null>;
  model: BuiltModel | null;
  frontImage: RGBAImage | null;
  frontMask: Mask | null;
  enabled: boolean;
  onModelChanged: () => void;
  onActiveChange: (rigged: boolean) => void;
}

interface ImportedEntry {
  id: string;
  source: RigEngine.AnimationSource;
  rig: RigClip;
}

interface RigInfo {
  bones: number;
  vertices: number;
  method: JointMethod;
}

/** Skinned meshes that did not come from our rig (a rigged GLB). */
export function hasForeignSkin(model: BuiltModel | null): boolean {
  let found = false;
  model?.object.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh && !(o.userData as { rigOwned?: boolean }).rigOwned) found = true;
  });
  return found;
}

const isAbort = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
const fmt = (t: number) => t.toFixed(2);

export function RigPanel({ coreRef, model, frontImage, frontMask, enabled, onModelChanged, onActiveChange }: Props) {
  const { tx, int } = useI18n();
  const engineRef = useRef<Engine | null>(null);
  const handleRef = useRef<RigEngine.RigHandle | null>(null);
  const playerRef = useRef<RigEngine.AnimationPlayer | null>(null);
  const editorRef = useRef<RigEngine.JointEditor | null>(null);
  const jobRef = useRef<AbortController | null>(null);
  /** The in-flight joint-edit re-weight (a newer edit aborts it). */
  const reweighRef = useRef<AbortController | null>(null);
  /** The model's own clips (e.g. a GLB's node animations) saved while rigged, restored on unrig. */
  const originalAnimsRef = useRef<{ model: BuiltModel; animations: BuiltModel['animations'] } | null>(null);
  // Nudges accumulate and commit after a short pause (each commit re-weights).
  const pending = useRef<{ patch: JointLayout; timer: ReturnType<typeof setTimeout> | null }>({ patch: {}, timer: null });
  const modelRef = useRef(model);
  modelRef.current = model;
  const cbRef = useRef({ onModelChanged, onActiveChange });
  cbRef.current = { onModelChanged, onActiveChange };

  const [phase, setPhase] = useState<'idle' | 'working' | 'rigged'>('idle');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<I18nText | null>(null);
  const [info, setInfo] = useState<RigInfo | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mirror, setMirror] = useState(true);
  const [selected, setSelected] = useState<HumanoidBone | null>(null);
  const [reweighting, setReweighting] = useState<Progress | null>(null);
  const [builtins, setBuiltins] = useState<RigClip[]>([]);
  const [imported, setImported] = useState<ImportedEntry[]>([]);
  const [exportSel, setExportSel] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<AnimationCategory | 'all' | 'imported'>('all');
  const [current, setCurrent] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [crossFade, setCrossFade] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<I18nText | null>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const showSkeletonRef = useRef(showSkeleton);
  showSkeletonRef.current = showSkeleton;

  const foreign = useMemo(() => hasForeignSkin(model), [model]);
  const allClips = useMemo(() => [...builtins, ...imported.map((e) => e.rig)], [builtins, imported]);
  const byId = useMemo(() => new Map(allClips.map((c) => [c.info.id, c])), [allClips]);

  const loadEngine = useCallback(async () => (engineRef.current ??= await import('../../rig/engine')), []);

  // ---- player ------------------------------------------------------------

  const lastTimeUpdate = useRef(0);
  const makePlayer = (engine: Engine, core: ViewerCore, m: BuiltModel) => {
    const player = new engine.AnimationPlayer(core, m.object);
    player.onTime = (t) => {
      const now = performance.now();
      if (now - lastTimeUpdate.current < 80 && player.isPlaying) return;
      lastTimeUpdate.current = now;
      setTime(t);
    };
    player.onFinished = () => setPlaying(false);
    return player;
  };

  const stopPlayback = () => {
    playerRef.current?.stop();
    setPlaying(false);
    setCurrent(null);
    setTime(0);
  };

  // ---- teardown on model change / unmount ----------------------------------

  const teardown = useCallback(() => {
    jobRef.current?.abort();
    jobRef.current = null;
    reweighRef.current?.abort();
    reweighRef.current = null;
    if (pending.current.timer) clearTimeout(pending.current.timer);
    pending.current = { patch: {}, timer: null };
    editorRef.current?.dispose();
    editorRef.current = null;
    playerRef.current?.dispose();
    playerRef.current = null;
    const h = handleRef.current;
    handleRef.current = null;
    if (h) {
      const core = coreRef.current;
      // Still on screen (model switch before the viewer swaps, or the panel unmounting): restore the meshes.
      if (core && core.getObject() === h.root) h.unrig();
      else h.dispose();
      cbRef.current.onActiveChange(false);
    }
  }, [coreRef]);

  /** Give `m` back the clips it had before rigging (undefined when it had none). */
  const restoreAnimations = useCallback((m: BuiltModel) => {
    const saved = originalAnimsRef.current;
    originalAnimsRef.current = null;
    m.animations = saved && saved.model === m ? saved.animations : undefined;
  }, []);

  useEffect(() => {
    return () => {
      const m = model;
      const wasRigged = !!handleRef.current;
      teardown();
      if (m && wasRigged) restoreAnimations(m);
      setPhase('idle');
      setInfo(null);
      setBuiltins([]);
      setImported([]);
      setExportSel(new Set());
      setEditing(false);
      setSelected(null);
      setCurrent(null);
      setPlaying(false);
      setTime(0);
      setError(null);
      setImportError(null);
      setProgress(null);
      setReweighting(null);
    };
  }, [model, teardown, restoreAnimations]);

  // ---- export selection → model.animations ------------------------------------

  useEffect(() => {
    if (phase !== 'rigged' || !model || !handleRef.current) return;
    // The model's own clips (non-skinned GLB node animations) stay in the export next to the selection.
    const own = originalAnimsRef.current?.model === model ? originalAnimsRef.current.animations ?? [] : [];
    model.animations = [...own, ...allClips.filter((c) => exportSel.has(c.info.id)).map((c) => c.clip)];
    cbRef.current.onModelChanged();
  }, [phase, model, allClips, exportSel]);

  // ---- auto-rig ---------------------------------------------------------------

  const autoRig = async () => {
    const core = coreRef.current;
    const m = model;
    if (!core || !m || phase === 'working') return;
    const ac = new AbortController();
    jobRef.current = ac;
    setPhase('working');
    setError(null);
    setProgress({ label: T.loading });
    try {
      const engine = await loadEngine();
      let pose: PoseResult | null = null;
      let hands: HandResult[] = [];
      if (frontImage) {
        setProgress({ label: T.detecting });
        try {
          const a = await analyzeHuman(frontImage, { signal: ac.signal, onProgress: setProgress, detect: { pose: true, hands: true, faces: false } });
          // The main subject: the largest detected body.
          pose = a.poses.reduce<PoseResult | null>((best, p) => (!best || p.box.width * p.box.height > best.box.width * best.box.height ? p : best), null);
          hands = a.hands;
        } catch (e) {
          if (isAbort(e)) throw e;
          console.warn('[rig] human analysis unavailable, using the silhouette', e);
        }
      }
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      setProgress({ label: T.placing });
      const data = engine.collectMeshData(m.object);
      const auto = engine.autoPlaceJointsDetailed(m.object, {
        pose,
        hands,
        imageSize: frontImage ? { width: frontImage.width, height: frontImage.height } : undefined,
        imageMask: frontMask,
        meshData: data,
      });
      const handle = await engine.rigModel(core, m, { layout: auto.layout, meshData: data, signal: ac.signal, onProgress: setProgress });
      if (modelRef.current !== m || ac.signal.aborted) {
        if (core.getObject() === handle.root) handle.unrig();
        else handle.dispose();
        if (modelRef.current === m) setPhase('idle');
        return;
      }
      handleRef.current = handle;
      if (originalAnimsRef.current?.model !== m) originalAnimsRef.current = { model: m, animations: m.animations };
      playerRef.current = makePlayer(engine, core, m);
      const lib = engine.buildLibrary(handle.descriptor);
      setBuiltins(lib);
      setImported([]);
      setExportSel(new Set(lib.map((c) => c.info.id)));
      setInfo({ bones: handle.bones.size, vertices: data.positions.length / 3, method: auto.method });
      handle.setSkeletonVisible(showSkeletonRef.current);
      setPhase('rigged');
      cbRef.current.onActiveChange(true);
    } catch (e) {
      if (!isAbort(e)) {
        console.error(e);
        setError(errorToText(e));
      }
      if (!handleRef.current) setPhase('idle');
    } finally {
      if (jobRef.current === ac) jobRef.current = null;
      setProgress(null);
    }
  };

  const cancel = () => jobRef.current?.abort();

  const removeRig = () => {
    const m = model;
    const wasRigged = !!handleRef.current;
    teardown();
    if (m && wasRigged) restoreAnimations(m);
    setPhase('idle');
    setInfo(null);
    setBuiltins([]);
    setImported([]);
    setExportSel(new Set());
    setEditing(false);
    setCurrent(null);
    setPlaying(false);
    setTime(0);
    cbRef.current.onModelChanged();
  };

  // ---- skeleton / joint editor ---------------------------------------------

  useEffect(() => {
    handleRef.current?.setSkeletonVisible(showSkeleton || editing);
  }, [showSkeleton, editing, phase]);

  const rebuildClips = (engine: Engine, desc: RigEngine.RigDescriptor) => {
    const player = playerRef.current;
    for (const c of allClips) player?.uncache(c.clip);
    setBuiltins(engine.buildLibrary(desc));
    setImported((prev) => prev.map((e) => ({ ...e, rig: engine.retargetAnimation(e.source, desc, { id: e.id }) })));
  };

  const commitJoints = async (patch: JointLayout) => {
    const h = handleRef.current, engine = engineRef.current;
    if (!h || !engine) return;
    // A newer edit supersedes the running re-weight (the rig merges its patch into the newer one).
    reweighRef.current?.abort();
    const ac = new AbortController();
    reweighRef.current = ac;
    const latest = () => reweighRef.current === ac;
    setReweighting({ label: T.reweighting });
    try {
      const applied = await h.setJoints(patch, { signal: ac.signal, onProgress: (p) => latest() && setReweighting(p) });
      if (!applied || !latest()) return;
      editorRef.current?.setLayout(h.layout);
      rebuildClips(engine, h.descriptor);
    } catch (e) {
      if (!isAbort(e)) setError(errorToText(e));
    } finally {
      if (latest()) {
        reweighRef.current = null;
        setReweighting(null);
      }
    }
  };
  const commitRef = useRef(commitJoints);
  commitRef.current = commitJoints;

  useEffect(() => {
    if (!editing || phase !== 'rigged') return;
    const core = coreRef.current, h = handleRef.current, engine = engineRef.current;
    if (!core || !h || !engine) return;
    playerRef.current?.stop();
    setPlaying(false);
    setCurrent(null);
    setTime(0);
    const editor = new engine.JointEditor(core, {
      root: h.root,
      layout: h.layout,
      mirror: () => mirrorRef.current,
      onSelect: setSelected,
      onCommit: (patch) => void commitRef.current(patch),
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      if (editorRef.current === editor) editorRef.current = null;
      setSelected(null);
    };
  }, [editing, phase, coreRef]);

  const nudge = (axis: 'x' | 'y' | 'z', dir: 1 | -1) => {
    const h = handleRef.current;
    if (!h || !selected) return;
    const base = { ...h.layout, ...pending.current.patch };
    const p = base[selected];
    if (!p) return;
    const ys = Object.values(h.layout).map((v) => v!.y);
    const step = 0.01 * (Math.max(...ys) - Math.min(...ys));
    const next = { ...p, [axis]: p[axis] + dir * step };
    const patch: JointLayout = { ...pending.current.patch, [selected]: next };
    const twin = mirrorBone(selected);
    if (mirror && twin !== selected && base[twin]) {
      const cx = base.Hips?.x ?? 0;
      patch[twin] = { x: 2 * cx - next.x, y: next.y, z: next.z };
    }
    pending.current.patch = patch;
    editorRef.current?.setLayout({ ...h.layout, ...patch });
    if (pending.current.timer) clearTimeout(pending.current.timer);
    pending.current.timer = setTimeout(() => {
      const pp = pending.current.patch;
      pending.current = { patch: {}, timer: null };
      void commitRef.current(pp);
    }, 450);
  };
  useEffect(() => () => {
    if (pending.current.timer) clearTimeout(pending.current.timer);
    reweighRef.current?.abort();
  }, []);

  // ---- playback -------------------------------------------------------------

  const playClip = (c: RigClip) => {
    const p = playerRef.current;
    if (!p) return;
    if (editing) setEditing(false);
    // One-shots (jump, sit-down, fall-die…) hold their last frame; the switch only affects looping clips.
    p.play(c.clip, { loop: loop && c.info.loop, speed, crossFade: crossFade && p.isPlaying ? 0.3 : 0 });
    setCurrent(c.info.id);
    setPlaying(true);
    setTime(0);
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (!current) {
      const first = filtered[0];
      if (first) playClip(first);
      return;
    }
    if (p.isPlaying) {
      p.pause();
      setPlaying(false);
    } else {
      if (editing) setEditing(false);
      p.resume();
      setPlaying(true);
    }
  };

  const currentClip = current ? byId.get(current) ?? null : null;
  const duration = currentClip?.clip.duration ?? 0;

  // ---- import -----------------------------------------------------------------

  const onImport = async (file: File) => {
    const engine = engineRef.current, h = handleRef.current;
    if (!engine || !h) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await engine.importAnimationFile(file, file.name || 'animation', h.descriptor);
      const taken = new Set(allClips.map((c) => c.info.id));
      const entries: ImportedEntry[] = res.map((r) => {
        let id = r.info.id;
        for (let k = 2; taken.has(id); k++) id = `${r.info.id}-${k}`;
        taken.add(id);
        return { id, source: r.source, rig: id === r.info.id ? r : engine.retargetAnimation(r.source, h.descriptor, { id }) };
      });
      setImported((prev) => [...prev, ...entries]);
      setExportSel((prev) => new Set([...prev, ...entries.map((e) => e.id)]));
      if (entries[0]) playClip(entries[0].rig);
    } catch (e) {
      console.warn('[rig] import failed', e);
      setImportError(errorToText(e));
    } finally {
      setImporting(false);
    }
  };

  // ---- list ---------------------------------------------------------------------

  const q = search.trim().toLowerCase();
  const filtered = allClips.filter((c) => {
    if (category === 'imported' ? c.info.source !== 'imported' : category !== 'all' && c.info.category !== category) return false;
    if (!q) return true;
    return [c.info.id, c.info.name.tr, c.info.name.en].some((s) => s.toLowerCase().includes(q));
  });
  const groups = ANIMATION_CATEGORIES.map((cat) => ({ cat, clips: filtered.filter((c) => c.info.source === 'builtin' && c.info.category === cat.id) }))
    .filter((g) => g.clips.length);
  const importedShown = filtered.filter((c) => c.info.source === 'imported');

  const toggleExport = (id: string, on: boolean) =>
    setExportSel((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const busy = !enabled || phase === 'working' || !!reweighting;
  const methodText = info ? (info.method === 'pose' ? T.methodPose : info.method === 'silhouette' ? T.methodSilhouette : info.method === 'arms-down' ? T.methodArmsDown : T.methodProportional) : null;

  const renderItem = (c: RigClip) => (
    <li key={c.info.id} className={`rig-item${current === c.info.id ? ' is-current' : ''}`}>
      <input
        type="checkbox"
        checked={exportSel.has(c.info.id)}
        onChange={(e) => toggleExport(c.info.id, e.target.checked)}
        aria-label={`${tx(T.includeInExport)}: ${tx(c.info.name)}`}
        title={tx(T.includeInExport)}
        data-testid={`anim-export-${c.info.id}`}
      />
      <button
        type="button"
        className="rig-item-play"
        onClick={() => playClip(c)}
        disabled={!!reweighting}
        data-testid={`anim-${c.info.id}`}
        aria-pressed={current === c.info.id}
      >
        {current === c.info.id && playing ? <IconPause size={12} /> : <IconPlay size={12} />}
        <span className="truncate">{tx(c.info.name)}</span>
      </button>
      <span className="rig-item-meta">
        {c.info.loop && <IconLoop size={12} aria-label={tx(T.loopClip)} />}
        {tx(T.seconds, { s: c.info.duration.toFixed(1) })}
      </span>
    </li>
  );

  return (
    <section className="card rig" aria-labelledby="rig-title" data-testid="rig-panel">
      <div className="card-head">
        <h2 id="rig-title" className="card-title">
          <IconBone size={18} /> {tx(T.title)}
        </h2>
        {phase === 'rigged' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={removeRig} disabled={busy} data-testid="rig-remove">
            <IconX size={14} /> {tx(T.removeRig)}
          </button>
        )}
      </div>

      {!model ? (
        <p className="note small">
          <IconInfo size={14} /> {tx(T.noModel)}
        </p>
      ) : foreign ? (
        <EmbeddedAnimations model={model} coreRef={coreRef} loadEngine={loadEngine} />
      ) : phase !== 'rigged' ? (
        <>
          <p className="note small">
            <IconInfo size={14} /> {tx(T.intro)}
          </p>
          <div className="rig-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void autoRig()} disabled={!enabled || phase === 'working'} data-testid="rig-auto">
              {phase === 'working' ? <span className="spinner spinner-sm" aria-hidden="true" /> : <IconBone size={15} />} {tx(T.autoRig)}
            </button>
            {phase === 'working' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={cancel} data-testid="rig-cancel">
                {tx(T.cancel)}
              </button>
            )}
          </div>
          {phase === 'working' && <ProgressBar progress={progress} testId="rig-progress" compact />}
          {!enabled && phase === 'idle' && <p className="note small">{tx(T.disabled)}</p>}
        </>
      ) : (
        <>
          <div className="rig-status" data-testid="rig-status" data-bones={info?.bones} data-method={info?.method}>
            <span className="status status-ok">
              <IconCheck size={13} /> <strong>{tx(T.bones, { n: int(info?.bones ?? 0) })}</strong>
            </span>
            <span>{tx(T.weighted, { n: int(info?.vertices ?? 0) })}</span>
            {methodText && <span>· {tx(methodText)}</span>}
          </div>
          <div className="rig-toggles">
            <Switch label={tx(T.showSkeleton)} checked={showSkeleton || editing} disabled={editing} onChange={setShowSkeleton} testId="rig-skeleton" />
            <Switch label={tx(T.editJoints)} checked={editing} disabled={!enabled} onChange={setEditing} testId="rig-edit-joints" />
          </div>
          {editing && (
            <div className="rig-editor" data-testid="rig-editor">
              <p className="note small">
                <IconMove size={14} /> {tx(T.editHint)}
              </p>
              <div className="rig-row">
                <span className="small grow truncate">{selected ? tx(T.selectedJoint, { name: tx(boneLabel(selected)) }) : tx(T.noJoint)}</span>
                <Switch label={tx(T.mirror)} checked={mirror} onChange={setMirror} testId="rig-mirror" />
              </div>
              {selected && (
                <div className="rig-nudge-grid">
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <div key={axis} className="rig-nudge">
                      <span className="tabular">{axis.toUpperCase()}</span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => nudge(axis, -1)} aria-label={`${axis} −`} data-testid={`rig-nudge-${axis}-minus`}>−</button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => nudge(axis, 1)} aria-label={`${axis} +`} data-testid={`rig-nudge-${axis}-plus`}>+</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {reweighting && <ProgressBar progress={reweighting} testId="rig-reweight" compact />}

          <div className="rig-section">
            <div className="rig-section-title">{tx(T.animations)}</div>
            <div className="rig-transport">
              <button
                type="button"
                className="icon-btn"
                onClick={togglePlay}
                disabled={!!reweighting || allClips.length === 0}
                aria-label={tx(playing ? T.pause : T.play)}
                title={tx(playing ? T.pause : T.play)}
                data-testid="anim-play"
              >
                {playing ? <IconPause /> : <IconPlay />}
              </button>
              <button type="button" className="icon-btn" onClick={stopPlayback} disabled={!current} aria-label={tx(T.stop)} title={tx(T.stop)} data-testid="anim-stop">
                <IconStop />
              </button>
              <input
                type="range"
                className="range"
                min={0}
                max={Math.max(duration, 0.01)}
                step={0.01}
                value={Math.min(time, duration)}
                disabled={!currentClip}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  playerRef.current?.setTime(v);
                  setTime(v);
                }}
                aria-label={tx(T.time)}
                data-testid="anim-time"
                style={{ ['--pct' as string]: `${duration ? (Math.min(time, duration) / duration) * 100 : 0}%` }}
              />
              <span className="rig-time" data-testid="anim-time-label">
                {fmt(Math.min(time, duration))} / {fmt(duration)}
              </span>
            </div>
            <p className="rig-now" data-testid="anim-now" aria-live="polite">
              {currentClip ? <strong>{tx(currentClip.info.name)}</strong> : tx(T.nothingPlaying)}
            </p>
            <div className="rig-options">
              <label className="rig-speed">
                {tx(T.speed)}
                <input
                  type="range"
                  className="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSpeed(v);
                    playerRef.current?.setSpeed(v);
                  }}
                  data-testid="anim-speed"
                  style={{ ['--pct' as string]: `${((speed - 0.1) / 1.9) * 100}%` }}
                />
                <span className="tabular">{speed.toFixed(2)}×</span>
              </label>
              <span />
              <div className="rig-toggles">
                <Switch
                  label={tx(T.loop)}
                  checked={loop}
                  onChange={(v) => {
                    setLoop(v);
                    playerRef.current?.setLoop(v && (currentClip?.info.loop ?? true));
                  }}
                  testId="anim-loop"
                />
                <Switch label={tx(T.crossFade)} checked={crossFade} onChange={setCrossFade} testId="anim-crossfade" />
              </div>
            </div>

            <div className="rig-filter">
              <label className="rig-search">
                <IconSearch size={14} />
                <input
                  type="search"
                  className="input"
                  value={search}
                  placeholder={tx(T.search)}
                  aria-label={tx(T.search)}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="anim-search"
                />
              </label>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value as typeof category)} aria-label={tx(T.animations)} data-testid="anim-category">
                <option value="all">{tx(T.all)}</option>
                {ANIMATION_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {tx(c.name)}
                  </option>
                ))}
                {imported.length > 0 && <option value="imported">{tx(T.imported)}</option>}
              </select>
            </div>
            <ul className="rig-list" data-testid="anim-list" aria-label={tx(T.animations)}>
              {groups.map((g) => (
                <li key={g.cat.id}>
                  <div className="rig-group-title">{tx(g.cat.name)}</div>
                  <ul className="rig-sublist">{g.clips.map(renderItem)}</ul>
                </li>
              ))}
              {importedShown.length > 0 && (
                <li>
                  <div className="rig-group-title">{tx(T.imported)}</div>
                  <ul className="rig-sublist">{importedShown.map(renderItem)}</ul>
                </li>
              )}
              {filtered.length === 0 && <li className="rig-empty">{tx(T.noMatch)}</li>}
            </ul>
            <div className="rig-export">
              <span data-testid="anim-export-count">{tx(T.exportCount, { n: int(allClips.filter((c) => exportSel.has(c.info.id)).length) })}</span>
              <span className="btn-group">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExportSel(new Set(allClips.map((c) => c.info.id)))} data-testid="anim-export-all">
                  {tx(T.selectAll)}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExportSel(new Set())} data-testid="anim-export-none">
                  {tx(T.selectNone)}
                </button>
              </span>
            </div>
            <label className={`btn btn-secondary btn-sm rig-import${importing ? ' is-busy' : ''}`} title={tx(T.importHint)}>
              {importing ? <span className="spinner spinner-sm" aria-hidden="true" /> : <IconImport size={15} />}
              {tx(importing ? T.importing : T.import)}
              <input
                type="file"
                accept=".bvh,.fbx,.glb,.gltf"
                disabled={importing || !!reweighting}
                data-testid="anim-import"
                aria-label={tx(T.import)}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onImport(f);
                }}
              />
            </label>
            <p className="field-hint">{tx(T.importHint)}</p>
            {importError && (
              <div className="alert alert-danger" role="alert" data-testid="anim-import-error">
                <IconAlert size={16} />
                <div className="alert-body">{tx(importError)}</div>
              </div>
            )}
          </div>
        </>
      )}

      {error && (
        <div className="alert alert-danger" role="alert" data-testid="rig-error">
          <IconAlert size={16} />
          <div className="alert-body">{tx(error)}</div>
        </div>
      )}
    </section>
  );
}

function Switch({ label, checked, onChange, disabled, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className={`switch${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {label}
    </label>
  );
}

/** A skinned GLB with its own animations: play them (no rigging). */
function EmbeddedAnimations({ model, coreRef, loadEngine }: { model: BuiltModel; coreRef: MutableRefObject<ViewerCore | null>; loadEngine: () => Promise<Engine> }) {
  const { tx } = useI18n();
  const playerRef = useRef<RigEngine.AnimationPlayer | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const clips = model.animations ?? [];
  useEffect(() => () => {
    playerRef.current?.dispose();
    playerRef.current = null;
  }, [model]);
  const play = async (i: number) => {
    const core = coreRef.current;
    if (!core) return;
    const engine = await loadEngine();
    playerRef.current ??= new engine.AnimationPlayer(core, model.object);
    if (current === i) {
      playerRef.current.stop();
      setCurrent(null);
      return;
    }
    playerRef.current.play(clips[i], { loop: true });
    setCurrent(i);
  };
  return (
    <>
      <p className="note small">
        <IconInfo size={14} /> {tx(T.foreign)}
      </p>
      <div className="rig-section-title">{tx(T.embedded)}</div>
      {clips.length === 0 ? (
        <p className="small muted">{tx(T.noEmbedded)}</p>
      ) : (
        <ul className="rig-list" data-testid="anim-embedded">
          {clips.map((c, i) => (
            <li key={`${c.name}-${i}`} className={`rig-item${current === i ? ' is-current' : ''}`}>
              <button type="button" className="rig-item-play" onClick={() => void play(i)} data-testid={`anim-embedded-${i}`} aria-pressed={current === i}>
                {current === i ? <IconStop size={12} /> : <IconPlay size={12} />}
                <span className="truncate">{c.name || `#${i + 1}`}</span>
              </button>
              <span className="rig-item-meta">{tx(T.seconds, { s: c.duration.toFixed(1) })}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

