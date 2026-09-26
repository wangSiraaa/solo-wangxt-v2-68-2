/**
 * 动画计时：按每帧时长推进。纯函数便于测试。
 */
import type { LoopMode } from "./types";

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

/**
 * 片段播放器：按条目时长推进，支持循环 / 单次 / 往返三种模式。
 * - 循环：0..n-1 后回到 0
 * - 单次：停在末帧（finished = true），继续 tick 不再推进
 * - 往返：0..n-1..0.. 端点只停留一次，不会重复触发端点事件
 *
 * tick 返回本次推进中"进入"的条目下标序列（按进入顺序），
 * 调用方据此触发条目上的事件标记；初始进入第 0 帧由 start() 报告。
 */
export class ClipPlayer {
  private acc = 0;
  private durations: number[];
  mode: LoopMode;
  index = 0;
  /** 往返当前方向（1 向末帧，-1 向首帧） */
  dir: 1 | -1 = 1;
  playing = true;
  /** 单次模式播完末帧后置 true */
  finished = false;

  constructor(durations: number[], mode: LoopMode = "loop") {
    this.durations = durations.map((d) => Math.max(1, d));
    this.mode = mode;
  }

  get length(): number {
    return this.durations.length;
  }

  /** 更换片段（时长与循环模式），并复位到第 0 帧 */
  setClip(durations: number[], mode: LoopMode): void {
    this.durations = durations.map((d) => Math.max(1, d));
    this.mode = mode;
    this.reset();
  }

  reset(): void {
    this.acc = 0;
    this.index = 0;
    this.dir = 1;
    this.finished = false;
  }

  /** 从头开始播放，返回初始进入的条目（第 0 帧，若有） */
  start(): number[] {
    this.reset();
    this.playing = true;
    return this.durations.length > 0 ? [0] : [];
  }

  private dur(i: number): number {
    return Math.max(1, this.durations[i] ?? 1);
  }

  /**
   * 推进到下一个条目；返回新下标，或 null（单次播完 / 单帧往返原地停留）。
   */
  private advance(): number | null {
    const n = this.durations.length;
    if (this.mode === "once") {
      if (this.index >= n - 1) {
        this.finished = true;
        this.acc = 0;
        return null;
      }
      return ++this.index;
    }
    if (this.mode === "loop") {
      this.index = (this.index + 1) % n;
      return this.index;
    }
    // pingpong：端点不重复停留
    if (n <= 1) {
      this.acc = 0;
      return null;
    }
    let next = this.index + this.dir;
    if (next >= n) {
      this.dir = -1;
      next = n - 2;
    } else if (next < 0) {
      this.dir = 1;
      next = 1;
    }
    this.index = next;
    return this.index;
  }

  /** 推进 deltaMs 毫秒，返回依次进入的条目下标（可能为空） */
  tick(deltaMs: number): number[] {
    const entered: number[] = [];
    const n = this.durations.length;
    if (n === 0 || !this.playing || this.finished) return entered;
    if (this.index >= n) this.reset();
    this.acc += deltaMs;
    let guard = 0;
    const maxSteps = n * 4 + 8;
    while (this.acc >= this.dur(this.index) && guard < maxSteps) {
      this.acc -= this.dur(this.index);
      const next = this.advance();
      if (next === null) break;
      entered.push(next);
      guard++;
    }
    return entered;
  }
}
