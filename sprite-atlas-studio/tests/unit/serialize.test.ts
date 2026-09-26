import { describe, expect, it } from "vitest";
import { buildAtlasJSON, parseAtlasJSON, JSON_APP_ID } from "../../src/lib/core/serialize";
import { packFrames, type PackInput } from "../../src/lib/core/pack";
import { DEFAULT_SETTINGS, type AnimClip } from "../../src/lib/core/types";

function makeLayout() {
  const inputs: PackInput[] = [
    { id: "1", name: "run_01.png", w: 42, h: 48, trim: { x: 8, y: 10, w: 42, h: 48 }, srcW: 64, srcH: 64, duration: 50 },
    { id: "2", name: "run_02.png", w: 70, h: 40, trim: { x: 6, y: 4, w: 70, h: 40 }, srcW: 96, srcH: 48, duration: 80 },
    { id: "3", name: "run_03.png", w: 200, h: 150, trim: { x: 0, y: 0, w: 200, h: 150 }, srcW: 200, srcH: 150, duration: 120 }
  ];
  return packFrames(inputs, 2, 1024, true);
}

describe("buildAtlasJSON / parseAtlasJSON", () => {
  it("导出后再导入：帧列表、顺序、时长、位置、裁切信息完整恢复", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: { ...DEFAULT_SETTINGS, padding: 2, maxSize: 1024 },
      atlasDataURL: "data:image/png;base64,AAAA"
    });

    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));

    expect(parsed.size).toEqual({ w: layout.atlasWidth, h: layout.atlasHeight });
    expect(parsed.frames.map((f) => f.name)).toEqual(["run_01.png", "run_02.png", "run_03.png"]);
    expect(parsed.frames.map((f) => f.duration)).toEqual([50, 80, 120]);
    expect(parsed.settings.padding).toBe(2);
    expect(parsed.atlasDataURL).toBe("data:image/png;base64,AAAA");

    for (const [i, f] of parsed.frames.entries()) {
      const src = layout.frames[i]!;
      expect(f.frame).toEqual({ x: src.x, y: src.y, w: src.w, h: src.h });
      expect(f.spriteSourceSize).toEqual({
        x: src.trim.x,
        y: src.trim.y,
        w: src.trim.w,
        h: src.trim.h
      });
      expect(f.sourceSize).toEqual({ w: src.srcW, h: src.srcH });
    }
  });

  it("JSON 可序列化为字符串再解析（模拟写盘/读盘）", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    const text = JSON.stringify(json, null, 2);
    const parsed = parseAtlasJSON(JSON.parse(text));
    expect(parsed.frames).toHaveLength(3);
    expect(parsed.imageName).toBe("atlas.png");
  });

  it("拒绝非本工具 JSON", () => {
    expect(() => parseAtlasJSON({ frames: {}, meta: { app: "other" } })).toThrow(/meta\.app/);
    expect(() => parseAtlasJSON(null)).toThrow(/顶层/);
    expect(() => parseAtlasJSON({})).toThrow(/meta/);
  });

  it("拒绝越界帧矩形", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    const tampered = JSON.parse(JSON.stringify(json));
    tampered.frames["run_01.png"].frame.x = 10000;
    expect(() => parseAtlasJSON(tampered)).toThrow(/超出图集范围/);
  });

  it("meta.app 标识正确", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: false,
      settings: DEFAULT_SETTINGS
    });
    expect(json.meta.app).toBe(JSON_APP_ID);
    expect(json.meta.totalDuration).toBe(50 + 80 + 120);
  });
});

describe("片段的导出与导入", () => {
  const CLIPS: AnimClip[] = [
    {
      id: "c1",
      name: "walk",
      loop: "pingpong",
      entries: [
        { frameId: "1", duration: 60, event: "step" },
        { frameId: "2", duration: 90 },
        { frameId: "3", duration: 60, event: "step" }
      ]
    },
    {
      id: "c2",
      name: "run",
      loop: "once",
      entries: [
        { frameId: "3", duration: 30 },
        { frameId: "1", duration: 30, event: "hit" }
      ]
    }
  ];

  it("导出：片段按帧名写入 meta.clips，保留顺序/循环模式/时长/事件", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS,
      clips: CLIPS
    });
    expect(json.meta.clips).toEqual([
      {
        name: "walk",
        loop: "pingpong",
        frames: [
          { frame: "run_01.png", duration: 60, event: "step" },
          { frame: "run_02.png", duration: 90 },
          { frame: "run_03.png", duration: 60, event: "step" }
        ]
      },
      {
        name: "run",
        loop: "once",
        frames: [
          { frame: "run_03.png", duration: 30 },
          { frame: "run_01.png", duration: 30, event: "hit" }
        ]
      }
    ]);
  });

  it("往返：导出→解析后片段顺序、循环模式、事件与时长一致，图集坐标不受影响", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS,
      clips: CLIPS
    });
    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));

    expect(parsed.clips).toHaveLength(2);
    expect(parsed.clips![0]).toEqual({
      name: "walk",
      loop: "pingpong",
      frames: [
        { frame: "run_01.png", duration: 60, event: "step" },
        { frame: "run_02.png", duration: 90 },
        { frame: "run_03.png", duration: 60, event: "step" }
      ]
    });
    expect(parsed.clips![1]).toEqual({
      name: "run",
      loop: "once",
      frames: [
        { frame: "run_03.png", duration: 30 },
        { frame: "run_01.png", duration: 30, event: "hit" }
      ]
    });
    // 图集坐标照旧
    for (const [i, f] of parsed.frames.entries()) {
      const src = layout.frames[i]!;
      expect(f.frame).toEqual({ x: src.x, y: src.y, w: src.w, h: src.h });
    }
  });

  it("旧格式（无 meta.clips）：clips 为 undefined，由调用方创建默认片段", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    expect(json.meta.clips).toBeUndefined();
    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));
    expect(parsed.clips).toBeUndefined();
  });

  it("新格式空片段数组（clips: []）被保留为空，而非视为旧格式", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS,
      clips: []
    });
    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));
    expect(parsed.clips).toEqual([]);
  });

  it("非法循环模式回退为 loop；缺失时长回退 100ms", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    const tampered = JSON.parse(JSON.stringify(json));
    tampered.meta.clips = [
      { name: "x", loop: "bounce", frames: [{ frame: "run_01.png" }] }
    ];
    const parsed = parseAtlasJSON(tampered);
    expect(parsed.clips).toEqual([
      { name: "x", loop: "loop", frames: [{ frame: "run_01.png", duration: 100 }] }
    ]);
  });

  it("拒绝结构非法的 clips", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    const bad1 = JSON.parse(JSON.stringify(json));
    bad1.meta.clips = { name: "not-array" };
    expect(() => parseAtlasJSON(bad1)).toThrow(/meta\.clips/);

    const bad2 = JSON.parse(JSON.stringify(json));
    bad2.meta.clips = [{ name: "c", loop: "loop" }]; // 缺 frames
    expect(() => parseAtlasJSON(bad2)).toThrow(/frames/);

    const bad3 = JSON.parse(JSON.stringify(json));
    bad3.meta.clips = [{ name: "c", loop: "loop", frames: [{ duration: 50 }] }]; // 缺 frame
    expect(() => parseAtlasJSON(bad3)).toThrow(/frame/);
  });
});
