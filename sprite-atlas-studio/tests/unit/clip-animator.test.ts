import { describe, expect, it } from "vitest";
import {
  ClipAnimator,
  clipCycleDuration,
  modeTrack,
  pingpongTrack
} from "../../src/lib/core/animator";

/** 把若干次 tick 的结果压成便于断言的序列 */
function run(
  anim: ClipAnimator,
  step: number,
  steps: number
): { index: number[]; events: { refIndex: number; name: string }[][]; finished: boolean[] } {
  const index: number[] = [];
  const events: { refIndex: number; name: string }[][] = [];
  const finished: boolean[] = [];
  for (let i = 0; i < steps; i++) {
    const r = anim.tick(step);
    index.push(r.index);
    events.push(r.events);
    finished.push(r.finished);
  }
  return { index, events, finished };
}

describe("pingpongTrack / modeTrack", () => {
  it("往返端点不重复：n 帧轨道长度 2n-2，端点各出现一次", () => {
    expect(pingpongTrack(1)).toEqual([0]);
    expect(pingpongTrack(2)).toEqual([0, 1]);
    expect(pingpongTrack(3)).toEqual([0, 1, 2, 1]);
    expect(pingpongTrack(4)).toEqual([0, 1, 2, 3, 2, 1]);
    const t = pingpongTrack(5);
    expect(t.filter((i) => i === 0)).toHaveLength(1);
    expect(t.filter((i) => i === 4)).toHaveLength(1);
  });

  it("loop/once 轨道为正向顺序；空片段为空轨道", () => {
    expect(modeTrack("loop", 3)).toEqual([0, 1, 2]);
    expect(modeTrack("once", 3)).toEqual([0, 1, 2]);
    expect(modeTrack("pingpong", 0)).toEqual([]);
  });

  it("往返一轮时长 = 2n-2 个帧位之和", () => {
    expect(clipCycleDuration([100, 200, 300], "pingpong")).toBe(100 + 200 + 300 + 200);
    expect(clipCycleDuration([100, 100], "loop")).toBe(200);
    expect(clipCycleDuration([100, 100], "once")).toBe(200);
  });
});

describe("ClipAnimator · loop", () => {
  const events = ["start", undefined, "end"];

  it("按片段独立时长推进并循环，事件在进入帧时上报", () => {
    const a = new ClipAnimator({ durations: [100, 100, 100], events, mode: "loop" });
    // 首次 tick：首帧事件
    let r = a.tick(0);
    expect(r.index).toBe(0);
    expect(r.events.map((e) => e.name)).toEqual(["start"]);

    r = a.tick(100); // → 帧1（无事件）
    expect(r.index).toBe(1);
    expect(r.events).toEqual([]);

    r = a.tick(100); // → 帧2 事件 end
    expect(r.index).toBe(2);
    expect(r.events.map((e) => e.name)).toEqual(["end"]);

    r = a.tick(100); // 循环回帧0，再次 start
    expect(r.index).toBe(0);
    expect(r.events.map((e) => e.name)).toEqual(["start"]);
  });

  it("同一帧停留期间不重复触发事件", () => {
    const a = new ClipAnimator({ durations: [100, 100], events: ["a", undefined], mode: "loop" });
    a.tick(0);
    expect(a.tick(50).events).toEqual([]);
    expect(a.tick(40).events).toEqual([]);
  });

  it("两个片段复用同一帧、时长不同：动画器各自独立", () => {
    const a = new ClipAnimator({ durations: [100, 100], mode: "loop" });
    const b = new ClipAnimator({ durations: [300, 100], mode: "loop" });
    a.tick(0);
    b.tick(0);
    // 200ms 时：a 已循环回到帧0，b 仍在帧0
    expect(a.tick(200).index).toBe(0);
    expect(b.tick(200).index).toBe(0);
    // 300ms 时：a 在帧2轮内的帧0（300%200=100→帧1后再走100回0），b 刚到帧1
    expect(a.tick(100).index).toBe(1);
    expect(b.tick(100).index).toBe(1);
  });
});

describe("ClipAnimator · once（单次停在末帧）", () => {
  it("播完停在末帧，事件每帧只触发一次", () => {
    const a = new ClipAnimator({
      durations: [100, 100, 100],
      events: ["s", undefined, "last"],
      mode: "once"
    });
    expect(a.tick(0)).toMatchObject({ index: 0, finished: false });
    expect(a.tick(100).index).toBe(1);
    const end = a.tick(200); // 一步跨到末帧
    expect(end.index).toBe(2);
    expect(end.finished).toBe(true);
    expect(end.events.map((e) => e.name)).toEqual(["last"]);

    // 之后继续 tick：停在末帧、不再触发、finished 保持
    for (let i = 0; i < 5; i++) {
      const r = a.tick(500);
      expect(r.index).toBe(2);
      expect(r.finished).toBe(true);
      expect(r.events).toEqual([]);
    }
  });

  it("restart 后可再次播放并重新触发事件", () => {
    const a = new ClipAnimator({ durations: [100, 100], events: ["a", "b"], mode: "once" });
    a.tick(0);
    a.tick(200);
    expect(a.tick(10).finished).toBe(true);
    a.restart();
    const r = a.tick(0);
    expect(r.finished).toBe(false);
    expect(r.index).toBe(0);
    expect(r.events.map((e) => e.name)).toEqual(["a"]);
  });
});

describe("ClipAnimator · pingpong（往返）", () => {
  it("帧序为 0..n-1..1 循环", () => {
    const a = new ClipAnimator({ durations: [100, 100, 100], mode: "pingpong" });
    const { index } = run(a, 100, 8);
    expect(index).toEqual([1, 2, 1, 0, 1, 2, 1, 0]);
  });

  it("端点事件每轮只触发一次，不在反转处重复", () => {
    const a = new ClipAnimator({
      durations: [100, 100, 100],
      events: ["HEAD", "mid", "TAIL"],
      mode: "pingpong"
    });
    // 连续推进 8 个 100ms：首批含首帧 HEAD；之后正好走完两轮轨道
    // 轨道 [0,1,2,1]：每轮 HEAD×1、TAIL×1、mid×2；加上首批 HEAD
    const r = run(a, 100, 8);
    const fired = r.events.flatMap((batch) => batch);

    expect(fired.filter((e) => e.name === "HEAD")).toHaveLength(3);
    expect(fired.filter((e) => e.name === "TAIL")).toHaveLength(2);
    expect(fired.filter((e) => e.name === "mid")).toHaveLength(4);

    // TAIL 两次触发间隔正好一轮（4 个轨道位），且中间无相邻重复
    const tailAt = r.events
      .map((batch, i) => (batch.some((e) => e.name === "TAIL") ? i : -1))
      .filter((i) => i >= 0);
    expect(tailAt).toEqual([1, 5]);
    // 任何单批中 TAIL 最多出现一次（反转端点不双触发）
    for (const batch of r.events) {
      expect(batch.filter((e) => e.name === "TAIL").length).toBeLessThanOrEqual(1);
    }
    // TAIL 事件的 refIndex 恒为末帧 2，HEAD 恒为首帧 0
    expect(fired.find((e) => e.name === "TAIL")!.refIndex).toBe(2);
    expect(fired.find((e) => e.name === "HEAD")!.refIndex).toBe(0);
  });

  it("端点无事件时也不会产生任何重复事件", () => {
    const a = new ClipAnimator({
      durations: [50, 50, 50],
      events: [undefined, "x", undefined],
      mode: "pingpong"
    });
    a.tick(0);
    const r = run(a, 50, 8);
    const count = r.events.reduce((n, batch) => n + batch.length, 0);
    // 轨道 [0,1,2,1]：每轮 x 出现 2 次，两轮 4 次
    expect(count).toBe(4);
  });
});

describe("ClipAnimator · 杂项", () => {
  it("空片段返回 -1 且不触发事件", () => {
    const a = new ClipAnimator({ durations: [], events: [], mode: "loop" });
    const r = a.tick(100);
    expect(r.index).toBe(-1);
    expect(r.events).toEqual([]);
    expect(r.finished).toBe(false);
  });

  it("暂停时不推进、不触发", () => {
    const a = new ClipAnimator({ durations: [100], events: ["x"], mode: "loop" });
    a.tick(0);
    a.playing = false;
    expect(a.tick(500)).toMatchObject({ index: 0 });
    expect(a.tick(500).events).toEqual([]);
  });

  it("时长小于 1ms 按 1ms 计", () => {
    const a = new ClipAnimator({ durations: [0, 0], mode: "loop" });
    a.tick(0);
    expect(a.tick(2).index).toBe(0); // 2ms 内已多次循环，最终落在某帧
  });
});
