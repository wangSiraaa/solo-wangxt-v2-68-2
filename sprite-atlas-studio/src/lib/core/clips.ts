import type { AnimClip, ClipEntry, LoopMode } from "./types";
import { uid } from "./image";

/**
 * 动画片段的纯函数助手：创建、引用统计、引用移除。
 * 片段通过 frameId 引用帧；条目时长是帧时长的独立副本，互不影响。
 */

export const LOOP_LABELS: Record<LoopMode, string> = {
  loop: "循环",
  once: "单次",
  pingpong: "往返"
};

export const LOOP_MODES: LoopMode[] = ["loop", "once", "pingpong"];

export function isLoopMode(v: unknown): v is LoopMode {
  return v === "loop" || v === "once" || v === "pingpong";
}

/** 新建片段：默认按当前顺序引用给定帧，并复制其当前时长 */
export function makeClip(
  name: string,
  frames: Array<{ id: string; duration: number }>,
  loop: LoopMode = "loop"
): AnimClip {
  return {
    id: uid(),
    name,
    loop,
    entries: frames.map((f) => ({ frameId: f.id, duration: Math.max(1, Math.round(f.duration)) }))
  };
}

/** 片段内各条目的时长序列（供播放器使用） */
export function clipDurations(clip: AnimClip): number[] {
  return clip.entries.map((e) => Math.max(1, e.duration));
}

/** 统计某帧在各片段中的引用次数（仅返回有引用的片段） */
export function countFrameRefs(
  clips: AnimClip[],
  frameId: string
): Array<{ clipId: string; clipName: string; refs: number }> {
  const out: Array<{ clipId: string; clipName: string; refs: number }> = [];
  for (const c of clips) {
    const refs = c.entries.reduce((n, e) => n + (e.frameId === frameId ? 1 : 0), 0);
    if (refs > 0) out.push({ clipId: c.id, clipName: c.name, refs });
  }
  return out;
}

/** 从所有片段中移除对某帧的引用（纯函数，返回新数组） */
export function removeFrameRefs(clips: AnimClip[], frameId: string): AnimClip[] {
  return clips.map((c) =>
    c.entries.some((e) => e.frameId === frameId)
      ? { ...c, entries: c.entries.filter((e) => e.frameId !== frameId) }
      : c
  );
}

/** 生成不与现有片段重名的名称：片段 1、片段 2… */
export function uniqueClipName(clips: AnimClip[], base = "片段"): string {
  const taken = new Set(clips.map((c) => c.name));
  let i = clips.length + 1;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** 规范化条目时长输入 */
export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.round(ms));
}

/** 设置/清除条目事件标记（空字符串视为清除），返回新条目 */
export function withEvent(entry: ClipEntry, event: string): ClipEntry {
  const trimmed = event.trim();
  if (trimmed === "") {
    const { event: _drop, ...rest } = entry;
    return rest;
  }
  return { ...entry, event: trimmed };
}
