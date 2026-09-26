/**
 * 动画计时：按每帧时长推进。纯函数便于测试。
 */

import type { ClipLoopMode } from "./types";

/** 总时长（毫秒） */
export function totalDuration(durations: number[]): number {
  return durations.reduce((a, b) => a + Math.max(1, b), 0);
}

/**
 * 给定已播放时间 t（毫秒，可超过一轮，自动循环），返回帧下标。
 * 时长小于 1ms 的按 1ms 计。
 */
export function frameIndexAt(durations: number[], t: number): number {
  const n = durations.length;
  if (n === 0) return -1;
  const total = totalDuration(durations);
  let rest = ((t % total) + total) % total;
  for (let i = 0; i < n; i++) {
    const d = Math.max(1, durations[i] ?? 1);
    if (rest < d) return i;
    rest -= d;
  }
  return n - 1;
}

/** 可步进的动画器（供 PixiJS ticker 使用） */
export class Animator {
  private acc = 0;
  index = 0;
  playing = true;

  constructor(private durations: number[]) {}

  setDurations(durations: number[]): void {
    this.durations = durations;
    if (this.index >= durations.length) this.index = 0;
  }

  reset(): void {
    this.acc = 0;
    this.index = 0;
  }

  /** 推进 deltaMs 毫秒，返回当前帧下标 */
  tick(deltaMs: number): number {
    const n = this.durations.length;
    if (n === 0) return -1;
    if (!this.playing) return this.index;
    if (this.index >= n) this.index = 0;
    this.acc += deltaMs;
    let guard = 0;
    while (this.acc >= Math.max(1, this.durations[this.index] ?? 1) && guard < n * 4) {
      this.acc -= Math.max(1, this.durations[this.index] ?? 1);
      this.index = (this.index + 1) % n;
      guard++;
    }
    return this.index;
  }
}

// ---------- 片段动画器：循环 / 单次 / 往返 + 事件 ----------

export interface ClipStepEvent {
  /** 触发事件的帧在片段帧序列中的下标 */
  refIndex: number;
  name: string;
}

export interface ClipStepResult {
  /** 当前帧在片段帧序列中的下标（单次播完停在末帧）；空片段为 -1 */
  index: number;
  /** 本次 tick 新进入帧时触发的事件（同一帧重复 tick 不会重复触发） */
  events: ClipStepEvent[];
  /** 单次模式已播完并停在末帧 */
  finished: boolean;
}

/**
 * 展开一轮播放的虚拟帧轨道（往返模式端点不重复）。
 * n 帧时：正向 0..n-1，再反向 n-2..1，共 2n-2 个位置；
 * 端点位置在一轮中只出现一次，故端点事件每轮只触发一次。
 */
export function pingpongTrack(n: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  const track: number[] = [];
  for (let i = 0; i < n; i++) track.push(i);
  for (let i = n - 2; i >= 1; i--) track.push(i);
  return track;
}

/** 给定循环模式，返回一轮播放的虚拟帧轨道 */
export function modeTrack(mode: ClipLoopMode, n: number): number[] {
  if (n === 0) return [];
  if (mode === "pingpong") return pingpongTrack(n);
  return Array.from({ length: n }, (_, i) => i);
}

/** 一轮播放的总时长（往返为 2n-2 个帧位） */
export function clipCycleDuration(durations: number[], mode: ClipLoopMode): number {
  const track = modeTrack(mode, durations.length);
  return track.reduce((sum, i) => sum + Math.max(1, durations[i] ?? 1), 0);
}

/**
 * 片段动画器：按片段内每帧的独立时长推进，支持三种循环模式，
 * 并在“进入某一帧”时上报该帧的事件。
 */
export class ClipAnimator {
  /** 当前虚拟轨道位置（轨道上的下标，非片段帧下标） */
  private pos = 0;
  private acc = 0;
  /** 是否尚未上报当前帧的“进入事件”（reset 后首帧在首次 tick 时上报一次） */
  private pendingEnter = false;
  index = 0;
  playing = true;
  finished = false;

  private durations: number[] = [];
  private eventNames: Array<string | undefined> = [];
  private mode: ClipLoopMode = "loop";
  private track: number[] = [];
  /** 每个轨道位置的时长 */
  private trackDurations: number[] = [];
  private cycle = 0;

  constructor(opts?: { durations?: number[]; events?: Array<string | undefined>; mode?: ClipLoopMode }) {
    this.configure(opts ?? {});
  }

  /** 切换片段内容（时长/事件/模式），从头开始 */
  configure(opts: {
    durations?: number[];
    events?: Array<string | undefined>;
    mode?: ClipLoopMode;
  }): void {
    if (opts.durations) this.durations = opts.durations;
    if (opts.events) this.eventNames = opts.events;
    if (opts.mode) this.mode = opts.mode;
    this.track = modeTrack(this.mode, this.durations.length);
    this.trackDurations = this.track.map((i) => Math.max(1, this.durations[i] ?? 1));
    this.cycle = totalDuration(this.trackDurations);
    this.reset();
  }

  reset(): void {
    this.acc = 0;
    this.pos = 0;
    this.finished = false;
    this.index = this.track[0] ?? -1;
    this.pendingEnter = this.track.length > 0;
  }

  /** 重新从头播放（单次模式可再次播放） */
  restart(): void {
    this.playing = true;
    this.reset();
  }

  /**
   * 推进 deltaMs。事件仅在“进入帧”的瞬间上报：
   * - 首帧事件在首次 tick 时触发一次；
   * - loop / pingpong：每进入一帧上报一次；往返端点在一轮轨道中唯一，天然不重复；
   * - once：每帧只进入一次，播完停在末帧，不再上报。
   */
  tick(deltaMs: number): ClipStepResult {
    const events: ClipStepEvent[] = [];
    if (this.track.length === 0) return { index: -1, events, finished: false };
    if (!this.playing || this.finished) {
      return { index: this.index, events, finished: this.finished };
    }

    // 首帧进入事件（播放/重启后的首次 tick 触发一次）
    if (this.pendingEnter) {
      this.pendingEnter = false;
      this.emitAt(this.pos, events);
    }

    this.acc += deltaMs;
    let guard = 0;
    const guardMax = Math.max(4, this.track.length * 4);

    while (guard < guardMax && !this.finished) {
      const d = this.trackDurations[this.pos] ?? 1;
      if (this.acc < d) break;
      this.acc -= d;

      if (this.mode === "once") {
        if (this.pos >= this.track.length - 1) {
          // 已在末帧（末帧时长已用完）：继续停在末帧
          this.acc = 0;
          this.finished = true;
          this.playing = false;
          break;
        }
        this.pos++;
        // 到达末帧即视为播放结束并停住：末帧只进入一次，事件只触发一次
        if (this.pos >= this.track.length - 1) {
          this.acc = 0;
          this.finished = true;
          this.playing = false;
        }
      } else {
        this.pos = (this.pos + 1) % this.track.length;
        if (this.pos === 0) this.acc = this.acc % Math.max(1, this.cycle);
      }
      this.emitAt(this.pos, events);
      guard++;
    }

    this.index = this.track[this.pos] ?? this.index;
    return { index: this.index, events, finished: this.finished };
  }

  private emitAt(pos: number, out: ClipStepEvent[]): void {
    const refIndex = this.track[pos];
    if (refIndex === undefined) return;
    const name = this.eventNames[refIndex];
    if (name) out.push({ refIndex, name });
  }
}
