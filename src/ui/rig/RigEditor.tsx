/**
 * "Rig editörü": the advanced rig editor inside the Rig step.
 *
 *  - Düzen (edit): bone hierarchy tree (select, drag to reparent), add a
 *    child at the tip or by clicking the mesh, delete (children reparented),
 *    rename, parent / role / deform, numeric head & tail, mirror a side, the
 *    gizmo (TransformControls) moves joints with interior snapping,
 *    symmetry for every edit, re-weight all / selected bones.
 *  - Poz (pose): rotate bones with the gizmo, IK targets + poles on limbs,
 *    copy / paste / mirror pose, reset, and the keyframe timeline (key the
 *    selected bone / all, move / delete keys, interpolation, loop, fps,
 *    duration, preview playback) → save as a named custom clip.
 *  - Ağırlık (paint): brush add / subtract / smooth / replace with radius,
 *    strength, falloff on the selected bone, heat map, normalise, smooth,
 *    mirror weights, auto weights for the selected bone.
 *
 * Every operation is undoable (EditHistory; Ctrl/⌘+Z, Ctrl+Shift+Z / Ctrl+Y).
 * Shortcuts (ignored while typing): Tab edit ↔ pose, G move, R rotate,
 * I insert key, E add child, Delete delete bone / key, M mirror pose,
 * Space play / pause, Ctrl+C / Ctrl+V copy / paste pose, Esc deselect.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Box3, Vector3 } from 'three';
import type { ViewerCore } from '../../app/viewer';
import { errorToText } from '../../app/format';
import type { I18nText, Progress } from '../../core/types';
import type * as RigEngine from '../../rig/engine';
import type { BoneRole, BoneSpec, RigClip, SkeletonSpec, Vec3 } from '../../rig/types';
import { useI18n } from '../i18n';
import { ProgressBar } from '../GeneratePanel';
import { IconAlert, IconUndo } from '../icons';
import { IconPause, IconPlay } from './icons';

type Engine = typeof RigEngine;
type ClipDoc = RigEngine.keys.ClipDoc;
type PoseSnapshot = RigEngine.keys.PoseSnapshot;
type Interp = RigEngine.keys.Interp;
type OpResult = RigEngine.ops.OpResult;
type JointEnd = RigEngine.ops.JointEnd;
type Mode = RigEngine.EditorMode;

export const RIG_EDITOR_TEXT = {
  title: { tr: 'Rig editörü', en: 'Rig editor' },
  modeEdit: { tr: 'Düzen', en: 'Edit' },
  modePose: { tr: 'Poz', en: 'Pose' },
  modePaint: { tr: 'Ağırlık', en: 'Weights' },
  hierarchy: { tr: 'Kemik ağacı', en: 'Bone hierarchy' },
  treeHint: { tr: 'Seçmek için tıklayın, üst kemik değiştirmek için sürükleyip bırakın.', en: 'Click to select, drag onto another bone to reparent.' },
  symmetry: { tr: 'Simetri', en: 'Symmetry' },
  snap: { tr: 'Mesh içine yapıştır', en: 'Snap inside mesh' },
  undo: { tr: 'Geri al', en: 'Undo' },
  redo: { tr: 'Yinele', en: 'Redo' },
  addChild: { tr: 'Alt kemik (uçta)', en: 'Child at tip' },
  addOnMesh: { tr: 'Mesh’e tıklayarak ekle', en: 'Add by clicking the mesh' },
  addArmed: { tr: 'Yeni kemiğin ucu için modele tıklayın… (Esc: vazgeç)', en: 'Click the model for the new bone’s tip… (Esc: cancel)' },
  delete: { tr: 'Sil', en: 'Delete' },
  mirrorLR: { tr: 'Sol → sağ aynala', en: 'Mirror left → right' },
  mirrorRL: { tr: 'Sağ → sol aynala', en: 'Mirror right → left' },
  name: { tr: 'Ad', en: 'Name' },
  parent: { tr: 'Üst kemik', en: 'Parent' },
  head: { tr: 'Baş (eklem)', en: 'Head (joint)' },
  tail: { tr: 'Uç', en: 'Tail' },
  deform: { tr: 'Deriyi etkiler', en: 'Deforms the skin' },
  role: { tr: 'Rol', en: 'Role' },
  side: { tr: 'Taraf', en: 'Side' },
  limb: { tr: 'Bacak', en: 'Limb' },
  index: { tr: 'Sıra', en: 'Index' },
  none: { tr: '—', en: '—' },
  noSelection: { tr: 'Bir kemik seçin (ağaçtan ya da görünümden).', en: 'Select a bone (in the tree or the view).' },
  reweighAll: { tr: 'Tümünü yeniden ağırlıklandır', en: 'Re-weight all' },
  reweighSel: { tr: 'Seçili için otomatik ağırlık', en: 'Auto weights for selected' },
  reweighing: { tr: 'Ağırlıklar hesaplanıyor…', en: 'Computing weights…' },
  fromTemplate: { tr: 'Şablondan yeniden başla…', en: 'Restart from a template…' },
  tplQuadruped: { tr: 'Dört ayaklı', en: 'Quadruped' },
  tplBird: { tr: 'Kuş', en: 'Bird' },
  tplSnake: { tr: 'Yılan / zincir', en: 'Snake / chain' },
  tplEmpty: { tr: 'Boş (tek kök kemik)', en: 'Empty (single root bone)' },
  rebindHint: {
    tr: 'Eklem taşımak iskeleti yeniden bağlar; ağırlıkları gerektiğinde yeniden hesaplayın.',
    en: 'Moving joints re-binds the skeleton; recompute the weights when needed.',
  },
  // Paint
  brush: { tr: 'Fırça', en: 'Brush' },
  add: { tr: 'Ekle', en: 'Add' },
  subtract: { tr: 'Çıkar', en: 'Subtract' },
  smooth: { tr: 'Yumuşat', en: 'Smooth' },
  replace: { tr: 'Değiştir', en: 'Replace' },
  radius: { tr: 'Yarıçap', en: 'Radius' },
  strength: { tr: 'Güç', en: 'Strength' },
  falloff: { tr: 'Düşüş', en: 'Falloff' },
  falloffSmooth: { tr: 'Yumuşak', en: 'Smooth' },
  falloffLinear: { tr: 'Doğrusal', en: 'Linear' },
  falloffConstant: { tr: 'Sabit', en: 'Constant' },
  value: { tr: 'Değer', en: 'Value' },
  heat: { tr: 'Isı haritası', en: 'Heat map' },
  normalize: { tr: 'Normalleştir', en: 'Normalise' },
  smoothBone: { tr: 'Kemiği yumuşat', en: 'Smooth bone' },
  mirrorWeightsLR: { tr: 'Ağırlıkları sol → sağ', en: 'Weights left → right' },
  mirrorWeightsRL: { tr: 'Ağırlıkları sağ → sol', en: 'Weights right → left' },
  paintHint: { tr: 'Seçili kemiğin ağırlığını modelin üzerinde boyayın; boş alanda sürüklemek görünümü döndürür.', en: 'Paint the selected bone’s weights on the model; dragging off the model orbits.' },
  // Pose
  rotate: { tr: 'Döndür (R)', en: 'Rotate (R)' },
  move: { tr: 'Taşı (G)', en: 'Move (G)' },
  resetPose: { tr: 'Pozu sıfırla', en: 'Reset pose' },
  copyPose: { tr: 'Pozu kopyala', en: 'Copy pose' },
  pastePose: { tr: 'Yapıştır', en: 'Paste' },
  mirrorPose: { tr: 'Pozu aynala', en: 'Mirror pose' },
  ikHint: { tr: 'Yeşil küpler el / ayak IK hedefi, pembe küreler dirsek / diz yönü.', en: 'Green cubes are hand / foot IK targets, pink spheres the elbow / knee poles.' },
  timeline: { tr: 'Zaman çizelgesi', en: 'Timeline' },
  keySel: { tr: 'Anahtar: seçili (I)', en: 'Key selected (I)' },
  keyAll: { tr: 'Anahtar: tümü', en: 'Key all' },
  deleteKey: { tr: 'Anahtarı sil', en: 'Delete key' },
  prevKey: { tr: 'Önceki anahtar', en: 'Previous key' },
  nextKey: { tr: 'Sonraki anahtar', en: 'Next key' },
  interp: { tr: 'Geçiş', en: 'Interpolation' },
  linear: { tr: 'Doğrusal', en: 'Linear' },
  smoothI: { tr: 'Yumuşak', en: 'Smooth' },
  step: { tr: 'Basamak', en: 'Step' },
  duration: { tr: 'Süre (sn)', en: 'Duration (s)' },
  fps: { tr: 'FPS', en: 'FPS' },
  loop: { tr: 'Döngü', en: 'Loop' },
  clipName: { tr: 'Klip adı', en: 'Clip name' },
  save: { tr: 'Klibi kaydet', en: 'Save clip' },
  saved: { tr: '“{name}” animasyon listesine eklendi.', en: '“{name}” was added to the animation list.' },
  load: { tr: 'Düzenle', en: 'Edit' },
  newClip: { tr: 'Yeni', en: 'New' },
  allBones: { tr: 'Tüm kemikler', en: 'All bones' },
  keysOf: { tr: '{name} anahtarları', en: '{name} keys' },
  shortcuts: {
    tr: 'Kısayollar: Tab düzen/poz · G taşı · R döndür · I anahtar · E alt kemik · Del sil · M poz aynala · Boşluk oynat · Ctrl+Z / Ctrl+Y',
    en: 'Shortcuts: Tab edit/pose · G move · R rotate · I key · E add child · Del delete · M mirror pose · Space play · Ctrl+Z / Ctrl+Y',
  },
} satisfies Record<string, I18nText>;

const T = RIG_EDITOR_TEXT;

const ROLE_PARTS: BoneRole['part'][] = ['root', 'spine', 'neck', 'head', 'jaw', 'ear', 'tail', 'leg', 'arm', 'wing', 'chain', 'end'];

export interface RigEditorProps {
  engine: Engine;
  handle: RigEngine.RigHandle;
  core: ViewerCore;
  enabled: boolean;
  /** The skeleton or the weights changed (rebuild the clips). */
  onSkeletonChanged: () => void;
  /** A custom clip was saved (same id = replace). */
  onSaveClip: (clip: RigClip) => void;
  /** Saved custom clips (their documents can be edited again). */
  customClips: RigClip[];
  /** Bones were renamed (old → new): custom clips should follow. */
  onBonesRenamed?: (renamed: Record<string, string>) => void;
}

interface Sel {
  bone: string;
  end: JointEnd;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(3));

export function RigEditor({ engine, handle, core, enabled, onSkeletonChanged, onSaveClip, customClips, onBonesRenamed }: RigEditorProps) {
  const { tx } = useI18n();
  const vpRef = useRef<RigEngine.RigEditorViewport | null>(null);
  const histRef = useRef<RigEngine.EditHistory | null>(null);
  histRef.current ??= new engine.EditHistory(120);
  const [hist, setHist] = useState<RigEngine.HistoryState>(histRef.current.state);
  const [mode, setModeState] = useState<Mode>('edit');
  const [sel, setSel] = useState<Sel | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [sym, setSym] = useState(true);
  const [snap, setSnap] = useState(true);
  const [brush, setBrush] = useState<RigEngine.BrushSettings>({ mode: 'add', radius: 0.06, strength: 0.4, falloff: 'smooth', value: 1 });
  const [heatOn, setHeatOn] = useState(true);
  const [busy, setBusy] = useState<Progress | null>(null);
  const [error, setError] = useState<I18nText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addArmed, setAddArmed] = useState(false);
  const [poseGizmo, setPoseGizmo] = useState<'rotate' | 'translate'>('rotate');
  const [doc, setDocState] = useState<ClipDoc>(() => engine.keys.newClipDoc('Custom 1', 2, 30, true));
  const docRef = useRef(doc);
  docRef.current = doc;
  const [time, setTimeState] = useState(0);
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [interp, setInterpState] = useState<Interp>('smooth');
  const clipboard = useRef<PoseSnapshot | null>(null);
  const reweighRef = useRef<AbortController | null>(null);
  const cbRef = useRef({ onSkeletonChanged, onSaveClip, onBonesRenamed });
  cbRef.current = { onSkeletonChanged, onSaveClip, onBonesRenamed };
  const spec = handle.spec;

  const history = histRef.current;
  useEffect(() => {
    history.onChange = setHist;
    return () => {
      history.onChange = null;
    };
  }, [history]);

  // ---- viewport lifecycle ----------------------------------------------------------

  useEffect(() => {
    const vp = new engine.RigEditorViewport(core, handle, {
      onSelect: (bone, end) => setSel(bone ? { bone, end } : null),
      onJointMoved: (bone, end, pos) => void applyOpRef.current(engine.ops.moveJoint(handle.spec, bone, end, pos, { symmetric: vp.symmetry }), `move ${bone}`),
      onPoseEdited: (before, after, label) => pushPose(before, after, label),
      onAddAt: (pos) => {
        setAddArmed(false);
        const parent = selRef.current?.bone ?? handle.spec.bones[0].name;
        void applyOpRef.current(engine.ops.addBone(handle.spec, parent, { tail: pos, symmetric: vp.symmetry }), 'add bone');
      },
      onStroke: (diff) => commitPaint(diff, 'paint'),
    });
    vpRef.current = vp;
    return () => {
      vp.dispose();
      vpRef.current = null;
      reweighRef.current?.abort();
    };
    // The viewport lives as long as the editor for this rig (callbacks read refs).
  }, [engine, handle, core]);

  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    vp.symmetry = sym;
    vp.snap = snap;
    vp.brush = brush;
    vp.heatVisible = heatOn;
    if (vp.poseGizmo !== poseGizmo) {
      vp.poseGizmo = poseGizmo;
      if (vp.selectedBone) vp.select(vp.selectedBone);
    }
    if (mode === 'paint') vp.showHeat();
  }, [sym, snap, brush, heatOn, poseGizmo, mode]);

  const setMode = useCallback((m: Mode) => {
    setPlaying(false);
    setAddArmed(false);
    vpRef.current?.armAddBone(false);
    vpRef.current?.setMode(m);
    setModeState(m);
  }, []);

  const select = (bone: string | null, end: JointEnd = 'head') => {
    vpRef.current?.select(bone, end);
    setSel(bone ? { bone, end } : null);
  };

  // ---- history helpers ------------------------------------------------------------

  const afterSkeleton = () => {
    vpRef.current?.refresh();
    bump();
    cbRef.current.onSkeletonChanged();
  };

  /** Restore a (spec, weights) state (undo / redo of skeleton edits). */
  const restore = async (s: { spec: SkeletonSpec; weights: RigEngine.RigHandle['weights'] }) => {
    await handle.setSpec(s.spec, { weights: s.weights });
    afterSkeleton();
  };

  const applyOp = async (r: OpResult, label: string, reweigh: 'none' | 'all' | string[] = 'none') => {
    if (!r.changed && reweigh === 'none') return;
    setError(null);
    const before = { spec: handle.spec, weights: handle.weights };
    let ok = false;
    const needsWorker = reweigh !== 'none';
    const ac = new AbortController();
    if (needsWorker) {
      reweighRef.current?.abort();
      reweighRef.current = ac;
      setBusy({ label: T.reweighing });
    }
    try {
      ok = await handle.setSpec(r.spec, { renamed: r.renamed, reweigh, signal: ac.signal, onProgress: (p) => reweighRef.current === ac && setBusy(p) });
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setError(errorToText(e));
    } finally {
      if (needsWorker && reweighRef.current === ac) {
        reweighRef.current = null;
        setBusy(null);
      }
    }
    if (!ok) return;
    const after = { spec: handle.spec, weights: handle.weights };
    const bytes = before.weights !== after.weights ? after.weights.skinWeight.byteLength * 1.5 : 0;
    // Renamed bones: the timeline and the saved custom clips follow (and follow back on undo).
    const renamed = r.renamed && Object.keys(r.renamed).length ? r.renamed : null;
    const inverse = renamed ? Object.fromEntries(Object.entries(renamed).map(([a, b]) => [b, a])) : null;
    const renameAll = (map: Record<string, string> | null) => {
      if (!map) return;
      const d = engine.keys.renameDocBones(docRef.current, map);
      docRef.current = d;
      setDocState(d);
      cbRef.current.onBonesRenamed?.(map);
    };
    renameAll(renamed);
    history.push({
      label,
      undo: async () => {
        await restore(before);
        renameAll(inverse);
      },
      redo: async () => {
        await restore(after);
        renameAll(renamed);
      },
      bytes,
    });
    afterSkeleton();
    if (r.select !== undefined) select(r.select && handle.spec.bones.some((b) => b.name === r.select) ? r.select : null);
  };
  const applyOpRef = useRef(applyOp);
  applyOpRef.current = applyOp;

  const pushPose = (before: PoseSnapshot, after: PoseSnapshot, label: string) => {
    history.push({ label, undo: () => vpRef.current?.applyPose(before), redo: () => vpRef.current?.applyPose(after) });
  };

  const commitPaint = (diff: RigEngine.WeightDiff | null, label: string) => {
    const vp = vpRef.current;
    if (!diff || !vp) return;
    handle.setWeights(vp.painter.weights());
    const apply = (which: 'before' | 'after') => {
      const v = vpRef.current;
      if (!v) return;
      v.painter.applyDiff(diff, which);
      handle.setWeights(v.painter.weights());
      v.showHeat();
      cbRef.current.onSkeletonChanged();
    };
    history.push({ label, undo: () => apply('before'), redo: () => apply('after'), bytes: diff.ids.length * 48 });
    cbRef.current.onSkeletonChanged();
  };

  const setDoc = (next: ClipDoc, label: string) => {
    const before = docRef.current;
    if (next === before) return;
    docRef.current = next;
    setDocState(next);
    history.push({
      label,
      undo: () => {
        docRef.current = before;
        setDocState(before);
      },
      redo: () => {
        docRef.current = next;
        setDocState(next);
      },
    });
  };

  const undo = () => void history.undo();
  const redo = () => void history.redo();

  // ---- skeleton operations ------------------------------------------------------------

  const bones = spec.bones;
  const selBone: BoneSpec | null = sel ? bones.find((b) => b.name === sel.bone) ?? null : null;

  const addChild = () => {
    const parent = sel?.bone ?? bones[0].name;
    void applyOp(engine.ops.addBone(spec, parent, { symmetric: sym }), 'add bone');
  };
  const armAdd = () => {
    const on = !addArmed;
    setAddArmed(on);
    vpRef.current?.armAddBone(on);
  };
  const del = () => sel && void applyOp(engine.ops.deleteBone(spec, sel.bone, { symmetric: sym }), `delete ${sel.bone}`);
  const rename = (name: string) => sel && name && name !== sel.bone && void applyOp(engine.ops.renameBone(spec, sel.bone, name, { symmetric: sym }), `rename ${sel.bone}`);
  const reparent = (name: string, parent: string) => void applyOp(engine.ops.reparentBone(spec, name, parent, { symmetric: sym }), `reparent ${name}`);
  const moveNumeric = (end: JointEnd, axis: 'x' | 'y' | 'z', value: number) => {
    if (!selBone || !Number.isFinite(value)) return;
    const p: Vec3 = { ...selBone[end], [axis]: value };
    void applyOp(engine.ops.moveJoint(spec, selBone.name, end, p, { symmetric: sym }), `move ${selBone.name}`);
  };
  const setRole = (role: BoneRole | undefined) => selBone && void applyOp(engine.ops.setBoneRole(spec, selBone.name, role), `role ${selBone.name}`);
  const setDeform = (d: boolean) => selBone && void applyOp(engine.ops.setBoneDeform(spec, selBone.name, d), `deform ${selBone.name}`);
  const mirror = (from: 'L' | 'R') => void applyOp(engine.ops.mirrorSide(spec, from), 'mirror');
  const reweighAll = () => void applyOp({ spec, changed: true }, 're-weight', 'all');
  /** Replace the skeleton by a template placed proportionally in the mesh bounds (re-weighted, undoable). */
  const fromTemplate = (t: 'quadruped' | 'bird' | 'snake' | 'empty') => {
    const p = handle.surface.positions;
    const box = new Box3();
    const v = new Vector3();
    for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
    const next = t === 'empty' ? engine.emptySpec(box) : engine.proportionalSpec(t, box, spec.frame.forward);
    select(null);
    void applyOp({ spec: next, changed: true, select: null }, `template ${t}`, 'all');
  };
  const reweighSel = () => {
    if (!sel) return;
    const names = [sel.bone];
    const twin = sym ? engine.findMirrorBone(spec, sel.bone) : null;
    if (twin) names.push(twin);
    void applyOp({ spec, changed: true }, 'auto weights', names);
  };

  // ---- paint operations -------------------------------------------------------------------

  const paintOp = (label: string, fn: (p: RigEngine.RigEditorViewport['painter']) => void) => {
    const vp = vpRef.current;
    if (!vp) return;
    const p = vp.painter;
    p.beginStroke();
    fn(p);
    const diff = p.endStroke();
    if (diff) vp.writeVertices(diff.ids);
    commitPaint(diff, label);
    vp.showHeat();
  };
  const selIndex = sel ? bones.findIndex((b) => b.name === sel.bone) : -1;
  const normalize = () => paintOp('normalise', (p) => p.normalizeAll());
  const smoothBone = () => selIndex >= 0 && paintOp('smooth', (p) => p.smoothBone(selIndex, 2, 0.5));
  const mirrorWeights = (from: 'L' | 'R') =>
    paintOp('mirror weights', (p) => {
      const root = bones.find((b) => b.parent === null)!;
      const n = engine.specSize(spec);
      const f = spec.frame.forward, up = spec.frame.up;
      const left = { x: up.y * f.z - up.z * f.y, y: up.z * f.x - up.x * f.z, z: up.x * f.y - up.y * f.x };
      const idx = new Map(bones.map((b, i) => [b.name, i]));
      const map = (b: number) => idx.get(engine.findMirrorBone(spec, bones[b]?.name ?? '') ?? '') ?? b;
      p.mirror(root.head, left, map, from === 'L', 0.01 * n);
    });

  // ---- pose / timeline --------------------------------------------------------------------

  const capture = () => vpRef.current?.capturePose() ?? { rot: {}, pos: {} };
  const applyPoseUndoable = (next: PoseSnapshot, label: string, reset = true) => {
    const vp = vpRef.current;
    if (!vp) return;
    const before = vp.capturePose();
    vp.applyPose(next, reset);
    pushPose(before, vp.capturePose(), label);
  };
  const resetPose = () => applyPoseUndoable({ rot: {}, pos: {} }, 'reset pose');
  const copyPose = () => (clipboard.current = capture());
  const pastePose = () => clipboard.current && applyPoseUndoable(clipboard.current, 'paste pose');
  const mirrorPose = () => applyPoseUndoable(engine.keys.mirrorPose(capture(), spec), 'mirror pose', false);

  const setTime = (t: number) => {
    const d = docRef.current;
    const tt = Math.min(Math.max(t, 0), d.duration);
    timeRef.current = tt;
    setTimeState(tt);
    if (engine.keys.keyTimes(d).length) vpRef.current?.showDocPose(d, tt);
  };

  const keySelected = () => {
    if (!sel) return keyAll();
    const snapPose = capture();
    const bonesSet = new Set([sel.bone]);
    const twin = sym ? engine.findMirrorBone(spec, sel.bone) : null;
    if (twin) bonesSet.add(twin);
    setDoc(engine.keys.setPoseKeys(docRef.current, timeRef.current, snapPose, interp, bonesSet), `key ${sel.bone}`);
  };
  const keyAll = () => setDoc(engine.keys.setPoseKeys(docRef.current, timeRef.current, capture(), interp), 'key all');
  const deleteKey = () => setDoc(engine.keys.deleteKeys(docRef.current, timeRef.current, sel?.bone), 'delete key');
  const allKeyTimes = engine.keys.keyTimes(doc);
  const boneKeyTimes = sel ? engine.keys.keyTimes(doc, sel.bone) : [];
  const jumpKey = (dir: 1 | -1) => {
    const ts = sel && boneKeyTimes.length ? boneKeyTimes : allKeyTimes;
    const t = timeRef.current;
    const next = dir > 0 ? ts.find((x) => x > t + 1e-6) : [...ts].reverse().find((x) => x < t - 1e-6);
    if (next !== undefined) setTime(next);
  };
  const applyInterp = (i: Interp) => {
    setInterpState(i);
    if (allKeyTimes.some((t) => Math.abs(t - timeRef.current) < 0.5 / doc.fps)) setDoc(engine.keys.setInterp(docRef.current, timeRef.current, i, sel?.bone), 'interpolation');
  };
  const saveClip = () => {
    if (!allKeyTimes.length) return;
    const rc = engine.keys.toAnimationClip(docRef.current);
    cbRef.current.onSaveClip(rc);
    setNotice(tx(T.saved, { name: rc.info.name.en }));
  };
  const loadClip = (c: RigClip) => {
    const d = (c.clip.userData as { doc?: ClipDoc }).doc;
    if (d) {
      setDoc(d, 'load clip');
      setTime(0);
    }
  };

  // Preview playback through the viewer's frame loop.
  useEffect(() => {
    if (!playing) return;
    let last = 0;
    const off = core.addFrameListener((dt) => {
      const d = docRef.current;
      let t = timeRef.current + dt;
      if (t > d.duration) {
        if (d.loop) t %= Math.max(d.duration, 1e-3);
        else {
          t = d.duration;
          setPlaying(false);
        }
      }
      timeRef.current = t;
      vpRef.current?.showDocPose(d, t);
      const now = performance.now();
      if (now - last > 80) {
        last = now;
        setTimeState(t);
      }
      return true;
    });
    return off;
  }, [playing, core]);

  // ---- keyboard ------------------------------------------------------------------------

  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.altKey) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // Tab / Space / copy-paste only when no page control has the focus (keyboard navigation and buttons keep working).
    const el = e.target;
    const free = !(el instanceof HTMLElement) || el === document.body || el === document.documentElement || el.tagName === 'CANVAS';
    if (mod) {
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else if (k === 'c' && mode === 'pose' && free && !String(window.getSelection?.() ?? '')) copyPose();
      else if (k === 'v' && mode === 'pose' && free) pastePose();
      else return;
      e.preventDefault();
      return;
    }
    switch (k) {
      case 'tab':
        if (!free || e.shiftKey) return;
        setMode(mode === 'edit' ? 'pose' : 'edit');
        break;
      case 'g':
        if (mode === 'pose') setPoseGizmo('translate');
        else setMode('edit');
        break;
      case 'r':
        if (mode !== 'pose') setMode('pose');
        setPoseGizmo('rotate');
        break;
      case 'i':
        if (mode === 'pose') keySelected();
        else return;
        break;
      case 'e':
        if (mode === 'edit') addChild();
        else return;
        break;
      case 'm':
        if (mode === 'pose') mirrorPose();
        else return;
        break;
      case 'delete':
      case 'backspace':
        if (mode === 'edit') del();
        else if (mode === 'pose') deleteKey();
        else return;
        break;
      case ' ':
        if (mode === 'pose' && free) setPlaying((p) => !p);
        else return;
        break;
      case 'escape':
        if (addArmed) armAdd();
        else select(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ---- tree -------------------------------------------------------------------------------

  const rows = useMemo(() => {
    const kids = new Map<string | null, BoneSpec[]>();
    for (const b of bones) {
      const k = b.parent;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k)!.push(b);
    }
    const out: { b: BoneSpec; depth: number }[] = [];
    const walk = (p: string | null, depth: number) => {
      for (const b of kids.get(p) ?? []) {
        out.push({ b, depth });
        walk(b.name, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [bones]);
  const dragRef = useRef<string | null>(null);

  const disabled = !enabled || !!busy;

  return (
    <div className="rig-ed" data-testid="rig-editor-panel" data-mode={mode} data-bones={bones.length}>
      <div className="rig-ed-bar">
        <div className="rig-ed-tabs" role="tablist" aria-label={tx(T.title)}>
          {(['edit', 'pose', 'paint'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`rig-ed-tab${mode === m ? ' is-active' : ''}`}
              onClick={() => setMode(m)}
              data-testid={`rig-ed-mode-${m}`}
            >
              {tx(m === 'edit' ? T.modeEdit : m === 'pose' ? T.modePose : T.modePaint)}
            </button>
          ))}
        </div>
        <span className="rig-ed-tools">
          <button type="button" className="icon-btn" onClick={undo} disabled={hist.undo === 0 || hist.busy} title={`${tx(T.undo)} (Ctrl+Z)${hist.undoLabel ? ` · ${hist.undoLabel}` : ''}`} aria-label={tx(T.undo)} data-testid="rig-ed-undo">
            <IconUndo size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={redo} disabled={hist.redo === 0 || hist.busy} title={`${tx(T.redo)} (Ctrl+Shift+Z)${hist.redoLabel ? ` · ${hist.redoLabel}` : ''}`} aria-label={tx(T.redo)} data-testid="rig-ed-redo">
            <IconUndo size={15} style={{ transform: 'scaleX(-1)' }} />
          </button>
        </span>
      </div>
      <div className="rig-toggles">
        <Toggle label={tx(T.symmetry)} checked={sym} onChange={setSym} testId="rig-ed-sym" />
        {mode === 'edit' && <Toggle label={tx(T.snap)} checked={snap} onChange={setSnap} testId="rig-ed-snap" />}
        {mode === 'paint' && <Toggle label={tx(T.heat)} checked={heatOn} onChange={setHeatOn} testId="rig-ed-heat" />}
      </div>

      <div className="rig-ed-grid">
        <div className="rig-ed-tree-wrap">
          <div className="rig-section-title">{tx(T.hierarchy)}</div>
          <ul className="rig-ed-tree" role="tree" aria-label={tx(T.hierarchy)} data-testid="rig-ed-tree" title={tx(T.treeHint)}>
            {rows.map(({ b, depth }) => (
              <li
                key={b.name}
                role="treeitem"
                aria-selected={sel?.bone === b.name}
                className={`rig-ed-node${sel?.bone === b.name ? ' is-selected' : ''}${b.deform ? '' : ' is-nodeform'}`}
                style={{ paddingLeft: 6 + depth * 12 }}
                draggable={mode === 'edit' && b.parent !== null}
                onDragStart={(e) => {
                  dragRef.current = b.name;
                  e.dataTransfer.setData('text/plain', b.name);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragRef.current && dragRef.current !== b.name) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragRef.current ?? e.dataTransfer.getData('text/plain');
                  dragRef.current = null;
                  if (from && from !== b.name) reparent(from, b.name);
                }}
              >
                <button type="button" className="rig-ed-node-btn" onClick={() => select(b.name)} data-testid={`rig-ed-bone-${b.name}`}>
                  <span className="truncate">{b.name}</span>
                  {b.role && <span className="rig-ed-role">{b.role.part}{b.role.side ? `·${b.role.side}` : ''}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="rig-ed-props">
          {mode === 'edit' && (
            <>
              <div className="rig-row">
                <button type="button" className="btn btn-secondary btn-sm" onClick={addChild} disabled={disabled} data-testid="rig-ed-add" title="E">
                  + {tx(T.addChild)}
                </button>
                <button type="button" className={`btn btn-sm ${addArmed ? 'btn-primary' : 'btn-secondary'}`} onClick={armAdd} disabled={disabled} aria-pressed={addArmed} data-testid="rig-ed-add-mesh">
                  + {tx(T.addOnMesh)}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={del} disabled={disabled || !sel || bones.length <= 1} data-testid="rig-ed-delete" title="Delete">
                  {tx(T.delete)}
                </button>
              </div>
              {addArmed && <p className="note small">{tx(T.addArmed)}</p>}
              <div className="rig-row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => mirror('L')} disabled={disabled} data-testid="rig-ed-mirror-lr">{tx(T.mirrorLR)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => mirror('R')} disabled={disabled} data-testid="rig-ed-mirror-rl">{tx(T.mirrorRL)}</button>
              </div>
              {selBone ? (
                <BoneProps
                  key={`${selBone.name}-${handle.version}`}
                  bone={selBone}
                  bones={bones}
                  disabled={disabled}
                  onRename={rename}
                  onParent={(p) => reparent(selBone.name, p)}
                  onMove={moveNumeric}
                  onRole={setRole}
                  onDeform={setDeform}
                />
              ) : (
                <p className="small muted">{tx(T.noSelection)}</p>
              )}
              <div className="rig-row">
                <button type="button" className="btn btn-secondary btn-sm" onClick={reweighAll} disabled={disabled} data-testid="rig-ed-reweigh">{tx(T.reweighAll)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={reweighSel} disabled={disabled || !sel} data-testid="rig-ed-reweigh-sel">{tx(T.reweighSel)}</button>
              </div>
              <p className="field-hint">{tx(T.rebindHint)}</p>
              <select
                className="select rig-ed-load"
                value=""
                disabled={disabled}
                onChange={(e) => e.target.value && fromTemplate(e.target.value as 'quadruped' | 'bird' | 'snake' | 'empty')}
                aria-label={tx(T.fromTemplate)}
                data-testid="rig-ed-template"
              >
                <option value="">{tx(T.fromTemplate)}</option>
                <option value="quadruped">{tx(T.tplQuadruped)}</option>
                <option value="bird">{tx(T.tplBird)}</option>
                <option value="snake">{tx(T.tplSnake)}</option>
                <option value="empty">{tx(T.tplEmpty)}</option>
              </select>
            </>
          )}

          {mode === 'paint' && (
            <>
              <p className="note small">{tx(T.paintHint)}</p>
              {!sel && <p className="small muted">{tx(T.noSelection)}</p>}
              <div className="rig-ed-seg" role="radiogroup" aria-label={tx(T.brush)}>
                {(['add', 'subtract', 'smooth', 'replace'] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={brush.mode === m} className={`rig-ed-segbtn${brush.mode === m ? ' is-active' : ''}`} onClick={() => setBrush({ ...brush, mode: m })} data-testid={`rig-ed-brush-${m}`}>
                    {tx(T[m])}
                  </button>
                ))}
              </div>
              <Slider label={tx(T.radius)} min={0.01} max={0.3} step={0.005} value={brush.radius} onChange={(v) => setBrush({ ...brush, radius: v })} testId="rig-ed-radius" />
              <Slider label={tx(T.strength)} min={0.01} max={1} step={0.01} value={brush.strength} onChange={(v) => setBrush({ ...brush, strength: v })} testId="rig-ed-strength" />
              {brush.mode === 'replace' && <Slider label={tx(T.value)} min={0} max={1} step={0.01} value={brush.value} onChange={(v) => setBrush({ ...brush, value: v })} testId="rig-ed-value" />}
              <label className="rig-ed-field">
                <span>{tx(T.falloff)}</span>
                <select className="select" value={brush.falloff} onChange={(e) => setBrush({ ...brush, falloff: e.target.value as RigEngine.BrushSettings['falloff'] })} data-testid="rig-ed-falloff">
                  <option value="smooth">{tx(T.falloffSmooth)}</option>
                  <option value="linear">{tx(T.falloffLinear)}</option>
                  <option value="constant">{tx(T.falloffConstant)}</option>
                </select>
              </label>
              <div className="rig-row">
                <button type="button" className="btn btn-secondary btn-sm" onClick={normalize} disabled={disabled} data-testid="rig-ed-normalize">{tx(T.normalize)}</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={smoothBone} disabled={disabled || !sel} data-testid="rig-ed-smooth-bone">{tx(T.smoothBone)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={reweighSel} disabled={disabled || !sel} data-testid="rig-ed-auto-sel">{tx(T.reweighSel)}</button>
              </div>
              <div className="rig-row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => mirrorWeights('L')} disabled={disabled} data-testid="rig-ed-mirror-w-lr">{tx(T.mirrorWeightsLR)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => mirrorWeights('R')} disabled={disabled} data-testid="rig-ed-mirror-w-rl">{tx(T.mirrorWeightsRL)}</button>
              </div>
            </>
          )}

          {mode === 'pose' && (
            <>
              <div className="rig-ed-seg" role="radiogroup">
                <button type="button" role="radio" aria-checked={poseGizmo === 'rotate'} className={`rig-ed-segbtn${poseGizmo === 'rotate' ? ' is-active' : ''}`} onClick={() => setPoseGizmo('rotate')} data-testid="rig-ed-rotate">{tx(T.rotate)}</button>
                <button type="button" role="radio" aria-checked={poseGizmo === 'translate'} className={`rig-ed-segbtn${poseGizmo === 'translate' ? ' is-active' : ''}`} onClick={() => setPoseGizmo('translate')} data-testid="rig-ed-translate">{tx(T.move)}</button>
              </div>
              <div className="rig-row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={resetPose} data-testid="rig-ed-reset-pose">{tx(T.resetPose)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={copyPose} data-testid="rig-ed-copy">{tx(T.copyPose)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={pastePose} data-testid="rig-ed-paste">{tx(T.pastePose)}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={mirrorPose} data-testid="rig-ed-mirror-pose">{tx(T.mirrorPose)}</button>
              </div>
              <p className="field-hint">{tx(T.ikHint)}</p>
            </>
          )}
        </div>
      </div>

      {mode === 'pose' && (
        <div className="rig-section rig-ed-timeline" data-testid="rig-ed-timeline">
          <div className="rig-section-title">{tx(T.timeline)}</div>
          <div className="rig-ed-docprops">
            <label className="rig-ed-field grow">
              <span>{tx(T.clipName)}</span>
              <input className="input" defaultValue={doc.name} key={`name-${doc.name}`} onBlur={(e) => e.target.value.trim() && e.target.value !== doc.name && setDoc(engine.keys.setDocProps(docRef.current, { name: e.target.value.trim() }), 'rename clip')} data-testid="rig-ed-clip-name" />
            </label>
            <label className="rig-ed-field">
              <span>{tx(T.duration)}</span>
              <input className="input" type="number" min={0.1} max={600} step={0.1} defaultValue={doc.duration} key={`d-${doc.duration}`} onBlur={(e) => Number(e.target.value) !== doc.duration && setDoc(engine.keys.setDocProps(docRef.current, { duration: Number(e.target.value) || doc.duration }), 'duration')} data-testid="rig-ed-duration" />
            </label>
            <label className="rig-ed-field">
              <span>{tx(T.fps)}</span>
              <input className="input" type="number" min={1} max={120} step={1} defaultValue={doc.fps} key={`f-${doc.fps}`} onBlur={(e) => Number(e.target.value) !== doc.fps && setDoc(engine.keys.setDocProps(docRef.current, { fps: Number(e.target.value) || doc.fps }), 'fps')} data-testid="rig-ed-fps" />
            </label>
            <Toggle label={tx(T.loop)} checked={doc.loop} onChange={(v) => setDoc(engine.keys.setDocProps(docRef.current, { loop: v }), 'loop')} testId="rig-ed-loop" />
          </div>
          <div className="rig-transport">
            <button type="button" className="icon-btn" onClick={() => setPlaying((p) => !p)} disabled={!allKeyTimes.length} aria-label={playing ? 'Pause' : 'Play'} data-testid="rig-ed-play">
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => jumpKey(-1)} aria-label={tx(T.prevKey)} title={tx(T.prevKey)}>◆‹</button>
            <input type="range" className="range" min={0} max={doc.duration} step={1 / doc.fps} value={Math.min(time, doc.duration)} onChange={(e) => setTime(Number(e.target.value))} aria-label={tx(T.timeline)} data-testid="rig-ed-time" style={{ ['--pct' as string]: `${(Math.min(time, doc.duration) / doc.duration) * 100}%` }} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => jumpKey(1)} aria-label={tx(T.nextKey)} title={tx(T.nextKey)}>›◆</button>
            <span className="rig-time">{time.toFixed(2)} / {doc.duration.toFixed(2)}</span>
          </div>
          <KeyStrip
            doc={doc}
            label={tx(T.allBones)}
            times={allKeyTimes}
            time={time}
            onPick={setTime}
            onMove={(from, to) => setDoc(engine.keys.moveKeys(docRef.current, from, to), 'move keys')}
            testId="rig-ed-keys-all"
          />
          {sel && (
            <KeyStrip
              doc={doc}
              label={tx(T.keysOf, { name: sel.bone })}
              times={boneKeyTimes}
              time={time}
              onPick={setTime}
              onMove={(from, to) => setDoc(engine.keys.moveKeys(docRef.current, from, to, sel.bone), 'move key')}
              testId="rig-ed-keys-bone"
            />
          )}
          <div className="rig-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={keySelected} data-testid="rig-ed-key-sel">◆ {tx(T.keySel)}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={keyAll} data-testid="rig-ed-key-all">◆ {tx(T.keyAll)}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={deleteKey} disabled={!allKeyTimes.length} data-testid="rig-ed-key-del">{tx(T.deleteKey)}</button>
            <label className="rig-ed-field">
              <span>{tx(T.interp)}</span>
              <select className="select" value={interp} onChange={(e) => applyInterp(e.target.value as Interp)} data-testid="rig-ed-interp">
                <option value="smooth">{tx(T.smoothI)}</option>
                <option value="linear">{tx(T.linear)}</option>
                <option value="step">{tx(T.step)}</option>
              </select>
            </label>
          </div>
          <div className="rig-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={saveClip} disabled={!allKeyTimes.length} data-testid="rig-ed-save">{tx(T.save)}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDoc(engine.keys.newClipDoc(`Custom ${customClips.length + 1}`, 2, 30, true), 'new clip')} data-testid="rig-ed-new">{tx(T.newClip)}</button>
            {customClips.length > 0 && (
              <select className="select rig-ed-load" value="" onChange={(e) => { const c = customClips.find((x) => x.info.id === e.target.value); if (c) loadClip(c); }} aria-label={tx(T.load)} data-testid="rig-ed-load">
                <option value="">{tx(T.load)}…</option>
                {customClips.map((c) => <option key={c.info.id} value={c.info.id}>{c.info.name.en}</option>)}
              </select>
            )}
          </div>
          {notice && <p className="small muted" role="status" data-testid="rig-ed-notice">{notice}</p>}
        </div>
      )}

      {busy && <ProgressBar progress={busy} testId="rig-ed-busy" compact />}
      {error && (
        <div className="alert alert-danger" role="alert" data-testid="rig-ed-error">
          <IconAlert size={16} />
          <div className="alert-body">{tx(error)}</div>
        </div>
      )}
      <p className="field-hint rig-ed-shortcuts">{tx(T.shortcuts)}</p>
    </div>
  );
}

function Toggle({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {label}
    </label>
  );
}

function Slider({ label, min, max, step, value, onChange, testId }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="rig-speed">
      {label}
      <input type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} style={{ ['--pct' as string]: `${((value - min) / (max - min)) * 100}%` }} />
      <span className="tabular">{value.toFixed(2)}</span>
    </label>
  );
}

/** Numeric field committing on blur / Enter. */
function Num({ value, onCommit, label, disabled, testId }: { value: number; onCommit: (v: number) => void; label: string; disabled?: boolean; testId?: string }) {
  const commit = (s: string) => {
    const v = Number(s);
    if (Number.isFinite(v) && Math.abs(v - value) > 1e-9) onCommit(v);
  };
  return (
    <input
      className="input rig-ed-num"
      type="number"
      step={0.01}
      defaultValue={fmt(value)}
      aria-label={label}
      disabled={disabled}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
      data-testid={testId}
    />
  );
}

function BoneProps({
  bone, bones, disabled, onRename, onParent, onMove, onRole, onDeform,
}: {
  bone: BoneSpec;
  bones: BoneSpec[];
  disabled: boolean;
  onRename: (n: string) => void;
  onParent: (p: string) => void;
  onMove: (end: JointEnd, axis: 'x' | 'y' | 'z', v: number) => void;
  onRole: (r: BoneRole | undefined) => void;
  onDeform: (d: boolean) => void;
}) {
  const { tx } = useI18n();
  const role = bone.role;
  const below = useMemo(() => {
    const out = new Set([bone.name]);
    for (const b of bones) if (b.parent && out.has(b.parent)) out.add(b.name);
    return out;
  }, [bone.name, bones]);
  return (
    <div className="rig-ed-bone" data-testid="rig-ed-props">
      <label className="rig-ed-field">
        <span>{tx(T.name)}</span>
        <input
          className="input"
          defaultValue={bone.name}
          disabled={disabled}
          onBlur={(e) => onRename(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && onRename((e.target as HTMLInputElement).value.trim())}
          data-testid="rig-ed-name"
        />
      </label>
      {bone.parent !== null && (
        <label className="rig-ed-field">
          <span>{tx(T.parent)}</span>
          <select className="select" value={bone.parent} disabled={disabled} onChange={(e) => onParent(e.target.value)} data-testid="rig-ed-parent">
            {bones.filter((b) => !below.has(b.name)).map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
        </label>
      )}
      {(['head', 'tail'] as const).map((end) => (
        <div key={end} className="rig-ed-xyz">
          <span>{tx(end === 'head' ? T.head : T.tail)}</span>
          {(['x', 'y', 'z'] as const).map((a) => (
            <Num key={a} value={bone[end][a]} label={`${end} ${a}`} disabled={disabled} onCommit={(v) => onMove(end, a, v)} testId={`rig-ed-${end}-${a}`} />
          ))}
        </div>
      ))}
      <label className="rig-ed-check">
        <input type="checkbox" checked={bone.deform} disabled={disabled} onChange={(e) => onDeform(e.target.checked)} data-testid="rig-ed-deform" /> {tx(T.deform)}
      </label>
      <div className="rig-ed-role">
        <label className="rig-ed-field">
          <span>{tx(T.role)}</span>
          <select className="select" value={role?.part ?? ''} disabled={disabled} onChange={(e) => onRole(e.target.value ? { ...role, part: e.target.value as BoneRole['part'] } : undefined)} data-testid="rig-ed-role">
            <option value="">{tx(T.none)}</option>
            {ROLE_PARTS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {role && (
          <>
            <label className="rig-ed-field">
              <span>{tx(T.side)}</span>
              <select className="select" value={role.side ?? ''} disabled={disabled} onChange={(e) => onRole({ ...role, side: (e.target.value || undefined) as BoneRole['side'] })}>
                <option value="">{tx(T.none)}</option>
                <option value="L">L</option>
                <option value="R">R</option>
              </select>
            </label>
            <label className="rig-ed-field">
              <span>{tx(T.limb)}</span>
              <select className="select" value={role.limb ?? ''} disabled={disabled} onChange={(e) => onRole({ ...role, limb: (e.target.value || undefined) as BoneRole['limb'] })}>
                <option value="">{tx(T.none)}</option>
                <option value="front">front</option>
                <option value="hind">hind</option>
              </select>
            </label>
            <label className="rig-ed-field">
              <span>{tx(T.index)}</span>
              <input className="input rig-ed-num" type="number" min={0} max={50} step={1} defaultValue={role.index ?? 0} disabled={disabled} onBlur={(e) => Number(e.target.value) !== role.index && onRole({ ...role, index: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

/** One row of key diamonds: click to jump, drag to move. */
function KeyStrip({ doc, label, times, time, onPick, onMove, testId }: { doc: ClipDoc; label: string; times: number[]; time: number; onPick: (t: number) => void; onMove: (from: number, to: number) => void; testId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ from: number; id: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ from: number; to: number } | null>(null);
  const tAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(r.width, 1)));
    return Math.round(u * doc.duration * doc.fps) / doc.fps;
  };
  return (
    <div className="rig-ed-strip-row">
      <span className="rig-ed-strip-label truncate">{label}</span>
      <div
        ref={ref}
        className="rig-ed-strip"
        data-testid={testId}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).dataset.key) return;
          onPick(tAt(e.clientX));
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          d.moved = true;
          setGhost({ from: d.from, to: tAt(e.clientX) });
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setGhost(null);
          if (!d || d.id !== e.pointerId) return;
          const to = tAt(e.clientX);
          if (d.moved && Math.abs(to - d.from) > 1e-6) onMove(d.from, to);
          else onPick(d.from);
        }}
      >
        <span className="rig-ed-playhead" style={{ left: `${(time / doc.duration) * 100}%` }} />
        {times.map((t) => (
          <span
            key={t}
            className={`rig-ed-key${Math.abs(t - time) < 0.5 / doc.fps ? ' is-current' : ''}`}
            style={{ left: `${((ghost && Math.abs(ghost.from - t) < 1e-6 ? ghost.to : t) / doc.duration) * 100}%` }}
            data-key={t}
            data-testid={`${testId}-key`}
            title={`${t.toFixed(2)} s`}
            onPointerDown={(e) => {
              e.stopPropagation();
              drag.current = { from: t, id: e.pointerId, moved: false };
              try {
                ref.current?.setPointerCapture(e.pointerId);
              } catch {
                /* jsdom */
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
