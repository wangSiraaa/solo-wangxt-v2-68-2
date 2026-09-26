import { describe, expect, it } from "vitest";
import { buildAtlasJSON, parseAtlasJSON, JSON_APP_ID, JSON_VERSION } from "../../src/lib/core/serialize";
import { packFrames, type PackInput } from "../../src/lib/core/pack";
import { DEFAULT_SETTINGS, type Clip } from "../../src/lib/core/types";

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

describe("片段（clips）序列化", () => {
  function makeClips(): Clip[] {
    // id 与 makeLayout 中的 PackInput id 对应："1","2","3"
    return [
      {
        id: "c1",
        name: "跑步",
        loop: "loop",
        frames: [
          { frameId: "1", duration: 50, event: "step" },
          { frameId: "2", duration: 80 },
          { frameId: "3", duration: 120, event: "attack" }
        ]
      },
      {
        id: "c2",
        name: "往返片段",
        loop: "pingpong",
        frames: [
          { frameId: "3", duration: 200 },
          { frameId: "1", duration: 70 }
        ]
      }
    ];
  }

  it("片段顺序、循环模式、独立时长与事件完整往返", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS,
      clips: makeClips()
    });
    expect(json.meta.version).toBe(JSON_VERSION);
    expect(json.meta.clips).toHaveLength(2);
    expect(json.meta.clips!.map((c) => c.name)).toEqual(["跑步", "往返片段"]);
    expect(json.meta.clips![0]!.loop).toBe("loop");
    expect(json.meta.clips![1]!.loop).toBe("pingpong");
    expect(json.meta.clips![0]!.frames).toEqual([
      { frame: "run_01.png", duration: 50, event: "step" },
      { frame: "run_02.png", duration: 80 },
      { frame: "run_03.png", duration: 120, event: "attack" }
    ]);
    expect(json.meta.clips![1]!.frames).toEqual([
      { frame: "run_03.png", duration: 200 },
      { frame: "run_01.png", duration: 70 }
    ]);

    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));
    expect(parsed.clips).not.toBeNull();
    expect(parsed.clips!.map((c) => [c.name, c.loop])).toEqual([
      ["跑步", "loop"],
      ["往返片段", "pingpong"]
    ]);
    expect(parsed.clips![0]!.frames[0]).toEqual({ frame: "run_01.png", duration: 50, event: "step" });
  });

  it("无片段导出时 meta.clips 缺省（旧格式），解析得到 null 以便自动建默认片段", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    expect(json.meta.clips).toBeUndefined();
    const parsed = parseAtlasJSON(json);
    expect(parsed.clips).toBeNull();
  });

  it("兼容 1.0.0 旧 JSON（无 clips 字段）", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    json.meta.version = "1.0.0";
    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));
    expect(parsed.clips).toBeNull();
    expect(parsed.frames).toHaveLength(3);
  });

  it("非法循环模式回退为 loop；非法时长回退 100", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS,
      clips: makeClips()
    });
    const tampered = JSON.parse(JSON.stringify(json));
    tampered.meta.clips[0].loop = "weird";
    tampered.meta.clips[0].frames[0].duration = 0;
    const parsed = parseAtlasJSON(tampered);
    expect(parsed.clips![0]!.loop).toBe("loop");
    expect(parsed.clips![0]!.frames[0]!.duration).toBe(100);
  });

  it("拒绝引用不存在帧的片段", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS,
      clips: makeClips()
    });
    const tampered = JSON.parse(JSON.stringify(json));
    tampered.meta.clips[1].frames[0].frame = "ghost.png";
    expect(() => parseAtlasJSON(tampered)).toThrow(/不存在的帧/);
  });
});
