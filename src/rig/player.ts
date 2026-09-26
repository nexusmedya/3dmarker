/**
 * Animation playback on a rigged model: an AnimationMixer on the model root
 * (tracks bind by bone name), driven by the viewer's frame loop
 * (`addFrameListener`, returning true while playing so frames keep coming).
 * `stop()` returns to the bind (T-) pose; `setTime` scrubs.
 */
import { AnimationMixer, LoopOnce, LoopRepeat } from 'three';
import type { AnimationAction, AnimationClip, Object3D } from 'three';
import { resetToRest } from './skeleton';

/** The part of ViewerCore the player needs. */
export interface FrameHost {
  addFrameListener(fn: (dt: number) => boolean | void): () => void;
  invalidate(): void;
}

export interface PlayOptions {
  /** Repeat forever (default true); false plays once and holds the last frame. */
  loop?: boolean;
  /** Playback rate (default 1). */
  speed?: number;
  /** Seconds to blend from the current clip (0 / omitted = cut). */
  crossFade?: number;
}

export interface PlayerState {
  clip: AnimationClip | null;
  playing: boolean;
  time: number;
  duration: number;
}

export class AnimationPlayer {
  readonly mixer: AnimationMixer;
  private action: AnimationAction | null = null;
  private current: AnimationClip | null = null;
  private playing = false;
  private speed = 1;
  private loop = true;
  private readonly unsubscribe: () => void;
  private disposed = false;
  /** Called every frame while playing and after seeks / stops: (time, duration). */
  onTime: ((time: number, duration: number) => void) | null = null;
  /** A non-looping clip reached its end. */
  onFinished: (() => void) | null = null;

  constructor(
    private readonly host: FrameHost | null,
    private readonly root: Object3D,
  ) {
    this.mixer = new AnimationMixer(root);
    this.mixer.addEventListener('finished', () => {
      this.playing = false;
      this.emit();
      this.onFinished?.();
    });
    this.unsubscribe = host?.addFrameListener((dt) => this.tick(dt)) ?? (() => {});
  }

  get state(): PlayerState {
    return { clip: this.current, playing: this.playing, time: this.time, duration: this.current?.duration ?? 0 };
  }

  get time(): number {
    return this.action?.time ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get clip(): AnimationClip | null {
    return this.current;
  }

  /** Advance by dt seconds (the frame listener; exposed for tests). Returns true while playing. */
  tick(dt: number): boolean {
    if (this.disposed || !this.playing || !this.action) return false;
    this.mixer.update(dt);
    this.emit();
    return this.playing;
  }

  play(clip: AnimationClip, opts: PlayOptions = {}): void {
    if (this.disposed) return;
    this.loop = opts.loop ?? true;
    if (opts.speed !== undefined) this.speed = opts.speed;
    const prev = this.action;
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(this.loop ? LoopRepeat : LoopOnce, Infinity);
    next.clampWhenFinished = true;
    next.setEffectiveTimeScale(this.speed);
    next.setEffectiveWeight(1);
    next.enabled = true;
    const fade = opts.crossFade ?? 0;
    if (prev && prev !== next && fade > 0 && this.playing) {
      next.play();
      prev.crossFadeTo(next, fade, false);
    } else {
      if (prev && prev !== next) prev.stop();
      next.play();
    }
    this.action = next;
    this.current = clip;
    this.playing = true;
    this.mixer.update(0);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.emit();
  }

  resume(): void {
    if (this.disposed || !this.action || this.playing) return;
    // A finished one-shot restarts.
    const a = this.action;
    if (!this.loop && a.time >= (this.current?.duration ?? 0) - 1e-6) a.reset();
    a.paused = false;
    a.enabled = true;
    if (!a.isRunning()) a.play();
    this.playing = true;
    this.host?.invalidate();
  }

  /** Stop and return to the bind pose. */
  stop(): void {
    this.mixer.stopAllAction();
    this.action = null;
    this.current = null;
    this.playing = false;
    resetToRest(this.root);
    this.root.updateMatrixWorld(true);
    this.emit();
  }

  /** Seek (seconds, clamped to the clip); keeps the play / pause state. */
  setTime(time: number): void {
    const a = this.action;
    if (!a || !this.current) return;
    const d = this.current.duration;
    a.enabled = true;
    a.paused = false;
    if (!a.isRunning()) a.play();
    // Seek to just before the end: at exactly `duration` a looping action wraps to 0.
    a.time = Math.max(0, Math.min(time, d - 1e-4));
    this.mixer.update(0);
    this.emit();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.action?.setEffectiveTimeScale(speed);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.action?.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
  }

  /** Forget cached actions of clips that are gone (e.g. rebuilt after a joint edit). */
  uncache(clip: AnimationClip): void {
    if (clip === this.current) this.stop();
    this.mixer.uncacheClip(clip);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.unsubscribe();
    this.mixer.uncacheRoot(this.root);
  }

  private emit(): void {
    this.host?.invalidate();
    this.onTime?.(this.time, this.current?.duration ?? 0);
  }
}
