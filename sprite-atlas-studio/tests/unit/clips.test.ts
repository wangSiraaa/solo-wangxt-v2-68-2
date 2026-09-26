import { describe, expect, it } from "vitest";
import {
  addClipFrame,
  clipForwardDuration,
  clipFromDTO,
  clipHasFrame,
  clipsUsingFrame,
  createClip,
  defaultClipFromFrames,
  moveClipRef,
  pruneClipRefs,
  removeClipRef,
  removeFrameFromClips,
  setClipLoop,
  setClipRefDuration,
  setClipRefEvent,
  uniqueClipName,
  normalizeClipDTO
} from "../../src/lib/core/clips";
import type { FrameItem } from "../../src/lib/core/types";

function frame(id: string, name = id, duration = 100): FrameItem {
  return { id, name, duration, width: 8, height: 8, blob: new Blob(), url: "" };
}

describe("片段构建与默认片段", () => {
  it("createClip / defaultClipFromFrames 按帧顺序生成引用，时长复制而非共享", () => {
    const fs = [frame("a", "a.png", 100), frame("b", "b.png", 200)];
    const clip = createClip("c1", fs);
    expect(clip.loop).toBe("loop");
    expect(clip.frames.map((r) => r.frameId)).toEqual(["a", "b"]);
    expect(clip.frames.map((r) => r.duration)).toEqual([100, 200]);

    const def = defaultClipFromFrames(fs);
    expect(def.frames.map((r) => r.frameId)).toEqual(["a", "b"]);
  });

  it("片段时长与帧时长脱钩：改片段时长不影响帧，反之亦然", () => {
    const fs = [frame("a", "a.png", 100)];
    const c1 = addClipFrame(createClip("c1"), fs[0]!);
    const c2 = addClipFrame(createClip("c2"), fs[0]!);
    const c1b = setClipRefDuration(c1, 0, 500);
    expect(c1b.frames[0]!.duration).toBe(500);
    expect(c2.frames[0]!.duration).toBe(100); // 另一个片段不受影响
    expect(fs[0]!.duration).toBe(100); // 原帧不受影响
  });
});

describe("片段编辑", () => {
  it("同一帧不能在一个片段内重复添加，但可被两个片段复用", () => {
    const f = frame("a");
    const c1 = addClipFrame(createClip("c1"), f);
    expect(clipHasFrame(c1, "a")).toBe(true);
    expect(addClipFrame(c1, f)).toBe(c1); // 不产生新引用
    const c2 = addClipFrame(createClip("c2"), f);
    expect(c2.frames).toHaveLength(1);
  });

  it("移动/移除/事件/循环模式", () => {
    const fs = [frame("a"), frame("b"), frame("c")];
    let c = createClip("c", fs);
    c = moveClipRef(c, 0, 1);
    expect(c.frames.map((r) => r.frameId)).toEqual(["b", "a", "c"]);
    c = setClipRefEvent(c, 1, "fire");
    expect(c.frames[1]!.event).toBe("fire");
    c = setClipRefEvent(c, 1, "   ");
    expect(c.frames[1]!.event).toBeUndefined();
    c = setClipLoop(c, "pingpong");
    expect(c.loop).toBe("pingpong");
    c = removeClipRef(c, 0);
    expect(c.frames.map((r) => r.frameId)).toEqual(["a", "c"]);
  });

  it("非法时长收敛到 >=1", () => {
    const c = setClipRefDuration(createClip("c", [frame("a")]), 0, -5);
    expect(c.frames[0]!.duration).toBe(1);
  });

  it("uniqueClipName 处理重名", () => {
    const clips = [createClip("run"), createClip("run 2")];
    expect(uniqueClipName("run", clips)).toBe("run 3");
    expect(uniqueClipName("idle", clips)).toBe("idle");
  });

  it("clipForwardDuration 按片段时长求和", () => {
    const c = setClipRefDuration(createClip("c", [frame("a"), frame("b")]), 0, 250);
    expect(clipForwardDuration(c)).toBe(350);
  });
});

describe("删除被引用帧的影响与原子移除", () => {
  const fs = [frame("a"), frame("b"), frame("c")];

  it("clipsUsingFrame 列出所有引用片段及次数", () => {
    const c1 = createClip("c1", fs); // 引用 a,b,c
    const c2 = createClip("c2", [fs[0]!, fs[2]!]); // a,c
    const c3 = createClip("c3", [fs[1]!]); // b
    const impacts = clipsUsingFrame([c1, c2, c3], "a");
    expect(impacts.map((i) => i.clipName)).toEqual(["c1", "c2"]);
    expect(impacts.every((i) => i.count === 1)).toBe(true);
    expect(clipsUsingFrame([c1, c2, c3], "missing")).toEqual([]);
  });

  it("removeFrameFromClips 一次性从所有片段移除引用，且不影响其它帧", () => {
    const c1 = createClip("c1", fs);
    const c2 = createClip("c2", [fs[0]!, fs[0]!, fs[2]!]); // 同帧引用两次
    const next = removeFrameFromClips([c1, c2], "a");
    expect(next[0]!.frames.map((r) => r.frameId)).toEqual(["b", "c"]);
    expect(next[1]!.frames.map((r) => r.frameId)).toEqual(["c"]);
    // 原数据不变（不可变更新）
    expect(c1.frames).toHaveLength(3);
  });

  it("pruneClipRefs 清理失效引用", () => {
    const c = createClip("c", fs);
    const pruned = pruneClipRefs([c], new Set(["b"]));
    expect(pruned[0]!.frames.map((r) => r.frameId)).toEqual(["b"]);
  });
});

describe("DTO 归一化与导入重建", () => {
  it("normalizeClipDTO 宽容解析", () => {
    expect(normalizeClipDTO(null, 0)).toBeNull();
    const dto = normalizeClipDTO(
      { name: " run ", loop: "bad", frames: [{ frame: "a.png", duration: -3, event: " hit " }, { x: 1 }] },
      2
    );
    expect(dto).toEqual({ name: "run", loop: "loop", frames: [{ frame: "a.png", duration: 100, event: "hit" }] });
  });

  it("clipFromDTO 按帧名映射为新 id，丢弃缺失帧引用", () => {
    const fs = [frame("id1", "a.png"), frame("id2", "b.png")];
    const byName = new Map(fs.map((f) => [f.name, f]));
    const dto = normalizeClipDTO(
      { name: "c", loop: "pingpong", frames: [{ frame: "b.png", duration: 80 }, { frame: "x.png" }] },
      0
    )!;
    const clip = clipFromDTO(dto, byName);
    expect(clip.loop).toBe("pingpong");
    expect(clip.frames.map((r) => r.frameId)).toEqual(["id2"]);
    expect(clip.frames[0]!.duration).toBe(80);
  });
});
