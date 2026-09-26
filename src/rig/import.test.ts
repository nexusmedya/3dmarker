import { beforeAll, describe, expect, it } from 'vitest';
import { AnimationMixer, Quaternion, Vector3 } from 'three';
import type { AnimationClip } from 'three';
import { buildGeometryModel } from '../app/pipeline';
import { LocalizedError } from '../core/errors';
import { exportObject } from '../core/export/exporters';
import { buildLibrary } from './animations';
import { autoPlaceJoints } from './autoJoints';
import {
  classifyBoneName, detectFormat, importAnimationFile, mapSkeleton, parseAnimationFile, retargetAnimation, splitSide, stripBoneName,
} from './import';
import { rigModel } from './rig';
import { buildSkeleton, describeRig } from './skeleton';
import { asciiFbx, mixamoBones } from './fbxFixture';
import { makeMannequin } from './testing';
import type { HumanoidBone, JointLayout } from './types';

beforeAll(() => {
  if (typeof globalThis.FileReader !== 'undefined') return;
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((b) => {
        this.result = b;
        this.onloadend?.();
      });
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;
});

const layout = autoPlaceJoints(makeMannequin(1).mesh);
const rig = describeRig(layout);

function poseAt(l: JointLayout, clip: AnimationClip, t: number) {
  const sk = buildSkeleton(l);
  const mixer = new AnimationMixer(sk.root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  sk.root.updateMatrixWorld(true);
  const pos = (b: HumanoidBone) => new Vector3().setFromMatrixPosition(sk.byName.get(b)!.matrixWorld);
  return { sk, pos };
}

describe('bone name mapping', () => {
  it('strips namespaces and rig prefixes', () => {
    expect(stripBoneName('mixamorig:LeftArm')).toBe('LeftArm');
    expect(stripBoneName('mixamorigLeftArm')).toBe('LeftArm');
    expect(stripBoneName('mixamorig1_Hips')).toBe('Hips');
    expect(stripBoneName('Armature|Character1_LeftUpLeg')).toBe('LeftUpLeg');
    expect(stripBoneName('Bip01 L Thigh')).toBe('L Thigh');
    expect(stripBoneName('Back')).toBe('Back');
    expect(stripBoneName('RightArm')).toBe('RightArm');
    expect(stripBoneName('jaw')).toBe('jaw');
    expect(stripBoneName('DEF-upper_arm.L')).toBe('upper_arm.L');
  });

  it('reads sides from prefixes and suffixes', () => {
    expect(splitSide('LeftUpLeg')).toEqual({ side: 'Left', rest: 'UpLeg' });
    expect(splitSide('lShldr')).toEqual({ side: 'Left', rest: 'Shldr' });
    expect(splitSide('RHipJoint')).toEqual({ side: 'Right', rest: 'HipJoint' });
    expect(splitSide('upperarm_l')).toEqual({ side: 'Left', rest: 'upperarm' });
    expect(splitSide('forearm.R')).toEqual({ side: 'Right', rest: 'forearm' });
    expect(splitSide('Leg')).toEqual({ side: null, rest: 'Leg' });
    expect(splitSide('LowerBack')).toEqual({ side: null, rest: 'LowerBack' });
    expect(splitSide('Root')).toEqual({ side: null, rest: 'Root' });
  });

  it('classifies common conventions', () => {
    const c = (n: string) => classifyBoneName(n);
    expect(c('mixamorig:Hips')).toEqual({ kind: 'hips' });
    expect(c('pelvis')).toEqual({ kind: 'hips' });
    expect(c('spine_02')).toEqual({ kind: 'spine' });
    expect(c('LeftHandIndex2')).toEqual({ kind: 'finger', side: 'Left', finger: 'Index', n: 2 });
    expect(c('LeftHandIndex4')).toBe(null);
    expect(c('leftIndexIntermediate')).toEqual({ kind: 'finger', side: 'Left', finger: 'Index', n: 2 });
    expect(c('index_01_r')).toEqual({ kind: 'finger', side: 'Right', finger: 'Index', n: 1 });
    expect(c('LThumb')).toEqual({ kind: 'finger', side: 'Left', finger: 'Thumb', n: 1 });
    expect(c('calf_l')).toEqual({ kind: 'limb', side: 'Left', part: 'Leg' });
    expect(c('LeftUpperLeg')).toEqual({ kind: 'limb', side: 'Left', part: 'UpLeg' });
    expect(c('rForeArm')).toEqual({ kind: 'limb', side: 'Right', part: 'ForeArm' });
    expect(c('LHipJoint')).toBe(null);
    expect(c('HeadTop_End')).toEqual({ kind: 'headtop' });
    expect(c('Head')).toEqual({ kind: 'head' });
  });

  const nodes = (names: string[][]) => names.flatMap((level, depth) => level.map((name) => ({ name, depth })));

  it('Mixamo (FBX-sanitised names) maps one to one', () => {
    const m = mapSkeleton(nodes([
      ['mixamorigHips'], ['mixamorigSpine', 'mixamorigLeftUpLeg', 'mixamorigRightUpLeg'], ['mixamorigSpine1', 'mixamorigLeftLeg'],
      ['mixamorigSpine2', 'mixamorigLeftFoot'], ['mixamorigNeck', 'mixamorigLeftShoulder', 'mixamorigLeftToeBase'], ['mixamorigHead', 'mixamorigLeftArm'],
      ['mixamorigHeadTop_End', 'mixamorigLeftForeArm'], ['mixamorigLeftHand'], ['mixamorigLeftHandIndex1'],
    ]));
    expect(m.get('Hips')).toBe('mixamorigHips');
    expect(m.get('Spine2')).toBe('mixamorigSpine2');
    expect(m.get('LeftShoulder')).toBe('mixamorigLeftShoulder');
    expect(m.get('LeftArm')).toBe('mixamorigLeftArm');
    expect(m.get('LeftHandIndex1')).toBe('mixamorigLeftHandIndex1');
    expect(m.get('HeadTop_End')).toBe('mixamorigHeadTop_End');
  });

  it('classic BVH: Collar = clavicle, Shoulder = upper arm, Chest chain spread over the spine', () => {
    const m = mapSkeleton(nodes([
      ['Hips'], ['Chest', 'LeftHip'], ['Chest2', 'LeftKnee'], ['Chest3', 'LeftAnkle'], ['Chest4', 'LeftToe'], ['Neck', 'LeftCollar'],
      ['Head', 'LeftShoulder'], ['LeftElbow'], ['LeftWrist'],
    ]));
    expect(m.get('LeftShoulder')).toBe('LeftCollar');
    expect(m.get('LeftArm')).toBe('LeftShoulder');
    expect(m.get('LeftForeArm')).toBe('LeftElbow');
    expect(m.get('LeftHand')).toBe('LeftWrist');
    expect(m.get('LeftUpLeg')).toBe('LeftHip');
    expect(m.get('LeftLeg')).toBe('LeftKnee');
    expect(m.get('LeftFoot')).toBe('LeftAnkle');
    expect(m.get('LeftToeBase')).toBe('LeftToe');
    expect([m.get('Spine'), m.get('Spine1'), m.get('Spine2')]).toEqual(['Chest', 'Chest3', 'Chest4']);
  });

  it('CMU: LowerBack / Spine / Spine1 chain, Neck over Neck1, LHipJoint ignored', () => {
    const m = mapSkeleton(nodes([
      ['Hips'], ['LHipJoint', 'LowerBack'], ['LeftUpLeg', 'Spine'], ['LeftLeg', 'Spine1'], ['Neck', 'LeftShoulder'], ['Neck1', 'LeftArm'], ['Head'],
    ]));
    expect([m.get('Spine'), m.get('Spine1'), m.get('Spine2')]).toEqual(['LowerBack', 'Spine', 'Spine1']);
    expect(m.get('Neck')).toBe('Neck');
    expect(m.get('LeftShoulder')).toBe('LeftShoulder'); // no collar bones → clavicle
    expect([...m.values()]).not.toContain('LHipJoint');
  });

  it('Unreal / SecondLife names', () => {
    const ue = mapSkeleton(nodes([['pelvis'], ['spine_01', 'thigh_l'], ['spine_02', 'calf_l'], ['spine_03', 'foot_l'], ['clavicle_l', 'neck_01', 'ball_l'], ['upperarm_l', 'head'], ['lowerarm_l'], ['hand_l']]));
    expect(ue.get('Hips')).toBe('pelvis');
    expect(ue.get('LeftShoulder')).toBe('clavicle_l');
    expect(ue.get('LeftArm')).toBe('upperarm_l');
    expect(ue.get('LeftToeBase')).toBe('ball_l');
    const sl = mapSkeleton(nodes([['hip'], ['abdomen', 'lThigh'], ['chest', 'lShin'], ['neck', 'lCollar', 'lFoot'], ['head', 'lShldr'], ['lForeArm'], ['lHand']]));
    expect(sl.get('Hips')).toBe('hip');
    expect(sl.get('LeftShoulder')).toBe('lCollar');
    expect(sl.get('LeftArm')).toBe('lShldr');
    expect(sl.get('LeftLeg')).toBe('lShin');
  });
});

// Classic-named BVH, T-pose rest, arbitrary units (hips 50 above the toes).
function classicBvh(frames: number[][]): string {
  const limb = (side: 'Left' | 'Right') => {
    const s = side === 'Left' ? 1 : -1;
    return `
    JOINT ${side}Collar
    {
      OFFSET ${2 * s} 10 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT ${side}Shoulder
      {
        OFFSET ${5 * s} 0 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT ${side}Elbow
        {
          OFFSET ${15 * s} 0 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          JOINT ${side}Wrist
          {
            OFFSET ${13 * s} 0 0
            CHANNELS 3 Zrotation Xrotation Yrotation
            End Site
            {
              OFFSET ${8 * s} 0 0
            }
          }
        }
      }
    }`;
  };
  const leg = (side: 'Left' | 'Right') => {
    const s = side === 'Left' ? 1 : -1;
    return `
  JOINT ${side}Hip
  {
    OFFSET ${5 * s} -2 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT ${side}Knee
    {
      OFFSET 0 -23 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT ${side}Ankle
      {
        OFFSET 0 -22 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT ${side}Toe
        {
          OFFSET 0 -3 6
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0 0 3
          }
        }
      }
    }
  }`;
  };
  return `HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Chest
  {
    OFFSET 0 6 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Chest2
    {
      OFFSET 0 10 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT Neck
      {
        OFFSET 0 12 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT Head
        {
          OFFSET 0 5 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 0 10 0
          }
        }
      }${limb('Left')}${limb('Right')}
    }
  }${leg('Left')}${leg('Right')}
}
MOTION
Frames: ${frames.length}
Frame Time: 0.5
${frames.map((f) => f.join(' ')).join('\n')}
`;
}

/** 66 channels: root 6, then 20 joints × 3 (in hierarchy order). */
const JOINT_ORDER = ['Chest', 'Chest2', 'Neck', 'Head', 'LeftCollar', 'LeftShoulder', 'LeftElbow', 'LeftWrist', 'RightCollar', 'RightShoulder', 'RightElbow', 'RightWrist', 'LeftHip', 'LeftKnee', 'LeftAnkle', 'LeftToe', 'RightHip', 'RightKnee', 'RightAnkle', 'RightToe'];
function frame(pos: [number, number, number], rot: Record<string, [number, number, number]> = {}): number[] {
  const out = [...pos, 0, 0, 0];
  for (const j of JOINT_ORDER) out.push(...(rot[j] ?? [0, 0, 0]));
  return out;
}

describe('BVH import', () => {
  const text = classicBvh([
    frame([0, 50, 0]),
    frame([0, 50, 10], { LeftShoulder: [-90, 0, 0], LeftHip: [0, -45, 0] }),
    frame([0, 50, 0]),
  ]);
  const file = new Blob([text]);

  it('retargets rotations by direction and scales the hips by leg length', async () => {
    const [imp] = await importAnimationFile(file, 'dance.bvh', rig);
    expect(imp.info.source).toBe('imported');
    expect(imp.info.duration).toBeCloseTo(1, 5);
    expect(imp.info.name.en).toBe('dance');
    expect(imp.info.category).toBe('dance');
    expect(imp.clip.tracks.some((t) => t.name === 'LeftArm.quaternion')).toBe(true);
    expect(imp.source.mapping.get('LeftArm')).toBe('LeftShoulder');

    const mid = poseAt(layout, imp.clip, 0.5);
    const arm = mid.pos('LeftForeArm').sub(mid.pos('LeftArm')).normalize();
    expect(arm.y).toBeLessThan(-0.97); // arm down
    const thigh = mid.pos('LeftLeg').sub(mid.pos('LeftUpLeg')).normalize();
    expect(thigh.z).toBeGreaterThan(0.6); // leg forward
    expect(thigh.y).toBeCloseTo(-Math.SQRT1_2, 1);
    const right = mid.pos('RightForeArm').sub(mid.pos('RightArm')).normalize();
    expect(right.x).toBeLessThan(-0.97); // untouched arm stays in T-pose

    // Hips: 10 units of 45-unit legs forward → 10/45 of our leg length.
    const hips = mid.sk.byName.get('Hips')!.position;
    expect(hips.z - layout.Hips!.z).toBeCloseTo((10 / 45) * rig.legLength, 2);
    const start = poseAt(layout, imp.clip, 0).sk.byName.get('Hips')!.position;
    expect(start.y).toBeCloseTo(layout.Hips!.y, 1);
    expect(imp.info.loop).toBe(true);
  });

  it('an A-pose file still drives a T-pose rig to the right directions', async () => {
    // Same motion authored on a skeleton whose rest has the arms 45° down.
    const aText = text.replace(/OFFSET 5 0 0\n(\s+)CHANNELS 3 Zrotation Xrotation Yrotation\n(\s+)JOINT LeftElbow\n(\s+)\{\n(\s+)OFFSET 15 0 0/,
      (_m, a, b, c, d) => `OFFSET 5 0 0\n${a}CHANNELS 3 Zrotation Xrotation Yrotation\n${b}JOINT LeftElbow\n${c}{\n${d}OFFSET 10.6066 -10.6066 0`);
    expect(aText).not.toBe(text);
    const [imp] = await importAnimationFile(new Blob([aText]), 'a.bvh', rig);
    // Frame 0: no rotation → the file's rest (A-pose) → our arm 45° down.
    const p = poseAt(layout, imp.clip, 0);
    const arm = p.pos('LeftForeArm').sub(p.pos('LeftArm')).normalize();
    expect(arm.y).toBeCloseTo(-Math.SQRT1_2, 1);
    expect(arm.x).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('removes root drift in place, keeps it on request', async () => {
    const drift = new Blob([classicBvh([frame([0, 50, 0]), frame([0, 50, 20]), frame([0, 50, 40])])]);
    const [src] = await parseAnimationFile(drift, 'walk.bvh');
    const inPlace = retargetAnimation(src, rig);
    const keep = retargetAnimation(src, rig, { inPlace: false });
    const endZ = (c: AnimationClip) => {
      const t = c.tracks.find((x) => x.name === 'Hips.position')!;
      return t.values[t.values.length - 1];
    };
    expect(endZ(inPlace.clip)).toBeCloseTo(layout.Hips!.z, 5);
    expect(endZ(keep.clip) - layout.Hips!.z).toBeCloseTo((40 / 45) * rig.legLength, 2);
    expect(inPlace.info.category).toBe('locomotion');
  });

  it('a feetless file whose rest skeleton stands at the origin keeps the hips at their rest height', async () => {
    // Legs end at the knee-less "Leg" joint (no foot → no floor); frames carry the standing height (44).
    const bvh = `HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Spine
  {
    OFFSET 0 8 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Neck
    {
      OFFSET 0 14 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      End Site
      {
        OFFSET 0 8 0
      }
    }
    JOINT LeftArm
    {
      OFFSET 6 12 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      End Site
      {
        OFFSET 20 0 0
      }
    }
  }
  JOINT LeftUpLeg
  {
    OFFSET 4 -2 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT LeftLeg
    {
      OFFSET 0 -20 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      End Site
      {
        OFFSET 0 -20 0
      }
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 44 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
0 46 0 0 0 0 0 0 0 40 0 0 0 0 0 0 0 0 0 0 0
0 44 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
`;
    const [imp] = await importAnimationFile(new Blob([bvh]), 'flap.bvh', rig);
    const track = imp.clip.tracks.find((t) => t.name === 'Hips.position')!;
    expect(track.values[1]).toBeCloseTo(layout.Hips!.y, 5);
    // The 2-unit bob stays a small bob (scaled by the skeleton ratio), not a 44-unit lift.
    const mid = Array.from(track.times).findIndex((t) => Math.abs(t - 0.5) < 1e-3);
    expect(mid).toBeGreaterThan(0);
    const bob = track.values[mid * 3 + 1] - layout.Hips!.y;
    expect(bob).toBeGreaterThan(0.02 * rig.legLength);
    expect(bob).toBeLessThan(0.15 * rig.legLength);
  });

  it('rejects bad input with bilingual errors', async () => {
    await expect(parseAnimationFile(new Blob([]), 'x.bvh')).rejects.toBeInstanceOf(LocalizedError);
    await expect(parseAnimationFile(new Blob(['hello']), 'x.txt')).rejects.toMatchObject({ i18n: { tr: expect.any(String), en: expect.stringContaining('Unsupported') } });
    await expect(parseAnimationFile(new Blob(['HIERARCHY\nROOT']), 'x.bvh')).rejects.toBeInstanceOf(LocalizedError);
    await expect(parseAnimationFile(new Blob([text]), 'x.bvh', { maxMB: 0.0001 })).rejects.toMatchObject({ i18n: { en: expect.stringContaining('too large') } });
    const odd = text.replace(/Chest2|Chest|Neck|Head|Left|Right|Hips/g, (s) => `Q${s.length}x`);
    await expect(parseAnimationFile(new Blob([odd]), 'odd.bvh')).rejects.toMatchObject({ i18n: { en: expect.stringContaining('not recognised') } });
  });

  it('detects formats by extension or content', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(detectFormat('a.BVH', enc(''))).toBe('bvh');
    expect(detectFormat('a', enc('HIERARCHY\n'))).toBe('bvh');
    expect(detectFormat('a', enc('Kaydara FBX Binary  \0'))).toBe('fbx');
    expect(detectFormat('a', enc('glTF'))).toBe('gltf');
    expect(detectFormat('a.gltf', enc('{'))).toBe('gltf');
    expect(detectFormat('a.png', enc('\x89PNG'))).toBe(null);
  });
});

describe('FBX import (Mixamo naming, centimetres)', () => {
  it('retargets a Mixamo-style clip and names it after the file', async () => {
    const text = asciiFbx(mixamoBones(), { LeftArm: [[0, 0, 0, 0], [1, 0, 0, -90]] }, [[0, 0, 100, 0], [1, 0, 100, 17]]);
    const file = new Blob([text]);
    const [imp] = await importAnimationFile(file, 'Mixamo Walking.fbx', rig, { inPlace: false });
    expect(imp.info.name.en).toBe('Mixamo Walking');
    expect(imp.info.category).toBe('locomotion');
    expect(imp.source.format).toBe('fbx');
    expect(imp.source.mapping.get('LeftArm')).toBe('mixamorigLeftArm');
    const end = poseAt(layout, imp.clip, 0.9999);
    const arm = end.pos('LeftForeArm').sub(end.pos('LeftArm')).normalize();
    expect(arm.y).toBeLessThan(-0.97);
    // 17 cm of 85 cm legs.
    expect(end.sk.byName.get('Hips')!.position.z - layout.Hips!.z).toBeCloseTo((17 / 85) * rig.legLength, 2);
    const start = poseAt(layout, imp.clip, 0);
    expect(start.pos('LeftForeArm').sub(start.pos('LeftArm')).normalize().x).toBeGreaterThan(0.97);
  });

  it('PreRotation in the rest pose is honoured (the rest shape is reproduced)', async () => {
    const bones = mixamoBones().map((b) => (b.name === 'LeftForeArm' ? { ...b, pre: [0, 0, -30] as [number, number, number] } : b));
    const [imp] = await importAnimationFile(new Blob([asciiFbx(bones, { Spine: [[0, 0, 0, 0], [1, 10, 0, 0]] })]), 'bent.fbx', rig);
    const p = poseAt(layout, imp.clip, 0);
    const fore = p.pos('LeftHand').sub(p.pos('LeftForeArm')).normalize();
    expect(fore.y).toBeCloseTo(-0.5, 1); // bent 30° down like the file's rest
    expect(fore.x).toBeCloseTo(Math.sqrt(3) / 2, 1);
  });
});

describe('GLB round trip', () => {
  it('our exported animation re-imports onto the same rig unchanged', async () => {
    const { mesh } = makeMannequin(1);
    const model = buildGeometryModel(mesh.geometry, null);
    const r = await rigModel(null, model);
    const walk = buildLibrary(r.descriptor).find((c) => c.info.id === 'walk')!.clip;
    const glb = await exportObject(model.object, 'glb', { animations: [walk] });
    const [imp] = await importAnimationFile(glb, 'walk.glb', r.descriptor);
    expect(imp.info.name.en).toBe('walk');
    for (const t of [0, 0.3, 0.7]) {
      const a = poseAt(r.layout, walk, t), b = poseAt(r.layout, imp.clip, t);
      for (const bone of ['LeftUpLeg', 'LeftLeg', 'RightArm', 'Spine2', 'Head'] as HumanoidBone[]) {
        const qa = a.sk.byName.get(bone)!.quaternion, qb = b.sk.byName.get(bone)!.quaternion;
        expect(Math.abs(qa.dot(qb)), `${bone} @${t}`).toBeGreaterThan(0.999);
      }
      expect(a.pos('LeftFoot').distanceTo(b.pos('LeftFoot'))).toBeLessThan(0.05);
    }
    r.unrig();
    void Quaternion;
  });
});
