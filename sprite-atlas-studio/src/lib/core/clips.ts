/**
 * 动画片段（Clip）领域逻辑：纯函数为主，便于单元测试。
 * 片段引用已有帧（frameId），拥有独立顺序、单帧时长、循环模式与事件标记。
 */
import type { Clip, ClipFrameRef, ClipLoopMode, FrameItem } from "./types";
import { uid } from "./image";

export function isLoopMode(v: unknown): v is ClipLoopMode {
  return v === "loop" || v === "once" || v === "pingpong";
}

function clampDuration(v: unknown): number {
  // 解析外部数据时非法/非正时长回退默认 100ms（与 serialize.parseAtlasJSON 一致）
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 100;
  return Math.max(1, Math.round(v));
}

function normalizeEvent(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** 由帧创建一条片段引用（时长取帧当前时长，之后与帧脱钩） */
export function makeRef(frame: FrameItem): ClipFrameRef {
  return { frameId: frame.id, duration: Math.max(1, frame.duration) };
}

/** 生成不重名的片段名 */
export function uniqueClipName(base: string, clips: Iterable<Clip>): string {
  const taken = new Set([...clips].map((c) => c.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** 创建空片段 */
export function createClip(name: string, frames: FrameItem[] = []): Clip {
  return {
    id: uid(),
    name,
    loop: "loop",
    frames: frames.map((f) => makeRef(f))
  };
}

/**
 * 默认片段：按帧列表顺序引用全部帧（导入旧格式 JSON / 无片段工程时使用）。
 * 时长映射按 frameId 解析（导入后帧 id 会重新生成）。
 */
export function defaultClipFromFrames(
  frames: Iterable<FrameItem>,
  name = "默认片段",
  durationsByName?: Map<string, number>
): Clip {
  const list = [...frames];
  return {
    id: uid(),
    name,
    loop: "loop",
    frames: list.map((f) => ({
      frameId: f.id,
      duration: durationsByName?.get(f.name) ?? Math.max(1, f.duration)
    }))
  };
}

/** 片段正向一轮的总时长（毫秒；往返一轮的总时长由 clipCycleDuration 计算） */
export function clipForwardDuration(clip: Clip): number {
  return clip.frames.reduce((sum, r) => sum + Math.max(1, r.duration), 0);
}

export interface ClipFrameImpact {
  clipId: string;
  clipName: string;
  /** 该帧在片段中被引用的次数（通常 1 次） */
  count: number;
}

/** 找出所有引用了某帧的片段（删除帧前展示影响用） */
export function clipsUsingFrame(clips: Iterable<Clip>, frameId: string): ClipFrameImpact[] {
  const out: ClipFrameImpact[] = [];
  for (const clip of clips) {
    const count = clip.frames.reduce((n, r) => n + (r.frameId === frameId ? 1 : 0), 0);
    if (count > 0) out.push({ clipId: clip.id, clipName: clip.name, count });
  }
  return out;
}

/**
 * 原子地从所有片段中移除对某帧的引用（返回新数组，不改原数据）。
 * 与帧列表删除配合，保证“删除帧 + 移除全部引用”在一次状态更新中完成。
 */
export function removeFrameFromClips(clips: Clip[], frameId: string): Clip[] {
  return clips.map((clip) => {
    if (!clip.frames.some((r) => r.frameId === frameId)) return clip;
    return { ...clip, frames: clip.frames.filter((r) => r.frameId !== frameId) };
  });
}

/** 丢弃引用了不存在帧的失效条目（持久化/导入恢复后兜底）；空片段保留以便继续编辑 */
export function pruneClipRefs(clips: Clip[], validIds: Set<string>): Clip[] {
  return clips.map((clip) => ({
    ...clip,
    frames: clip.frames.filter((r) => validIds.has(r.frameId))
  }));
}

/** 片段内是否已引用某帧（同一片段内不重复添加） */
export function clipHasFrame(clip: Clip, frameId: string): boolean {
  return clip.frames.some((r) => r.frameId === frameId);
}

export function addClipFrame(clip: Clip, frame: FrameItem): Clip {
  if (clipHasFrame(clip, frame.id)) return clip;
  return { ...clip, frames: [...clip.frames, makeRef(frame)] };
}

export function removeClipRef(clip: Clip, refIndex: number): Clip {
  if (refIndex < 0 || refIndex >= clip.frames.length) return clip;
  return { ...clip, frames: clip.frames.filter((_, i) => i !== refIndex) };
}

export function moveClipRef(clip: Clip, refIndex: number, dir: -1 | 1): Clip {
  const j = refIndex + dir;
  if (refIndex < 0 || j < 0 || j >= clip.frames.length) return clip;
  const frames = [...clip.frames];
  const a = frames[refIndex]!;
  frames[refIndex] = frames[j]!;
  frames[j] = a;
  return { ...clip, frames };
}

export function setClipRefDuration(clip: Clip, refIndex: number, ms: number): Clip {
  if (!Number.isFinite(ms)) return clip;
  const v = Math.max(1, Math.round(ms));
  return {
    ...clip,
    frames: clip.frames.map((r, i) => (i === refIndex ? { ...r, duration: v } : r))
  };
}

export function setClipRefEvent(clip: Clip, refIndex: number, event: string): Clip {
  const ev = normalizeEvent(event);
  return {
    ...clip,
    frames: clip.frames.map((r, i) => {
      if (i !== refIndex) return r;
      const next = { ...r };
      if (ev) next.event = ev;
      else delete next.event;
      return next;
    })
  };
}

export function setClipLoop(clip: Clip, loop: ClipLoopMode): Clip {
  return clip.loop === loop ? clip : { ...clip, loop };
}

export function renameClip(clip: Clip, name: string, all: Clip[]): Clip {
  const trimmed = name.trim();
  if (!trimmed || trimmed === clip.name) return clip;
  const finalName = uniqueClipName(trimmed, all.filter((c) => c.id !== clip.id));
  return { ...clip, name: finalName };
}

/** 从导出 JSON 的片段结构归一化（frameId 此时是帧名，由 store 再映射为新 id） */
export interface ClipRefDTO {
  frame: string;
  duration: number;
  event?: string;
}
export interface ClipDTO {
  name: string;
  loop: ClipLoopMode;
  frames: ClipRefDTO[];
}

export function normalizeClipDTO(raw: unknown, index: number): ClipDTO | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : `片段 ${index + 1}`;
  const loop: ClipLoopMode = isLoopMode(o.loop) ? o.loop : "loop";
  const refsRaw = Array.isArray(o.frames) ? o.frames : [];
  const frames: ClipRefDTO[] = [];
  for (const r of refsRaw) {
    if (typeof r !== "object" || r === null) continue;
    const ro = r as Record<string, unknown>;
    if (typeof ro.frame !== "string" || !ro.frame) continue;
    const ref: ClipRefDTO = { frame: ro.frame, duration: clampDuration(ro.duration) };
    const event = normalizeEvent(ro.event);
    if (event) ref.event = event;
    frames.push(ref);
  }
  return { name, loop, frames };
}

/** 用 DTO（帧名引用）+ 帧名→帧 映射构造运行时片段；丢弃解析不到的引用 */
export function clipFromDTO(dto: ClipDTO, byName: Map<string, FrameItem>): Clip {
  const refs: ClipFrameRef[] = [];
  for (const r of dto.frames) {
    const f = byName.get(r.frame);
    if (!f) continue;
    refs.push({
      frameId: f.id,
      duration: r.duration,
      ...(r.event ? { event: r.event } : {})
    });
  }
  return { id: uid(), name: dto.name, loop: dto.loop, frames: refs };
}
