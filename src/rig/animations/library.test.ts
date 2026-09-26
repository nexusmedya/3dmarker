import { describe, expect, it } from 'vitest';
import { AnimationMixer, Vector3 } from 'three';
import type { AnimationClip } from 'three';
import { autoPlaceJoints } from '../autoJoints';
import { isHumanoidBone } from '../bones';
import { buildSkeleton, describeRig, type RigSkeleton } from '../skeleton';
import { makeMannequin } from '../testing';
import { ANIMATION_CATEGORIES, type HumanoidBone, type JointLayout, type RigClip } from '../types';
import { buildLibrary, CLIP_DEFS, channelSampler, mirrorPose, stance, sym } from '.';

const mannequin = makeMannequin(1);
const layout = autoPlaceJoints(mannequin.mesh);
const rig = describeRig(layout);
const library = buildLibrary(rig);
const byId = new Map(library.map((c) => [c.info.id, c]));

/** World joint positions of a fresh skeleton posed by `clip` at `t` seconds. */
function poseAt(l: JointLayout, clip: AnimationClip, t: number): Record<HumanoidBone, Vector3> {
  const sk: RigSkeleton = buildSkeleton(l);
  const mixer = new AnimationMixer(sk.root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  sk.root.updateMatrixWorld(true);
  const out = {} as Record<HumanoidBone, Vector3>;
  for (const [name, bone] of sk.byName) out[name] = new Vector3().setFromMatrixPosition(bone.matrixWorld);
  return out;
}

describe('built-in animation library', () => {
  it('has at least 36 clips with unique ids, bilingual names and valid categories', () => {
    expect(CLIP_DEFS.length).toBeGreaterThanOrEqual(36);
    expect(new Set(CLIP_DEFS.map((d) => d.id)).size).toBe(CLIP_DEFS.length);
    const cats = new Set(ANIMATION_CATEGORIES.map((c) => c.id));
    for (const d of CLIP_DEFS) {
      expect(d.name.tr && d.name.en, d.id).toBeTruthy();
      expect(cats.has(d.category), d.id).toBe(true);
      expect(d.duration).toBeGreaterThan(0);
    }
    for (const c of ANIMATION_CATEGORIES) expect(CLIP_DEFS.some((d) => d.category === c.id), c.id).toBe(true);
  });

  it('includes the requested repertoire', () => {
    for (const id of [
      'idle-breathe', 'idle-look', 'idle-bored', 'a-pose', 'walk', 'run', 'jog-in-place', 'sneak', 'march', 'jump', 'hop', 'squat',
      'jumping-jacks', 'wave-right', 'wave-both', 'clap', 'cheer', 'point', 'salute', 'bow', 'nod-yes', 'shake-no', 'shrug', 'think',
      'facepalm', 'victory', 'dance-hip-sway', 'dance-arm-pump', 'dance-twist', 'robot-dance', 'disco-point', 'punch-combo', 'kick',
      'slash', 'spin', 'fall-die', 'sit-down', 'sit-idle', 'fly', 'zombie-walk', 'swim', 'yoga-tree', 'stretch',
    ]) expect(byId.has(id), id).toBe(true);
  });

  it('every clip: tracks for existing bones, duration > 0, no NaN, unit quaternions, info attached', () => {
    const bones = new Set<string>(rig.bones);
    for (const { clip, info } of library) {
      expect(clip.duration, info.id).toBeGreaterThan(0);
      expect(info.source).toBe('builtin');
      expect(clip.userData.info).toBe(info);
      expect(clip.tracks.length, info.id).toBeGreaterThan(0);
      expect(clip.validate(), info.id).toBe(true);
      for (const track of clip.tracks) {
        const [bone, prop] = track.name.split('.');
        expect(isHumanoidBone(bone) && bones.has(bone), track.name).toBe(true);
        expect(['quaternion', 'position']).toContain(prop);
        if (prop === 'position') expect(bone).toBe('Hips');
        expect(Array.from(track.values).every(Number.isFinite), `${info.id} ${track.name}`).toBe(true);
        expect(track.times[track.times.length - 1]).toBeCloseTo(clip.duration, 5);
        if (prop === 'quaternion') {
          for (let i = 0; i < track.values.length; i += 4) {
            const v = track.values;
            expect(Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3])).toBeCloseTo(1, 4);
          }
        }
      }
    }
  });

  it('loop clips are seamless: first and last keyframes are the same pose', () => {
    for (const { clip, info } of library) {
      if (!info.loop) continue;
      for (const track of clip.tracks) {
        const n = track.times.length;
        const size = track.getValueSize();
        const first = Array.from(track.values.slice(0, size));
        const last = Array.from(track.values.slice((n - 1) * size, n * size));
        if (size === 4) {
          const dot = first.reduce((s, v, i) => s + v * last[i], 0);
          expect(Math.abs(dot), `${info.id} ${track.name}`).toBeCloseTo(1, 5);
        } else {
          for (let i = 0; i < size; i++) expect(last[i], `${info.id} ${track.name}`).toBeCloseTo(first[i], 6);
        }
      }
    }
  });

  it('quaternion tracks are sign-continuous (a spin does not flip back)', () => {
    const spin = byId.get('spin')!.clip.tracks.find((t) => t.name === 'Hips.quaternion')!;
    const v = spin.values;
    for (let i = 4; i < v.length; i += 4) {
      const dot = v[i] * v[i - 4] + v[i + 1] * v[i - 3] + v[i + 2] * v[i - 2] + v[i + 3] * v[i - 1];
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('clip semantics (forward kinematics on the mannequin rig)', () => {
  const rest = poseAt(layout, byId.get('t-pose')!.clip, 0);
  const height = rest.HeadTop_End.y - Math.min(rest.LeftToeBase.y, rest.RightToeBase.y);
  const at = (id: string, u: number) => {
    const c: RigClip = byId.get(id)!;
    return poseAt(layout, c.clip, Math.min(u, 0.9999) * c.clip.duration); // t = duration wraps to 0
  };

  it('T-pose clip keeps the rest pose', () => {
    for (const b of rig.bones) {
      const p = layout[b]!;
      expect(rest[b].distanceTo(new Vector3(p.x, p.y, p.z)), b).toBeLessThan(1e-4);
    }
  });

  it('relaxed idle lowers the arms along the body', () => {
    const p = at('idle-breathe', 0);
    expect(p.LeftHand.y).toBeLessThan(p.LeftArm.y - 0.2 * height);
    expect(p.RightHand.y).toBeLessThan(p.RightArm.y - 0.2 * height);
    expect(p.LeftHand.x).toBeGreaterThan(0);
    expect(p.RightHand.x).toBeLessThan(0);
  });

  it('walk: the left leg is forward at t = 0 and the right half a cycle later', () => {
    const a = at('walk', 0), b = at('walk', 0.5);
    expect(a.LeftFoot.z).toBeGreaterThan(a.RightFoot.z + 0.05 * height);
    expect(b.RightFoot.z).toBeGreaterThan(b.LeftFoot.z + 0.05 * height);
    // Arms swing opposite to the legs.
    expect(a.RightHand.z).toBeGreaterThan(a.LeftHand.z);
  });

  it('wave-right raises the right hand above the shoulder', () => {
    const p = at('wave-right', 0.25);
    expect(p.RightHand.y).toBeGreaterThan(p.RightArm.y + 0.1 * height);
    expect(p.LeftHand.y).toBeLessThan(p.LeftArm.y);
  });

  it('squat keeps the feet on the ground while the hips drop', () => {
    const p = at('squat', 0.5);
    const ground = Math.min(rest.LeftToeBase.y, rest.RightToeBase.y);
    expect(p.Hips.y).toBeLessThan(rest.Hips.y - 0.3 * rig.hipHeight);
    expect(Math.abs(p.LeftFoot.y - rest.LeftFoot.y)).toBeLessThan(0.08 * height);
    expect(Math.min(p.LeftToeBase.y, p.RightToeBase.y)).toBeGreaterThan(ground - 0.08 * height);
  });

  it('grounded clips: no foot sinks through the floor and the feet touch it (sampled over the whole clip, two layouts)', () => {
    const tall = structuredClone(layout);
    for (const b of Object.keys(tall) as HumanoidBone[]) tall[b]!.y *= 1.3; // longer legs than the canonical proportions
    for (const l of [layout, tall]) {
      const lib = buildLibrary(describeRig(l));
      const H = l.HeadTop_End!.y - Math.min(l.LeftToeBase!.y, l.RightToeBase!.y);
      for (const def of CLIP_DEFS) {
        if (def.grounded === false) continue;
        const clip = lib.find((c) => c.info.id === def.id)!.clip;
        const sk = buildSkeleton(l);
        const mixer = new AnimationMixer(sk.root);
        mixer.clipAction(clip).play();
        let lowest = Infinity;
        for (let i = 0; i < 60; i++) {
          mixer.setTime((i / 60) * clip.duration);
          sk.root.updateMatrixWorld(true);
          let frame = Infinity;
          for (const b of ['LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase'] as const) {
            frame = Math.min(frame, new Vector3().setFromMatrixPosition(sk.byName.get(b)!.matrixWorld).y - l[b]!.y);
          }
          lowest = Math.min(lowest, frame);
        }
        expect(lowest / H, `${def.id} sinks`).toBeGreaterThan(-0.015);
        expect(lowest / H, `${def.id} never touches the floor`).toBeLessThan(0.01);
      }
    }
  });

  it('sit-down ends seated (thighs forward, hips at knee height)', () => {
    const p = at('sit-down', 1);
    expect(p.LeftLeg.z - p.LeftUpLeg.z).toBeGreaterThan(0.3 * rig.hipHeight);
    expect(Math.abs(p.LeftLeg.y - p.LeftUpLeg.y)).toBeLessThan(0.1 * rig.hipHeight);
  });

  it('fall-die ends lying on the back', () => {
    const p = at('fall-die', 1);
    const ground = Math.min(rest.LeftToeBase.y, rest.RightToeBase.y);
    expect(p.Head.y - ground).toBeLessThan(0.25 * height);
    expect(p.Head.z).toBeLessThan(p.Hips.z - 0.2 * height);
  });

  it('jump reaches above the rest height at its apex', () => {
    expect(at('jump', 0.55).Hips.y).toBeGreaterThan(rest.Hips.y + 0.3 * rig.hipHeight);
  });

  it('A-posed rigs: clips still reach their intended pose (rest-aware transfer)', () => {
    // Rotate each arm chain 45° down around its shoulder.
    const a: JointLayout = structuredClone(layout);
    for (const side of ['Left', 'Right'] as const) {
      const s = a[`${side}Arm`]!;
      for (const b of [`${side}ForeArm`, `${side}Hand`] as const) {
        const p = a[b]!;
        const dx = p.x - s.x, dy = p.y - s.y;
        const r = Math.hypot(dx, dy), ang = -Math.PI / 4;
        const sign = side === 'Left' ? 1 : -1;
        a[b] = { x: s.x + sign * r * Math.cos(ang), y: s.y + r * Math.sin(ang), z: p.z };
        void dx;
      }
    }
    const aRig = describeRig(a);
    const lib = buildLibrary(aRig);
    const tpose = poseAt(a, lib.find((c) => c.info.id === 't-pose')!.clip, 0);
    expect(Math.abs(tpose.LeftHand.y - tpose.LeftArm.y)).toBeLessThan(0.02 * height);
    expect(tpose.LeftHand.x).toBeGreaterThan(tpose.LeftArm.x + 0.25 * height);
    const wave = poseAt(a, lib.find((c) => c.info.id === 'wave-right')!.clip, 0.4);
    expect(wave.RightHand.y).toBeGreaterThan(wave.RightArm.y + 0.1 * height);
  });
});

describe('DSL helpers', () => {
  it('mirrorPose swaps sides and negates y / z', () => {
    expect(mirrorPose({ LeftArm: [1, 2, 3], Head: [4, 5, 6] })).toEqual({ RightArm: [1, -2, -3], Head: [4, -5, -6] });
    expect(sym({ LeftArm: [1, 2, 3] })).toEqual({ LeftArm: [1, 2, 3], RightArm: [1, -2, -3] });
  });

  it('stance keeps a straight leg at zero drop', () => {
    expect(stance(0, 0).dy).toBeCloseTo(0, 6);
    expect(stance(60, 100).dy).toBeLessThan(-0.2);
  });

  it('monotone Hermite: no overshoot at holds, wraps drift for loops', () => {
    const s = channelSampler({ times: [0, 0.3, 0.6, 1], values: [0, 10, 10, 0], loop: true });
    for (let u = 0; u <= 1; u += 0.01) expect(s(u)).toBeLessThanOrEqual(10 + 1e-9);
    const spin = channelSampler({ times: [0, 0.25, 0.5, 0.75, 1], values: [0, 90, 180, 270, 360], loop: true });
    expect(spin(0.125)).toBeCloseTo(45, 0);
    expect(spin(0.01)).toBeGreaterThan(0);
  });
});
