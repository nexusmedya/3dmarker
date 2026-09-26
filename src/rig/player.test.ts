import { describe, expect, it, vi } from 'vitest';
import { buildLibrary } from './animations';
import { autoPlaceJoints } from './autoJoints';
import { AnimationPlayer, type FrameHost } from './player';
import { buildSkeleton, describeRig } from './skeleton';
import { makeMannequin } from './testing';

function setup() {
  const layout = autoPlaceJoints(makeMannequin(1).mesh);
  const sk = buildSkeleton(layout);
  const clips = new Map(buildLibrary(describeRig(layout)).map((c) => [c.info.id, c.clip]));
  let listener: ((dt: number) => boolean | void) | null = null;
  const host: FrameHost & { frame: (dt: number) => boolean | void; removed: boolean } = {
    removed: false,
    addFrameListener(fn) {
      listener = fn;
      return () => {
        host.removed = true;
      };
    },
    invalidate: vi.fn(),
    frame: (dt) => listener!(dt),
  };
  const player = new AnimationPlayer(host, sk.root);
  return { sk, clips, host, player };
}

describe('AnimationPlayer', () => {
  it('plays, reports time, pauses, resumes and stops back to the T-pose', () => {
    const { sk, clips, host, player } = setup();
    const onTime = vi.fn();
    player.onTime = onTime;
    const walk = clips.get('walk')!;
    player.play(walk);
    expect(player.isPlaying).toBe(true);
    expect(host.frame(0.1)).toBe(true);
    expect(player.time).toBeCloseTo(0.1, 5);
    expect(onTime).toHaveBeenLastCalledWith(expect.closeTo(0.1, 5), walk.duration);
    const leg = sk.byName.get('LeftUpLeg')!;
    expect(leg.quaternion.w).toBeLessThan(0.9999);
    player.pause();
    expect(host.frame(0.1)).toBe(false);
    expect(player.time).toBeCloseTo(0.1, 5);
    player.resume();
    host.frame(0.2);
    expect(player.time).toBeCloseTo(0.3, 5);
    player.stop();
    expect(player.isPlaying).toBe(false);
    expect(leg.quaternion.w).toBeCloseTo(1, 9);
    expect(sk.byName.get('Hips')!.position.toArray()).toEqual(sk.byName.get('Hips')!.userData.rest.position);
  });

  it('loops by default and holds the last frame of one-shots', () => {
    const { clips, host, player } = setup();
    const jump = clips.get('jump')!;
    const finished = vi.fn();
    player.onFinished = finished;
    player.play(jump, { loop: false });
    for (let i = 0; i < 20; i++) host.frame(0.1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(player.isPlaying).toBe(false);
    expect(player.time).toBeCloseTo(jump.duration, 3);
    player.resume(); // restarts a finished one-shot
    expect(player.isPlaying).toBe(true);
    host.frame(0.1);
    expect(player.time).toBeCloseTo(0.1, 3);

    const walk = clips.get('walk')!;
    player.play(walk, { loop: true });
    for (let i = 0; i < 15; i++) host.frame(0.1);
    expect(player.isPlaying).toBe(true);
    expect(player.time).toBeLessThan(walk.duration);
  });

  it('speed, scrubbing and cross-fades', () => {
    const { sk, clips, host, player } = setup();
    player.play(clips.get('walk')!, { speed: 2 });
    host.frame(0.1);
    expect(player.time).toBeCloseTo(0.2, 5);
    player.setSpeed(0.5);
    host.frame(0.1);
    expect(player.time).toBeCloseTo(0.25, 5);
    player.pause();
    player.setTime(0.5);
    expect(player.time).toBeCloseTo(0.5, 5);
    expect(player.isPlaying).toBe(false);
    player.setTime(99);
    expect(player.time).toBeLessThan(clips.get('walk')!.duration);

    player.resume();
    const wave = clips.get('wave-right')!;
    player.play(wave, { crossFade: 0.3 });
    expect(player.clip).toBe(wave);
    host.frame(0.15);
    // Mid-fade: both clips contribute, so the pose is neither pure walk nor pure wave.
    expect(sk.byName.get('RightArm')!.quaternion.w).toBeLessThan(1);
    player.dispose();
    expect(host.removed).toBe(true);
  });
});
