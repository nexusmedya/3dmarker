/**
 * Test fixture: a tiny ASCII FBX 7.4 file with a Mixamo-named skeleton
 * ("mixamorig:" namespace, centimetres, T-pose) and one animation stack.
 */
const KTIME = 46186158000;

interface FbxBone {
  name: string;
  parent: string | null;
  /** Lcl Translation (cm). */
  t: [number, number, number];
  /** Optional PreRotation (degrees). */
  pre?: [number, number, number];
}

const S = (side: 'Left' | 'Right') => (side === 'Left' ? 1 : -1);

export function mixamoBones(): FbxBone[] {
  const b: FbxBone[] = [
    { name: 'Hips', parent: null, t: [0, 100, 0] },
    { name: 'Spine', parent: 'Hips', t: [0, 10, 0] },
    { name: 'Spine1', parent: 'Spine', t: [0, 12, 0] },
    { name: 'Spine2', parent: 'Spine1', t: [0, 13, 0] },
    { name: 'Neck', parent: 'Spine2', t: [0, 15, 0] },
    { name: 'Head', parent: 'Neck', t: [0, 10, 0] },
  ];
  for (const side of ['Left', 'Right'] as const) {
    const s = S(side);
    b.push(
      { name: `${side}Shoulder`, parent: 'Spine2', t: [6 * s, 10, 0] },
      { name: `${side}Arm`, parent: `${side}Shoulder`, t: [12 * s, 0, 0] },
      { name: `${side}ForeArm`, parent: `${side}Arm`, t: [28 * s, 0, 0] },
      { name: `${side}Hand`, parent: `${side}ForeArm`, t: [25 * s, 0, 0] },
      { name: `${side}UpLeg`, parent: 'Hips', t: [9 * s, -5, 0] },
      { name: `${side}Leg`, parent: `${side}UpLeg`, t: [0, -43, 0] },
      { name: `${side}Foot`, parent: `${side}Leg`, t: [0, -42, 0] },
      { name: `${side}ToeBase`, parent: `${side}Foot`, t: [0, -8, 12] },
    );
  }
  return b;
}

/** Keyframes: bone → [time s, x°, y°, z°][] on "Lcl Rotation"; hips translation keys optional. */
export function asciiFbx(
  bones: FbxBone[],
  rot: Record<string, [number, number, number, number][]>,
  hipsT: [number, number, number, number][] = [],
  duration = 1,
): string {
  const ids = new Map<string, number>();
  bones.forEach((b, i) => ids.set(b.name, 1000 + i));
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);
  p('; FBX 7.4.0 project file');
  p('FBXHeaderExtension:  {');
  p('\tFBXHeaderVersion: 1003');
  p('\tFBXVersion: 7400');
  p('}');
  p('GlobalSettings:  {');
  p('\tVersion: 1000');
  p('\tProperties70:  {');
  p('\t\tP: "UpAxis", "int", "Integer", "",1');
  p('\t\tP: "UnitScaleFactor", "double", "Number", "",1');
  p('\t}');
  p('}');
  p('Objects:  {');
  for (const b of bones) {
    p(`\tModel: ${ids.get(b.name)}, "Model::mixamorig:${b.name}", "LimbNode" {`);
    p('\t\tVersion: 232');
    p('\t\tProperties70:  {');
    if (b.pre) p(`\t\t\tP: "PreRotation", "Vector3D", "Vector", "",${b.pre.join(',')}`);
    p(`\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${b.t.join(',')}`);
    p('\t\t}');
    p('\t}');
  }
  p('\tAnimationStack: 5000, "AnimStack::mixamo.com", "" {');
  p('\t\tProperties70:  {');
  p(`\t\t\tP: "LocalStop", "KTime", "Time", "",${Math.round(duration * KTIME)}`);
  p('\t\t}');
  p('\t}');
  p('\tAnimationLayer: 5001, "AnimLayer::BaseLayer", "" {');
  p('\t}');
  const conns: string[] = [];
  let nextId = 6000;
  const curve = (keys: [number, number][], node: number, axis: string) => {
    const id = nextId++;
    p(`\tAnimationCurve: ${id}, "AnimCurve::", "" {`);
    p('\t\tDefault: 0');
    p('\t\tKeyVer: 4009');
    p(`\t\tKeyTime: *${keys.length} {`);
    p(`\t\t\ta: ${keys.map((k) => Math.round(k[0] * KTIME)).join(',')}`);
    p('\t\t}');
    p(`\t\tKeyValueFloat: *${keys.length} {`);
    p(`\t\t\ta: ${keys.map((k) => k[1]).join(',')}`);
    p('\t\t}');
    p('\t}');
    conns.push(`\tC: "OP",${id},${node}, "d|${axis}"`);
  };
  const curveNode = (attr: 'R' | 'T', model: number, keys: [number, number, number, number][]) => {
    const id = nextId++;
    p(`\tAnimationCurveNode: ${id}, "AnimCurveNode::${attr}", "" {`);
    p('\t\tProperties70:  {');
    p('\t\t\tP: "d|X", "Number", "", "A",0');
    p('\t\t\tP: "d|Y", "Number", "", "A",0');
    p('\t\t\tP: "d|Z", "Number", "", "A",0');
    p('\t\t}');
    p('\t}');
    conns.push(`\tC: "OO",${id},5001`);
    conns.push(`\tC: "OP",${id},${model}, "${attr === 'R' ? 'Lcl Rotation' : 'Lcl Translation'}"`);
    (['X', 'Y', 'Z'] as const).forEach((axis, k) => curve(keys.map((key) => [key[0], key[k + 1]]), id, axis));
  };
  for (const [name, keys] of Object.entries(rot)) curveNode('R', ids.get(name)!, keys);
  if (hipsT.length) curveNode('T', ids.get('Hips')!, hipsT);
  p('}');
  p('Connections:  {');
  for (const b of bones) p(`\tC: "OO",${ids.get(b.name)},${b.parent ? ids.get(b.parent) : 0}`);
  p('\tC: "OO",5001,5000');
  lines.push(...conns);
  p('}');
  return lines.join('\n') + '\n';
}
