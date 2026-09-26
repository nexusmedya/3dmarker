/**
 * Built-in procedural clips (45). Angles in degrees relative to the T-pose,
 * hips offsets in hip heights; conventions in ./dsl.ts. Poses are authored
 * for the left side and mirrored with `sym` / `mirrorPose` / `cycle`.
 */
import { curl, cycle, key, merge, mirrorClip, mirrorPose, stance, sym, type ClipDef, type Deg3, type KeyDef, type Pose } from './dsl';

// ---------------------------------------------------------------------------
// Shared poses

const HANDS_RELAXED = sym(curl(0.15));
const FISTS = sym(curl(1));
const HANDS_OPEN = sym(curl(0));

/** Standing, arms hanging at the sides. */
const RELAX: Pose = merge(
  sym({ LeftShoulder: [0, 0, -4], LeftArm: [0, -2, -76], LeftForeArm: [0, -14, 0], LeftHand: [0, -6, -4] }),
  HANDS_RELAXED,
);

const breathe = (p: Pose, amount = 1): Pose =>
  merge(p, {
    Spine1: [(p.Spine1?.[0] ?? 0) - 1.5 * amount, p.Spine1?.[1] ?? 0, p.Spine1?.[2] ?? 0],
    Spine2: [(p.Spine2?.[0] ?? 0) - 2 * amount, p.Spine2?.[1] ?? 0, p.Spine2?.[2] ?? 0],
    Head: [(p.Head?.[0] ?? 0) + 1.5 * amount, p.Head?.[1] ?? 0, p.Head?.[2] ?? 0],
    ...sym({ LeftShoulder: [0, 0, (p.LeftShoulder?.[2] ?? 0) + 1.5 * amount] }),
  });

const GUARD_STANCE = stance(15, 28);
const GUARD: Pose = merge(
  GUARD_STANCE.pose,
  sym({ LeftArm: [0, -35, -62], LeftForeArm: [0, -125, 25], LeftHand: [0, 0, 0] }),
  FISTS,
  { Hips: [0, -12, 0], Spine: [6, 4, 0], Spine2: [0, 6, 0], Head: [6, 0, 0] },
);
const GUARD_DY = GUARD_STANCE.dy;

const SEATED: Pose = merge(
  sym({ LeftUpLeg: [-90, 0, 4], LeftLeg: [90, 0, 0], LeftFoot: [0, 0, -4] }),
  sym({ LeftShoulder: [0, 0, -3], LeftArm: [0, -45, -62], LeftForeArm: [0, -35, 0], LeftHand: [0, 0, -10] }),
  HANDS_RELAXED,
  { Spine: [6, 0, 0], Spine2: [-3, 0, 0] },
);
const SEATED_HIPS: Deg3 = [0, -0.47, -0.12];

const ARMS_UP: Pose = sym({ LeftArm: [0, -5, 84], LeftForeArm: [0, 0, 14] });

const clip = (id: string, en: string, tr: string, category: ClipDef['category'], duration: number, loop: boolean, keys: KeyDef[]): ClipDef => ({
  id,
  name: { tr, en },
  category,
  duration,
  loop,
  keys,
});

// ---------------------------------------------------------------------------
// Idle & poses

const idleBreathe = clip('idle-breathe', 'Idle (breathing)', 'Bekleme (nefes)', 'idle', 4, true, [
  key(0, RELAX),
  key(0.5, breathe(RELAX), [0, 0.006, 0]),
]);

const idleLook = clip('idle-look', 'Idle – look around', 'Bekleme – etrafa bakma', 'idle', 6, true, [
  key(0, RELAX),
  key(0.18, merge(RELAX, { Neck: [0, 12, 0], Head: [2, 24, 0], Spine2: [0, 5, 0] })),
  key(0.34, merge(breathe(RELAX), { Neck: [0, 12, 0], Head: [4, 26, -3], Spine2: [0, 5, 0] })),
  key(0.52, merge(RELAX, { Neck: [0, -12, 0], Head: [-2, -26, 3], Spine2: [0, -5, 0] })),
  key(0.7, merge(breathe(RELAX), { Neck: [0, -10, 0], Head: [0, -22, 0], Spine2: [0, -4, 0] })),
  key(0.85, merge(RELAX, { Neck: [-4, 0, 0], Head: [-14, 0, 0] })),
]);

const boredA: Pose = merge(RELAX, {
  Hips: [0, 0, -4],
  Spine: [0, 0, 3],
  Spine1: [0, 0, 2],
  Head: [0, 0, 4],
  RightUpLeg: [-6, 0, 0],
  RightLeg: [14, 0, 0],
  RightFoot: [-6, 0, 0],
});
const idleBored = clip('idle-bored', 'Idle – bored (weight shift)', 'Bekleme – sıkılmış (ağırlık aktarma)', 'idle', 6, true, [
  key(0, boredA, [0.03, 0, 0]),
  key(0.28, merge(breathe(boredA, 2.5), sym({ LeftShoulder: [0, 0, 6] }), { Head: [-8, 0, 4] }), [0.03, 0.006, 0]),
  key(0.5, mirrorPose(boredA), [-0.03, 0, 0]),
  key(0.78, merge(mirrorPose(boredA), { Head: [10, -12, -4], LeftArm: [0, 8, -70] }), [-0.03, 0, 0]),
]);

const APOSE: Pose = merge(sym({ LeftArm: [0, -3, -45], LeftForeArm: [0, -8, 0] }), HANDS_RELAXED);
const aPose = clip('a-pose', 'A-pose (relaxed)', 'A-pozu (rahat)', 'pose', 3, true, [key(0, APOSE), key(0.5, breathe(APOSE))]);

const tPose = clip('t-pose', 'T-pose (bind pose)', 'T-pozu (bağlama pozu)', 'pose', 1, true, [key(0, HANDS_OPEN)]);

const TREE: Pose = merge(
  ARMS_UP,
  HANDS_OPEN,
  { RightUpLeg: [-35, 0, -58], RightLeg: [125, 0, 0], RightFoot: [30, 0, 0], LeftLeg: [2, 0, 0], Hips: [0, 0, -2] },
);
const yogaTree = clip('yoga-tree', 'Yoga tree pose', 'Yoga ağaç duruşu', 'pose', 4, true, [
  key(0, TREE, [0.04, 0, 0]),
  key(0.5, merge(breathe(TREE), { Hips: [0, 0, -4], Spine1: [0, 0, 3] }), [0.05, 0.004, 0]),
]);

const FLY: Pose = merge(
  { Hips: [85, 0, 0], Head: [-60, 0, 0], Neck: [-10, 0, 0] },
  { RightArm: [0, 5, -85], RightForeArm: [0, 0, 0], LeftArm: [0, 0, -80], LeftForeArm: [0, -10, 0] },
  sym(curl(1, ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'])),
  { LeftLeg: [25, 0, 0], LeftFoot: [30, 0, 0], RightFoot: [30, 0, 0], RightUpLeg: [0, 0, -3] },
);
const fly = clip('fly', 'Fly (superhero)', 'Uçuş (süper kahraman)', 'pose', 3, true, [
  key(0, FLY, [0, 0.35, 0]),
  key(0.5, merge(FLY, { Hips: [82, 0, 2], LeftLeg: [30, 0, 0] }), [0, 0.42, 0]),
]);

const sitDown = clip('sit-down', 'Sit down', 'Otur', 'action', 1.6, false, [
  key(0, RELAX),
  key(0.45, merge(RELAX, sym({ LeftUpLeg: [-50, 0, 0], LeftLeg: [55, 0, 0], LeftFoot: [-5, 0, 0], LeftArm: [0, -35, -60] }), { Spine: [25, 0, 0] }), [0, -0.2, -0.08]),
  key(1, SEATED, SEATED_HIPS),
]);

const sitIdle = clip('sit-idle', 'Sitting idle', 'Oturarak bekleme', 'idle', 4, true, [
  key(0, SEATED, SEATED_HIPS),
  key(0.5, merge(breathe(SEATED), { Head: [2, 8, 0], LeftArm: [0, -44, -61] }), SEATED_HIPS),
]);

const stretch = clip('stretch', 'Stretch', 'Esneme', 'idle', 4, true, [
  key(0, RELAX),
  key(0.3, merge(ARMS_UP, HANDS_OPEN, sym({ LeftFoot: [18, 0, 0] }), { Spine: [-6, 0, 0], Spine2: [-6, 0, 0], Head: [-14, 0, 0] }), [0, 0.04, 0]),
  key(0.5, merge(sym({ LeftArm: [0, -3, 88], LeftForeArm: [0, 0, 6] }), HANDS_OPEN, sym({ LeftFoot: [20, 0, 0] }), { Spine: [-7, 0, 0], Spine2: [-7, 0, 0], Head: [-16, 0, 0] }), [0, 0.045, 0]),
  key(0.72, merge(ARMS_UP, HANDS_OPEN, { Spine1: [0, 0, -12], Spine2: [0, 0, -10] })),
]);

// ---------------------------------------------------------------------------
// Locomotion

const walk = clip('walk', 'Walk', 'Yürüme', 'locomotion', 1.1, true, cycle([
  key(0, merge(RELAX, {
    Hips: [0, -6, 0], Spine: [2, 3, 0], Spine2: [0, 5, 0],
    LeftUpLeg: [-24, 0, 0], LeftLeg: [4, 0, 0], LeftFoot: [-12, 0, 0],
    RightUpLeg: [16, 0, 0], RightLeg: [12, 0, 0], RightFoot: [18, 0, 0],
    LeftArm: [0, 22, -76], LeftForeArm: [0, -10, 0],
    RightArm: [0, 24, 76], RightForeArm: [0, 25, 0],
  }), [0, -0.025, 0]),
  key(0.25, merge(RELAX, {
    Hips: [0, 0, 2],
    LeftUpLeg: [-2, 0, 0], LeftLeg: [6, 0, 0],
    RightUpLeg: [-12, 0, 0], RightLeg: [42, 0, 0], RightFoot: [6, 0, 0],
    LeftArm: [0, 2, -77], RightArm: [0, -2, 77],
  }), [0.015, 0.01, 0]),
]));

const run = clip('run', 'Run', 'Koşma', 'locomotion', 0.7, true, cycle([
  key(0, merge(FISTS, {
    Hips: [4, -10, 0], Spine: [8, 4, 0], Spine2: [2, 8, 0], Head: [-8, 0, 0],
    LeftUpLeg: [-42, 0, 0], LeftLeg: [18, 0, 0], LeftFoot: [-8, 0, 0],
    RightUpLeg: [22, 0, 0], RightLeg: [40, 0, 0], RightFoot: [25, 0, 0],
    LeftArm: [0, 38, -70], LeftForeArm: [0, -75, 0],
    RightArm: [0, 40, 70], RightForeArm: [0, 95, 0],
  }), [0, -0.04, 0]),
  key(0.25, merge(FISTS, {
    Hips: [4, 0, 0], Spine: [8, 0, 0], Head: [-8, 0, 0],
    LeftUpLeg: [-12, 0, 0], LeftLeg: [35, 0, 0], LeftFoot: [5, 0, 0],
    RightUpLeg: [-38, 0, 0], RightLeg: [105, 0, 0], RightFoot: [10, 0, 0],
    LeftArm: [0, 5, -72], LeftForeArm: [0, -85, 0],
    RightArm: [0, 5, 72], RightForeArm: [0, 85, 0],
  }), [0, 0.04, 0]),
]));

const jogInPlace = clip('jog-in-place', 'Jog in place', 'Yerinde koşu', 'locomotion', 0.8, true, cycle([
  key(0, merge(FISTS, {
    LeftUpLeg: [-55, 0, 0], LeftLeg: [75, 0, 0], LeftFoot: [15, 0, 0],
    RightUpLeg: [0, 0, 0], RightLeg: [5, 0, 0],
    LeftArm: [0, 25, -72], LeftForeArm: [0, -90, 0],
    RightArm: [0, 30, 72], RightForeArm: [0, 90, 0],
    Spine: [4, 0, 0],
  }), [0, 0.02, 0]),
  key(0.25, merge(FISTS, sym({ LeftUpLeg: [-12, 0, 0], LeftLeg: [18, 0, 0], LeftFoot: [-6, 0, 0], LeftArm: [0, 0, -74], LeftForeArm: [0, -90, 0] }), { Spine: [4, 0, 0] }), [0, -0.03, 0]),
]));

const SNEAK_BASE: Pose = merge(
  sym({ LeftArm: [0, -25, -55], LeftForeArm: [0, -75, 20], LeftHand: [0, 0, -30] }),
  HANDS_RELAXED,
  { Spine: [18, 0, 0], Spine1: [6, 0, 0], Neck: [-4, 0, 0], Head: [-18, 0, 0] },
);
const sneak = clip('sneak', 'Sneak (tiptoe)', 'Sinsice yürüme', 'locomotion', 1.6, true, cycle([
  key(0, merge(SNEAK_BASE, {
    Hips: [0, -8, 0],
    LeftUpLeg: [-40, 0, 0], LeftLeg: [35, 0, 0], LeftFoot: [-5, 0, 0],
    RightUpLeg: [5, 0, 0], RightLeg: [40, 0, 0], RightFoot: [20, 0, 0],
  }), [0, -0.12, 0]),
  key(0.25, merge(SNEAK_BASE, {
    LeftUpLeg: [-15, 0, 0], LeftLeg: [30, 0, 0], LeftFoot: [-10, 0, 0],
    RightUpLeg: [-45, 0, 0], RightLeg: [80, 0, 0], RightFoot: [25, 0, 0],
  }), [0, -0.09, 0]),
]));

const march = clip('march', 'March', 'Marş adımı', 'locomotion', 1, true, cycle([
  key(0, merge(FISTS, {
    Spine2: [-3, 0, 0],
    LeftUpLeg: [-70, 0, 0], LeftLeg: [70, 0, 0], LeftFoot: [10, 0, 0],
    RightUpLeg: [3, 0, 0],
    LeftArm: [0, 35, -75], LeftForeArm: [0, -5, 0],
    RightArm: [0, 70, 45], RightForeArm: [0, 15, 0],
  }), [0, 0.015, 0]),
  key(0.25, merge(FISTS, sym({ LeftArm: [0, 0, -78], LeftForeArm: [0, -5, 0] }), { Spine2: [-3, 0, 0] }), [0, -0.01, 0]),
]));

const ZOMBIE_BASE: Pose = merge(
  sym({ LeftArm: [0, -82, -5], LeftForeArm: [0, 0, -8], LeftHand: [0, 0, -25] }),
  HANDS_RELAXED,
  { Spine: [10, 0, 0], Head: [15, 0, 14] },
);
const zombieWalk = clip('zombie-walk', 'Zombie walk', 'Zombi yürüyüşü', 'locomotion', 1.8, true, cycle([
  key(0, merge(ZOMBIE_BASE, {
    Hips: [0, -8, -4], Spine2: [0, 8, 4],
    LeftUpLeg: [-18, 0, 0], LeftLeg: [8, 0, 0], LeftFoot: [-6, 0, 0],
    RightUpLeg: [10, 0, 0], RightLeg: [15, 0, 0], RightFoot: [20, 0, 0],
  }), [0.01, -0.03, 0]),
  key(0.25, merge(ZOMBIE_BASE, { Hips: [0, 0, 5], RightUpLeg: [-8, 0, 0], RightLeg: [25, 0, 0], RightFoot: [5, 0, 0] }), [0.02, 0, 0]),
]));

const swim = clip('swim', 'Swim in place', 'Yerinde yüzme', 'locomotion', 1.6, true, [
  key(0, merge(sym({ LeftArm: [0, -85, 5], LeftForeArm: [0, 0, 0], LeftUpLeg: [-5, 0, 4], LeftLeg: [5, 0, 0], LeftFoot: [30, 0, 0] }), HANDS_OPEN, { Hips: [20, 0, 0], Head: [-20, 0, 0] }), [0, 0.03, 0]),
  key(0.3, merge(sym({ LeftArm: [0, -20, 0], LeftForeArm: [0, -20, 0], LeftUpLeg: [-20, 0, 12], LeftLeg: [40, 0, 0], LeftFoot: [10, 0, 0] }), HANDS_OPEN, { Hips: [20, 0, 0], Head: [-22, 0, 0] }), [0, 0, 0]),
  key(0.55, merge(sym({ LeftArm: [0, -30, -40], LeftForeArm: [0, -120, 0], LeftUpLeg: [-50, 0, 30], LeftLeg: [95, 0, 0], LeftFoot: [-20, 0, 0] }), HANDS_OPEN, { Hips: [20, 0, 0], Head: [-25, 0, 0] }), [0, -0.03, 0]),
  key(0.8, merge(sym({ LeftArm: [0, -80, -10], LeftForeArm: [0, -30, 0], LeftUpLeg: [-10, 0, 25], LeftLeg: [10, 0, 0], LeftFoot: [30, 0, 0] }), HANDS_OPEN, { Hips: [20, 0, 0], Head: [-20, 0, 0] }), [0, 0.02, 0]),
]);

// ---------------------------------------------------------------------------
// Action

const crouch = stance(60, 100);
const land = stance(50, 85);
const jump = clip('jump', 'Jump', 'Zıplama', 'action', 1.2, false, [
  key(0, RELAX),
  key(0.2, merge(crouch.pose, sym({ LeftArm: [0, 55, -60], LeftForeArm: [0, -10, 0] }), HANDS_RELAXED, { Spine: [30, 0, 0] }), [0, crouch.dy, -0.05]),
  key(0.35, merge(sym({ LeftUpLeg: [5, 0, 0], LeftLeg: [0, 0, 0], LeftFoot: [35, 0, 0], LeftArm: [0, -30, 75], LeftForeArm: [0, 0, 5] }), HANDS_OPEN, { Spine: [-5, 0, 0] }), [0, 0.1, 0]),
  key(0.55, merge(sym({ LeftUpLeg: [-30, 0, 0], LeftLeg: [50, 0, 0], LeftFoot: [10, 0, 0], LeftArm: [0, -20, 70] }), HANDS_OPEN), [0, 0.45, 0]),
  key(0.75, merge(land.pose, sym({ LeftArm: [0, -40, -45], LeftForeArm: [0, -20, 0] }), HANDS_RELAXED, { Spine: [25, 0, 0] }), [0, land.dy, 0]),
  key(1, RELAX),
]);

const hopCrouch = stance(25, 50);
const hop = clip('hop', 'Hop', 'Sekme', 'action', 0.6, true, [
  key(0, merge(RELAX, stance(8, 16).pose), [0, stance(8, 16).dy, 0]),
  key(0.2, merge(RELAX, hopCrouch.pose, { Spine: [8, 0, 0] }), [0, hopCrouch.dy, 0]),
  key(0.55, merge(RELAX, sym({ LeftFoot: [25, 0, 0], LeftArm: [0, -10, -60] })), [0, 0.15, 0]),
  key(0.85, merge(RELAX, hopCrouch.pose, { Spine: [8, 0, 0] }), [0, hopCrouch.dy, 0]),
]);

const deep = stance(95, 120);
const ARMS_FORWARD: Pose = sym({ LeftArm: [0, -85, 0], LeftForeArm: [0, 0, 0] });
const squat = clip('squat', 'Squat', 'Squat (çömelme)', 'action', 2.4, true, [
  key(0, merge(ARMS_FORWARD, HANDS_OPEN)),
  // Arms stay level while the torso leans 35° forward.
  key(0.5, merge(sym({ LeftArm: [0, -85, 32], LeftForeArm: [0, 0, 0] }), HANDS_OPEN, deep.pose, { Hips: [20, 0, 0], Spine: [15, 0, 0], Head: [-20, 0, 0] }), [0, deep.dy, -0.05]),
]);

const jacksAir: Pose = merge(sym({ LeftArm: [0, 0, 0], LeftForeArm: [0, 0, 0], LeftUpLeg: [0, 0, 10], LeftFoot: [15, 0, -10] }), HANDS_OPEN);
const jumpingJacks = clip('jumping-jacks', 'Jumping jacks', 'Zıplayarak açılıp kapanma', 'action', 1.2, true, [
  key(0, merge(RELAX, HANDS_OPEN)),
  key(0.25, jacksAir, [0, 0.07, 0]),
  key(0.5, merge(ARMS_UP, HANDS_OPEN, stance(0, 0, 20).pose), [0, stance(0, 0, 20).dy, 0]),
  key(0.75, jacksAir, [0, 0.07, 0]),
]);

const punchCombo = clip('punch-combo', 'Punch combo', 'Yumruk kombinasyonu', 'action', 1.6, true, [
  key(0, GUARD, [0, GUARD_DY, 0]),
  key(0.12, merge(GUARD, { LeftArm: [0, -88, -4], LeftForeArm: [0, -4, 0], Spine2: [0, -12, 0] }), [0, GUARD_DY, 0.02]),
  key(0.25, GUARD, [0, GUARD_DY, 0]),
  key(0.42, merge(GUARD, { RightArm: [0, 88, 4], RightForeArm: [0, 4, 0], Spine2: [0, 25, 0], Hips: [0, 5, 0], RightLeg: [15 + 28, 0, 0], RightFoot: [20 - 13, 0, 0] }), [0, GUARD_DY, 0.03]),
  key(0.56, GUARD, [0, GUARD_DY, 0]),
  key(0.72, merge(GUARD, { LeftArm: [0, -60, 0], LeftForeArm: [0, -100, 0], Spine2: [0, -25, 0], Hips: [0, -25, 0] }), [0, GUARD_DY, 0]),
  key(0.86, GUARD, [0, GUARD_DY, 0]),
]);

const kick = clip('kick', 'Front kick', 'Ön tekme', 'action', 1.4, true, [
  key(0, GUARD, [0, GUARD_DY, 0]),
  key(0.3, merge(GUARD, { RightUpLeg: [-85, 0, 0], RightLeg: [105, 0, 0], RightFoot: [20, 0, 0], LeftLeg: [10, 0, 0], Spine: [-5, 0, 0] }), [0, -0.02, 0]),
  key(0.45, merge(GUARD, { RightUpLeg: [-88, 0, 0], RightLeg: [5, 0, 0], RightFoot: [30, 0, 0], LeftLeg: [8, 0, 0], Spine: [-18, 0, 0], Hips: [-5, -12, 0] }), [0, -0.02, 0]),
  key(0.6, merge(GUARD, { RightUpLeg: [-80, 0, 0], RightLeg: [100, 0, 0], RightFoot: [20, 0, 0], LeftLeg: [10, 0, 0] }), [0, -0.02, 0]),
  key(0.8, GUARD, [0, GUARD_DY, 0]),
]);

const READY: Pose = merge(GUARD, { RightArm: [0, 45, 55], RightForeArm: [0, 60, 0], LeftArm: [0, -55, -45], LeftForeArm: [0, -70, 0] });
const slash = clip('slash', 'Sword slash', 'Kılıç savurma', 'action', 1.4, true, [
  key(0, READY, [0, GUARD_DY, 0]),
  key(0.25, merge(READY, { RightArm: [0, 30, -50], RightForeArm: [0, 60, -30], LeftArm: [0, -75, 35], LeftForeArm: [0, -60, 20], Spine2: [0, -25, 0], Hips: [0, -22, 0] }), [0, GUARD_DY, 0]),
  key(0.45, merge(READY, { RightArm: [0, 80, 40], RightForeArm: [0, 20, 0], LeftArm: [0, -20, -55], LeftForeArm: [0, -30, 0], Spine: [12, 0, 0], Spine2: [0, 25, 0], Hips: [0, 10, 0] }), [0, GUARD_DY - 0.05, 0.02]),
  key(0.7, merge(READY, { RightArm: [0, 75, 40], RightForeArm: [0, 25, 0], LeftArm: [0, -25, -55], Spine: [10, 0, 0], Spine2: [0, 20, 0] }), [0, GUARD_DY - 0.04, 0.02]),
]);

const SPIN_POSE: Pose = merge(sym({ LeftArm: [0, -10, -45], LeftForeArm: [0, -20, 0] }), HANDS_OPEN, {
  RightUpLeg: [-10, 0, -8], RightLeg: [70, 0, 0], RightFoot: [30, 0, 0], LeftFoot: [15, 0, 0],
});
const spin = clip('spin', 'Spin', 'Kendi etrafında dönme', 'action', 1.2, true, [0, 90, 180, 270, 360].map((deg, i) =>
  key(i / 4, merge(SPIN_POSE, { Hips: [0, deg, 0] }), [0, 0.03, 0])));

const fallDie = clip('fall-die', 'Fall down (die)', 'Yere düşme (ölme)', 'action', 2, false, [
  key(0, RELAX),
  key(0.15, merge(RELAX, sym({ LeftArm: [0, 20, 10] }), { Spine: [-12, 0, 0], Spine1: [-5, 0, 0], Head: [-25, 0, 0] }), [0, 0, -0.03]),
  key(0.4, merge(RELAX, stance(45, 80).pose, sym({ LeftArm: [0, -10, -70] }), { Hips: [5, 0, 0], Spine: [20, 0, 0], Head: [15, 0, 0] }), [0, stance(45, 80).dy, -0.05]),
  key(0.65, merge(RELAX, sym({ LeftUpLeg: [-40, 0, 0], LeftLeg: [40, 0, 0], LeftArm: [0, 10, -20] }), { Hips: [-50, 0, 0], Spine: [-5, 0, 0] }), [0, -0.5, -0.25]),
  key(1, merge(HANDS_RELAXED, sym({ LeftUpLeg: [0, 0, 6], LeftLeg: [3, 0, 0], LeftFoot: [20, 0, 0], LeftArm: [0, 5, -15], LeftForeArm: [0, -20, 0] }), { Hips: [-90, 0, 0], Head: [-8, 18, 0] }), [0, -0.9, -0.35]),
]);

// ---------------------------------------------------------------------------
// Gestures & emotes

const WAVE_ARM: Pose = merge(RELAX, { LeftArm: [0, -15, 25], LeftHand: [0, 0, 0], Spine2: [0, 0, 3] }, curl(0));
const waveLeft = clip('wave-left', 'Wave (left hand)', 'El sallama (sol el)', 'gesture', 1.6, true,
  [70, 100, 70, 45].map((z, i) => key(i / 4, merge(WAVE_ARM, { LeftForeArm: [0, -10, z] }))));
const waveRight = mirrorClip(waveLeft, 'wave-right', { tr: 'El sallama (sağ el)', en: 'Wave (right hand)' });
const waveBoth = clip('wave-both', 'Wave (both hands)', 'İki elle sallama', 'gesture', 1.6, true,
  [70, 100, 70, 45].map((z, i) => key(i / 4, merge(sym({ LeftArm: [0, -15, 25], LeftForeArm: [0, -10, z] }), HANDS_OPEN, { Head: [-4, 0, 0] }))));

const clapOpen: Pose = merge(sym({ LeftArm: [0, -60, -20], LeftForeArm: [-80, -45, 5] }), HANDS_OPEN);
const clapShut: Pose = merge(sym({ LeftArm: [0, -62, -20], LeftForeArm: [-80, -72, 5] }), HANDS_OPEN, { Head: [4, 0, 0] });
const clap = clip('clap', 'Clap', 'Alkış', 'gesture', 0.8, true, [key(0, clapOpen), key(0.4, clapShut), key(0.5, clapShut)]);

const POINT_L: Pose = merge(RELAX, { LeftArm: [0, -80, 5], LeftForeArm: [0, -3, 0], LeftHand: [0, 0, 0], Spine2: [0, -8, 0], Head: [0, 8, 0] }, curl(0, ['Index']), curl(1, ['Middle', 'Ring', 'Pinky']), curl(0.6, ['Thumb']));
const pointLeft = clip('point', 'Point forward', 'İleriyi gösterme', 'gesture', 2, true, [key(0, RELAX), key(0.3, POINT_L), key(0.8, POINT_L)]);
const point = mirrorClip(pointLeft, 'point', { tr: 'İleriyi gösterme', en: 'Point forward' });

// Elbow out to the side, hand at the temple.
const SALUTE_L: Pose = merge(RELAX, { LeftArm: [0, -29, 3], LeftForeArm: [0, -157, 42], LeftHand: [0, 10, 0], Spine2: [-4, 0, 0], Head: [-3, 0, 0] }, curl(0));
const saluteLeft = clip('salute', 'Salute', 'Selam durma', 'gesture', 2.5, true, [key(0, RELAX), key(0.25, SALUTE_L), key(0.75, SALUTE_L)]);
const salute = mirrorClip(saluteLeft, 'salute', { tr: 'Selam durma', en: 'Salute' });

const BOW: Pose = merge(RELAX, { Hips: [8, 0, 0], Spine: [15, 0, 0], Spine1: [15, 0, 0], Spine2: [10, 0, 0], Neck: [6, 0, 0], Head: [4, 0, 0] });
const bow = clip('bow', 'Bow', 'Reverans (eğilme)', 'gesture', 2.4, true, [key(0, RELAX), key(0.35, BOW, [0, -0.01, -0.04]), key(0.65, BOW, [0, -0.01, -0.04])]);

const nodYes = clip('nod-yes', 'Nod (yes)', 'Baş sallama (evet)', 'gesture', 1.2, true,
  [0, 16, 0, 13].map((x, i) => key(i / 4, merge(RELAX, { Neck: [x / 3, 0, 0], Head: [x, 0, 0] }))));
const shakeNo = clip('shake-no', 'Shake head (no)', 'Baş sallama (hayır)', 'gesture', 1.2, true,
  [0, 28, 0, -28].map((y, i) => key(i / 4, merge(RELAX, { Neck: [0, y / 4, 0], Head: [0, y, 0] }))));

const SHRUG: Pose = merge(RELAX, sym({ LeftShoulder: [0, 0, 14], LeftArm: [0, -15, -58], LeftForeArm: [-70, -55, 0], LeftHand: [0, 0, 15] }), HANDS_OPEN, { Head: [0, 0, -8], Neck: [0, 0, -4] });
const shrug = clip('shrug', 'Shrug', 'Omuz silkme', 'emote', 1.8, true, [key(0, RELAX), key(0.35, SHRUG), key(0.65, SHRUG)]);

// Elbow in front of the chest, hand under the chin; the other arm across the belly.
const THINK_L: Pose = merge(RELAX, {
  LeftArm: [0, -78, -44], LeftForeArm: [0, -151, 27], LeftHand: [0, -20, 10],
  RightArm: [0, 35, 70], RightForeArm: [0, 105, 0],
  Head: [10, 0, 8],
}, curl(0.5, ['Index', 'Middle', 'Ring', 'Pinky']));
const thinkLeft = clip('think', 'Think (hand on chin)', 'Düşünme (el çenede)', 'emote', 4, true, [
  key(0, THINK_L),
  key(0.5, merge(THINK_L, { Head: [12, 6, 10], Spine2: [3, 0, 0] })),
]);
const think = mirrorClip(thinkLeft, 'think', thinkLeft.name);

// Hand over the (bowed) face.
const FACEPALM_L: Pose = merge(RELAX, { LeftArm: [0, -79, -18], LeftForeArm: [0, -153, 38], LeftHand: [0, -15, 0], Head: [28, 0, 0], Neck: [8, 0, 0], Spine2: [8, 0, 0] }, curl(0));
const facepalmLeft = clip('facepalm', 'Facepalm', 'Avuçla yüzü kapama', 'emote', 3, true, [
  key(0, RELAX),
  key(0.3, FACEPALM_L),
  key(0.8, merge(FACEPALM_L, { Head: [30, -4, 0] })),
]);
const facepalm = mirrorClip(facepalmLeft, 'facepalm', facepalmLeft.name);

const cheer = clip('cheer', 'Cheer', 'Tezahürat', 'emote', 1.2, true, [
  key(0, merge(sym({ LeftArm: [0, -10, 55], LeftForeArm: [0, 0, 15] }), FISTS, { Head: [-6, 0, 0] })),
  key(0.5, merge(sym({ LeftArm: [0, -10, 75], LeftForeArm: [0, 0, 8] }), FISTS, { Spine2: [-8, 0, 0], Head: [-12, 0, 0] }), [0, 0.04, 0]),
]);

const victory = clip('victory', 'Victory', 'Zafer', 'emote', 2, true, [
  key(0, merge(sym({ LeftArm: [0, -5, 50], LeftForeArm: [0, 0, 30] }), FISTS, { Head: [-15, 0, 0], Spine2: [-5, 0, 0] })),
  key(0.25, merge(sym({ LeftArm: [0, -5, 72], LeftForeArm: [0, 0, 5] }), FISTS, { Head: [-18, 0, 0], Spine2: [-8, 0, 0] }), [0, 0.03, 0]),
  key(0.5, merge(sym({ LeftArm: [0, -5, 50], LeftForeArm: [0, 0, 30] }), FISTS, { Head: [-15, 0, 0], Spine2: [-5, 0, 0] })),
  key(0.75, merge(sym({ LeftArm: [0, -5, 72], LeftForeArm: [0, 0, 5] }), FISTS, { Head: [-18, 0, 0], Spine2: [-8, 0, 0] }), [0, 0.03, 0]),
]);

// ---------------------------------------------------------------------------
// Dance

const hipSway = clip('dance-hip-sway', 'Dance – hip sway', 'Dans – kalça sallama', 'dance', 2, true, cycle([
  key(0, merge(HANDS_RELAXED, {
    Hips: [0, 0, -8], Spine: [0, 0, 6], Spine1: [0, 0, 4],
    RightUpLeg: [-8, 0, 0], RightLeg: [15, 0, 0], RightFoot: [-7, 0, 0],
    LeftArm: [0, 10, -60], LeftForeArm: [0, -40, 0], RightArm: [0, -20, 55], RightForeArm: [0, 50, 0],
  }), [0.05, -0.01, 0]),
  key(0.25, merge(HANDS_RELAXED, stance(10, 20).pose, sym({ LeftArm: [0, -5, -60], LeftForeArm: [0, -45, 0] })), [0, stance(10, 20).dy - 0.01, 0]),
]));

const pumpA: Pose = merge(FISTS, stance(15, 30).pose, { LeftArm: [0, -20, 65], LeftForeArm: [0, 0, 25], RightArm: [0, 25, 35], RightForeArm: [0, 95, 0], Head: [-5, 8, 0] });
const armPump = clip('dance-arm-pump', 'Dance – arm pump', 'Dans – kol pompalama', 'dance', 1, true, cycle([
  key(0, pumpA, [0, stance(15, 30).dy, 0]),
  key(0.25, merge(FISTS, stance(25, 50).pose, sym({ LeftArm: [0, -20, 10], LeftForeArm: [0, -60, 0] })), [0, stance(25, 50).dy, 0]),
]));

const twistStance = stance(25, 45);
const twist = clip('dance-twist', 'Dance – twist', 'Dans – twist', 'dance', 1, true, cycle([
  key(0, merge(twistStance.pose, sym({ LeftArm: [0, 10, -45], LeftForeArm: [0, -90, 0] }), FISTS, { Hips: [0, 28, 0], Spine: [0, -12, 0], Spine2: [0, -22, 0] }), [0, twistStance.dy, 0]),
  key(0.25, merge(twistStance.pose, sym({ LeftArm: [0, 10, -45], LeftForeArm: [0, -90, 0] }), FISTS), [0, twistStance.dy - 0.02, 0]),
]));

const R1: Pose = merge(HANDS_OPEN, { LeftArm: [0, 0, -5], LeftForeArm: [0, 0, 90], RightArm: [0, 0, 5], RightForeArm: [0, 0, 90], Head: [0, 30, 0] });
const R2: Pose = merge(HANDS_OPEN, { LeftArm: [0, -90, -5], LeftForeArm: [0, 0, 90], RightArm: [0, 0, 80], RightForeArm: [0, 0, 0], Spine2: [0, -15, 0], Head: [0, 0, 0] });
const robot = clip('robot-dance', 'Robot dance', 'Robot dansı', 'dance', 2, true, [
  key(0, R1),
  key(0.2, R1),
  key(0.25, R2, [0, -0.02, 0]),
  key(0.45, R2, [0, -0.02, 0]),
  key(0.5, mirrorPose(R1)),
  key(0.7, mirrorPose(R1)),
  key(0.75, mirrorPose(R2), [0, -0.02, 0]),
  key(0.95, mirrorPose(R2), [0, -0.02, 0]),
]);

const DISCO_UP: Pose = merge(
  { RightArm: [0, 15, -55], RightForeArm: [0, 0, 0], LeftArm: [0, 25, -40], LeftForeArm: [0, 0, -85], Hips: [0, 0, 6], LeftLeg: [10, 0, 0], Head: [-15, -20, 0] },
  curl(0, ['Index'], 'Right'), curl(1, ['Middle', 'Ring', 'Pinky'], 'Right'), curl(0.6, ['Thumb'], 'Right'), curl(0.3),
);
const DISCO_DOWN: Pose = merge(DISCO_UP, { RightArm: [0, 70, 45], Head: [15, 15, 0], Hips: [0, 0, -4], LeftLeg: [0, 0, 0], RightLeg: [10, 0, 0] });
const disco = clip('disco-point', 'Disco point', 'Disko işaret', 'dance', 2, true, [
  key(0, DISCO_UP, [-0.03, 0, 0]),
  key(0.25, DISCO_DOWN, [0.02, -0.01, 0]),
  key(0.5, DISCO_UP, [-0.03, 0, 0]),
  key(0.75, DISCO_DOWN, [0.02, -0.01, 0]),
]);

/** Every built-in clip definition, in catalogue order. */
export const CLIP_DEFS: ClipDef[] = [
  idleBreathe, idleLook, idleBored, sitIdle, stretch,
  walk, run, jogInPlace, sneak, march, zombieWalk, swim,
  waveRight, waveLeft, waveBoth, clap, point, salute, bow, nodYes, shakeNo,
  cheer, victory, shrug, think, facepalm,
  hipSway, armPump, twist, robot, disco,
  jump, hop, squat, jumpingJacks, punchCombo, kick, slash, spin, fallDie, sitDown,
  aPose, tPose, yogaTree, fly,
];
