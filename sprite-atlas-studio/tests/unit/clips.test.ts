import { describe, expect, it } from "vitest";
import { ClipPlayer } from "../../src/lib/core/animator";
import {
  countFrameRefs,
  makeClip,
  removeFrameRefs,
  uniqueClipName,
  withEvent
} from "../../src/lib/core/clips";
import type { AnimClip } from "../../src/lib/core/types";

describe("ClipPlayer · 循环模式", () => {
  it("按条目时长推进并循环", () => {
    const p = new ClipPlayer([100, 200, 50], "loop");
    expect(p.start()).toEqual([0]);
    expect(p.tick(100)).toEqual([1]);
    expect(p.tick(199)).toEqual([]);
    expect(p.tick(1)).toEqual([2]); // 累计 200 → 进入帧 2
    expect(p.tick(50)).toEqual([0]); // 循环回首帧
  });

  it("大跨度 delta 依次报告进入的帧", () => {
    const p = new ClipPlayer([100, 100, 100], "loop");
    p.start();
    expect(p.tick(250)).toEqual([1, 2]);
    expect(p.tick(300)).toEqual([0, 1, 2]);
  });

  it("暂停时不推进", () => {
    const p = new ClipPlayer([100, 100], "loop");
    p.start();
    p.playing = false;
    expect(p.tick(500)).toEqual([]);
    expect(p.index).toBe(0);
  });
});

describe("ClipPlayer · 单次模式", () => {
  it("停在末帧且不再推进", () => {
    const p = new ClipPlayer([100, 100, 100], "once");
    expect(p.start()).toEqual([0]);
    expect(p.tick(100)).toEqual([1]);
    expect(p.tick(100)).toEqual([2]);
    expect(p.finished).toBe(false);
    expect(p.tick(100)).toEqual([]); // 末帧时长耗尽 → 结束
    expect(p.finished).toBe(true);
    expect(p.index).toBe(2);
    // 继续 tick 不再推进
    expect(p.tick(1000)).toEqual([]);
    expect(p.index).toBe(2);
  });

  it("大跨度 delta 一次播完：每个帧只进入一次", () => {
    const p = new ClipPlayer([100, 100, 100], "once");
    p.start();
    expect(p.tick(10000)).toEqual([1, 2]);
    expect(p.finished).toBe(true);
  });

  it("reset 后可重新播放", () => {
    const p = new ClipPlayer([100, 100], "once");
    p.start();
    p.tick(10000);
    expect(p.finished).toBe(true);
    expect(p.start()).toEqual([0]);
    expect(p.finished).toBe(false);
    expect(p.tick(100)).toEqual([1]);
  });
});

describe("ClipPlayer · 往返模式", () => {
  it("帧序为 0,1,2,1,0,1,2…（端点不重复停留）", () => {
    const p = new ClipPlayer([100, 100, 100], "pingpong");
    const seq: number[] = [...p.start()];
    for (let i = 0; i < 8; i++) seq.push(...p.tick(100));
    expect(seq).toEqual([0, 1, 2, 1, 0, 1, 2, 1, 0]);
  });

  it("两帧往返：0,1,0,1…", () => {
    const p = new ClipPlayer([50, 50], "pingpong");
    const seq: number[] = [...p.start()];
    for (let i = 0; i < 5; i++) seq.push(...p.tick(50));
    expect(seq).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("单帧往返：原地停留不推进", () => {
    const p = new ClipPlayer([100], "pingpong");
    expect(p.start()).toEqual([0]);
    expect(p.tick(500)).toEqual([]);
    expect(p.index).toBe(0);
  });

  it("端点事件不重复触发：事件次数与帧序一致", () => {
    // 事件挂在首帧(A)与末帧(B)：一个完整往返周期应各触发 2 次，且无连续重复
    const p = new ClipPlayer([100, 100, 100], "pingpong");
    const events: string[] = [];
    const onEnter = (idx: number) => {
      if (idx === 0) events.push("A");
      if (idx === 2) events.push("B");
    };
    p.start().forEach(onEnter);
    // 模拟 800ms（约两个往返半程）：A 在起点与两次回到底端时触发，B 在两次到达顶端时触发
    for (let t = 0; t < 800; t += 16) p.tick(16).forEach(onEnter);
    const a = events.filter((e) => e === "A").length;
    const b = events.filter((e) => e === "B").length;
    expect(a).toBe(3); // 初始进入 + 两次返回首帧
    expect(b).toBe(2); // 两次到达末帧
    for (let i = 1; i < events.length; i++) {
      expect(events[i], "端点事件不得连续重复").not.toBe(events[i - 1]);
    }
  });
});

describe("ClipPlayer · 通用", () => {
  it("时长不足 1ms 按 1ms 计", () => {
    const p = new ClipPlayer([0, 0], "loop");
    p.start();
    expect(p.tick(1)).toEqual([1]);
    expect(p.tick(1)).toEqual([0]);
  });

  it("setClip 更换时长与模式并复位", () => {
    const p = new ClipPlayer([100, 100], "loop");
    p.start();
    p.tick(150);
    p.setClip([50, 50, 50], "once");
    expect(p.index).toBe(0);
    expect(p.mode).toBe("once");
    expect(p.length).toBe(3);
  });

  it("空片段不推进", () => {
    const p = new ClipPlayer([], "loop");
    expect(p.start()).toEqual([]);
    expect(p.tick(100)).toEqual([]);
  });
});

describe("片段助手", () => {
  const frames = [
    { id: "f1", duration: 80 },
    { id: "f2", duration: 120 }
  ];

  it("makeClip 复制帧时长为条目时长（独立副本）", () => {
    const c = makeClip("walk", frames);
    expect(c.name).toBe("walk");
    expect(c.loop).toBe("loop");
    expect(c.entries).toEqual([
      { frameId: "f1", duration: 80 },
      { frameId: "f2", duration: 120 }
    ]);
    // 修改条目时长不影响原帧数据
    c.entries[0]!.duration = 999;
    expect(frames[0]!.duration).toBe(80);
  });

  it("countFrameRefs / removeFrameRefs", () => {
    const clips: AnimClip[] = [
      { id: "c1", name: "a", loop: "loop", entries: [{ frameId: "f1", duration: 1 }, { frameId: "f1", duration: 2 }, { frameId: "f2", duration: 3 }] },
      { id: "c2", name: "b", loop: "once", entries: [{ frameId: "f1", duration: 4 }] },
      { id: "c3", name: "c", loop: "loop", entries: [{ frameId: "f2", duration: 5 }] }
    ];
    expect(countFrameRefs(clips, "f1")).toEqual([
      { clipId: "c1", clipName: "a", refs: 2 },
      { clipId: "c2", clipName: "b", refs: 1 }
    ]);
    const after = removeFrameRefs(clips, "f1");
    expect(after[0]!.entries.map((e) => e.frameId)).toEqual(["f2"]);
    expect(after[1]!.entries).toEqual([]);
    expect(after[2]!.entries).toHaveLength(1); // 未引用的片段保持不变
    // 原数组不被修改（纯函数）
    expect(clips[0]!.entries).toHaveLength(3);
  });

  it("withEvent 设置与清除事件", () => {
    const e = { frameId: "f1", duration: 100 };
    const withEv = withEvent(e, "step");
    expect(withEv.event).toBe("step");
    expect(withEvent(withEv, "  ").event).toBeUndefined();
    expect(withEvent(withEv, "").event).toBeUndefined();
    // 原条目不被修改
    expect(e.event).toBeUndefined();
  });

  it("uniqueClipName 避开重名", () => {
    const clips = [makeClip("片段 1", frames), makeClip("片段 2", frames)];
    expect(uniqueClipName(clips)).toBe("片段 3");
    expect(uniqueClipName([])).toBe("片段 1");
  });
});
