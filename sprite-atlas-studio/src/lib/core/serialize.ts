import type { PackLayout } from "./pack";
import type { AnimClip, LoopMode, Settings } from "./types";
import { isLoopMode } from "./clips";

/**
 * 图集 JSON 格式：兼容 TexturePacker "Hash" 结构，
 * 并扩展 duration / frameOrder / settings / clips / atlasDataURL，
 * 使重新导入后能完整恢复帧列表、顺序、时长、动画片段与打包结果。
 *
 * 片段在 JSON 中通过帧名引用帧（帧 id 是运行时生成的，不具稳定性）：
 * meta.clips = [{ name, loop: "loop"|"once"|"pingpong",
 *                 frames: [{ frame: "walk_01.png", duration: 100, event?: "step" }] }]
 * 旧格式（无 meta.clips）导入时由调用方自动创建一个默认片段。
 */

export const JSON_APP_ID = "sprite-atlas-studio";
export const JSON_VERSION = "1.0.0";

export interface AtlasJSONFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  /** 帧时长（毫秒） */
  duration: number;
}

export interface AtlasJSONClipEntry {
  /** 引用的帧名（frames 对象的键） */
  frame: string;
  /** 该帧在片段内的时长（毫秒） */
  duration: number;
  /** 可选事件标记 */
  event?: string;
}

export interface AtlasJSONClip {
  name: string;
  loop: LoopMode;
  frames: AtlasJSONClipEntry[];
}

export interface AtlasJSON {
  frames: Record<string, AtlasJSONFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
    /** 原始帧顺序（frames 对象的键按此排列） */
    frameOrder: string[];
    settings: {
      trim: boolean;
      padding: number;
      maxSize: number;
      pot: boolean;
    };
    /** 一轮动画总时长（毫秒） */
    totalDuration: number;
    /** 动画片段（旧格式没有此字段，导入时自动创建默认片段） */
    clips?: AtlasJSONClip[];
    /** 内嵌图集（data:image/png;base64,...），存在时可独立恢复 */
    atlasDataURL?: string;
  };
}

export interface BuildJsonOptions {
  imageName: string;
  trimmed: boolean;
  settings: Settings;
  /** 动画片段（按 frameId 引用帧，导出时转换为帧名） */
  clips?: AnimClip[];
  atlasDataURL?: string;
}

/** 把运行时片段（frameId 引用）转换为 JSON 片段（帧名引用）；引用不在映射表中的条目被跳过 */
export function clipsToJSON(clips: AnimClip[], nameById: Map<string, string>): AtlasJSONClip[] {
  return clips.map((c) => ({
    name: c.name,
    loop: c.loop,
    frames: c.entries.flatMap((e) => {
      const frame = nameById.get(e.frameId);
      if (!frame) return []; // 引用已不存在（不应发生，删除帧时会同步移除引用）
      const entry: AtlasJSONClipEntry = { frame, duration: Math.max(1, e.duration) };
      if (e.event) entry.event = e.event;
      return [entry];
    })
  }));
}

/** 由打包结果生成 JSON 对象（纯函数） */
export function buildAtlasJSON(layout: PackLayout, opts: BuildJsonOptions): AtlasJSON {
  const frames: Record<string, AtlasJSONFrame> = {};
  const frameOrder: string[] = [];
  let total = 0;

  for (const f of layout.frames) {
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: opts.trimmed,
      spriteSourceSize: { x: f.trim.x, y: f.trim.y, w: f.trim.w, h: f.trim.h },
      sourceSize: { w: f.srcW, h: f.srcH },
      duration: f.duration
    };
    frameOrder.push(f.name);
    total += Math.max(1, f.duration);
  }

  const meta: AtlasJSON["meta"] = {
    app: JSON_APP_ID,
    version: JSON_VERSION,
    image: opts.imageName,
    format: "RGBA8888",
    size: { w: layout.atlasWidth, h: layout.atlasHeight },
    scale: "1",
    frameOrder,
    settings: {
      trim: opts.settings.trim,
      padding: opts.settings.padding,
      maxSize: opts.settings.maxSize,
      pot: opts.settings.pot
    },
    totalDuration: total
  };
  if (opts.clips) {
    const nameById = new Map(layout.frames.map((f) => [f.id, f.name]));
    meta.clips = clipsToJSON(opts.clips, nameById);
  }
  if (opts.atlasDataURL) meta.atlasDataURL = opts.atlasDataURL;

  return { frames, meta };
}

export interface ParsedFrameEntry {
  name: string;
  duration: number;
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  trimmed: boolean;
}

export interface ParsedClipEntry {
  /** 引用的帧名 */
  frame: string;
  duration: number;
  event?: string;
}

export interface ParsedClip {
  name: string;
  loop: LoopMode;
  frames: ParsedClipEntry[];
}

export interface ParsedAtlasJSON {
  /** 按 frameOrder 排列的帧 */
  frames: ParsedFrameEntry[];
  size: { w: number; h: number };
  settings: Settings;
  imageName: string;
  /** 动画片段；旧格式 JSON 没有此字段时为 undefined（调用方应创建默认片段） */
  clips?: ParsedClip[];
  atlasDataURL?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`JSON 格式错误：字段 ${field} 应为数字`);
  }
  return v;
}

function rect(v: unknown, field: string, keys: readonly string[]): Record<string, number> {
  if (!isRecord(v)) throw new Error(`JSON 格式错误：字段 ${field} 应为对象`);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = num(v[k], `${field}.${k}`);
  return out;
}

/** 解析并校验图集 JSON（纯函数），不合法时抛出中文错误 */
export function parseAtlasJSON(raw: unknown): ParsedAtlasJSON {
  if (!isRecord(raw)) throw new Error("JSON 格式错误：顶层应为对象");
  if (!isRecord(raw.meta)) throw new Error("JSON 格式错误：缺少 meta");
  if (!isRecord(raw.frames)) throw new Error("JSON 格式错误：缺少 frames");

  const meta = raw.meta;
  if (meta.app !== JSON_APP_ID) {
    throw new Error(`无法识别的 JSON：meta.app 应为 "${JSON_APP_ID}"`);
  }
  if (!isRecord(meta.size)) throw new Error("JSON 格式错误：缺少 meta.size");
  const size = { w: num(meta.size.w, "meta.size.w"), h: num(meta.size.h, "meta.size.h") };

  const settingsRaw = isRecord(meta.settings) ? meta.settings : {};
  const settings: Settings = {
    trim: settingsRaw.trim !== false,
    padding: typeof settingsRaw.padding === "number" ? settingsRaw.padding : 0,
    maxSize: typeof settingsRaw.maxSize === "number" ? settingsRaw.maxSize : size.w,
    pot: settingsRaw.pot !== false,
    embedAtlas: true
  };

  const order: string[] = Array.isArray(meta.frameOrder)
    ? meta.frameOrder.filter((n): n is string => typeof n === "string")
    : Object.keys(raw.frames);

  const frames: ParsedFrameEntry[] = [];
  for (const name of order) {
    const f = raw.frames[name];
    if (!isRecord(f)) throw new Error(`JSON 格式错误：帧 "${name}" 缺少数据`);
    const fr = rect(f.frame, `frames.${name}.frame`, ["x", "y", "w", "h"]);
    const ss = rect(f.spriteSourceSize, `frames.${name}.spriteSourceSize`, ["x", "y", "w", "h"]);
    const src = rect(f.sourceSize, `frames.${name}.sourceSize`, ["w", "h"]);
    const frame = { x: fr.x!, y: fr.y!, w: fr.w!, h: fr.h! };
    const spriteSourceSize = { x: ss.x!, y: ss.y!, w: ss.w!, h: ss.h! };
    const sourceSize = { w: src.w!, h: src.h! };

    if (frame.w < 0 || frame.h < 0) throw new Error(`JSON 格式错误：帧 "${name}" 尺寸非法`);
    if (frame.x + frame.w > size.w || frame.y + frame.h > size.h) {
      throw new Error(`JSON 格式错误：帧 "${name}" 超出图集范围`);
    }
    if (spriteSourceSize.x + spriteSourceSize.w > sourceSize.w ||
        spriteSourceSize.y + spriteSourceSize.h > sourceSize.h) {
      throw new Error(`JSON 格式错误：帧 "${name}" 的裁切区域超出原始尺寸`);
    }

    frames.push({
      name,
      duration: typeof f.duration === "number" && f.duration > 0 ? f.duration : 100,
      frame,
      spriteSourceSize,
      sourceSize,
      trimmed: f.trimmed === true
    });
  }

  if (frames.length === 0) throw new Error("JSON 中没有任何帧");

  const imageName = typeof meta.image === "string" ? meta.image : "atlas.png";
  const atlasDataURL = typeof meta.atlasDataURL === "string" ? meta.atlasDataURL : undefined;
  const clips = parseClips(meta.clips);

  return {
    frames,
    size,
    settings,
    imageName,
    ...(clips ? { clips } : {}),
    ...(atlasDataURL ? { atlasDataURL } : {})
  };
}

/** 解析 meta.clips；字段缺失（旧格式）返回 undefined，结构非法抛错 */
function parseClips(raw: unknown): ParsedClip[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("JSON 格式错误：meta.clips 应为数组");
  return raw.map((c, i) => {
    if (!isRecord(c)) throw new Error(`JSON 格式错误：片段 #${i + 1} 应为对象`);
    const name = typeof c.name === "string" && c.name.trim() !== "" ? c.name : `片段 ${i + 1}`;
    const loop: LoopMode = isLoopMode(c.loop) ? c.loop : "loop";
    if (!Array.isArray(c.frames)) {
      throw new Error(`JSON 格式错误：片段 "${name}" 缺少 frames 数组`);
    }
    const frames: ParsedClipEntry[] = c.frames.map((e, j) => {
      if (!isRecord(e) || typeof e.frame !== "string") {
        throw new Error(`JSON 格式错误：片段 "${name}" 第 ${j + 1} 项缺少 frame`);
      }
      const entry: ParsedClipEntry = {
        frame: e.frame,
        duration:
          typeof e.duration === "number" && Number.isFinite(e.duration) && e.duration > 0
            ? e.duration
            : 100
      };
      if (typeof e.event === "string" && e.event.trim() !== "") entry.event = e.event;
      return entry;
    });
    return { name, loop, frames };
  });
}
