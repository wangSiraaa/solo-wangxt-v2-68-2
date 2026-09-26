import { derived, get, writable } from "svelte/store";
import type { AnimClip, FrameItem, LoopMode, PackResult, PackedFrame, Settings, TrimRect } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { computeAlphaBBox } from "./trim";
import { packFrames, type PackInput, type PackLayout } from "./pack";
import { buildAtlasJSON, clipsToJSON, parseAtlasJSON, type AtlasJSON } from "./serialize";
import {
  clampDuration,
  countFrameRefs,
  makeClip,
  removeFrameRefs,
  uniqueClipName,
  withEvent
} from "./clips";
import {
  blobToImage,
  canvasToBlob,
  canvasToDataURL,
  ctx2d,
  dataURLToBlob,
  downloadBlob,
  imageToPixels,
  makeCanvas,
  uid
} from "./image";
import { clearProject, loadProject, saveProject, toStored } from "./db";

export const frames = writable<FrameItem[]>([]);
export const settings = writable<Settings>({ ...DEFAULT_SETTINGS });
export const packResult = writable<PackResult | null>(null);
export const selectedId = writable<string | null>(null);
export const busy = writable(false);
export const status = writable<{ kind: "info" | "error"; text: string } | null>(null);

/** 动画片段列表（顺序即展示/导出顺序） */
export const clips = writable<AnimClip[]>([]);
/** 预览当前播放的片段 id；null = 原始序列（全部帧） */
export const activeClipId = writable<string | null>(null);

export const frameCount = derived(frames, ($f) => $f.length);

let statusTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: "info" | "error" = "info"): void {
  status.set({ kind, text });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.set(null), 5000);
}

/** 当前打包结果对应的 JSON（不含内嵌图集，供存储/导出复用） */
let lastJSON: AtlasJSON | null = null;
export function getLastJSON(): AtlasJSON | null {
  return lastJSON;
}

// ---------- 帧导入 ----------

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

export async function addFiles(files: Iterable<File>): Promise<void> {
  const list = [...files].filter((f) => /png$/i.test(f.type) || /\.png$/i.test(f.name));
  if (list.length === 0) {
    notify("请选择 PNG 图片", "error");
    return;
  }
  busy.set(true);
  try {
    const current = get(frames);
    const taken = new Set(current.map((f) => f.name));
    const added: FrameItem[] = [];
    for (const file of list) {
      try {
        const img = await blobToImage(file);
        const name = uniqueName(file.name, taken);
        taken.add(name);
        added.push({
          id: uid(),
          name,
          duration: 100,
          width: img.naturalWidth,
          height: img.naturalHeight,
          blob: file,
          url: URL.createObjectURL(file)
        });
      } catch {
        notify(`无法解码图片：${file.name}`, "error");
      }
    }
    if (added.length > 0) {
      frames.set([...current, ...added]);
      packResult.set(null); // 帧变化后旧的打包结果失效
      notify(`已导入 ${added.length} 帧`);
    }
  } finally {
    busy.set(false);
  }
}

export function removeFrame(id: string): void {
  const list = get(frames);
  const f = list.find((x) => x.id === id);
  if (!f) return;
  URL.revokeObjectURL(f.url);
  frames.set(list.filter((x) => x.id !== id));
  packResult.set(null);
}

// ---------- 帧删除（片段引用检查） ----------

/** 待确认的帧删除：帧被片段引用时先展示影响，由用户决定取消或一并移除引用 */
export interface PendingFrameDelete {
  frameId: string;
  frameName: string;
  affected: Array<{ clipId: string; clipName: string; refs: number }>;
}

export const pendingFrameDelete = writable<PendingFrameDelete | null>(null);

/**
 * 请求删除帧：若被任何片段引用，则挂起并展示受影响片段；
 * 否则直接删除。确认见 confirmRemoveFrame，取消见 cancelRemoveFrame。
 */
export function requestRemoveFrame(id: string): void {
  const f = get(frames).find((x) => x.id === id);
  if (!f) return;
  const affected = countFrameRefs(get(clips), id);
  if (affected.length === 0) {
    removeFrame(id);
    return;
  }
  pendingFrameDelete.set({ frameId: id, frameName: f.name, affected });
}

export function cancelRemoveFrame(): void {
  pendingFrameDelete.set(null);
}

/**
 * 确认删除：同一同步流程内删除帧并移除所有片段中的引用，
 * 两个 store 一起提交（自动保存防抖在其后触发），保证落盘状态一致——
 * 要么都发生，要么都不发生。
 */
export function confirmRemoveFrame(): void {
  const pending = get(pendingFrameDelete);
  if (!pending) return;
  pendingFrameDelete.set(null);
  removeFrame(pending.frameId);
  clips.set(removeFrameRefs(get(clips), pending.frameId));
  const total = pending.affected.reduce((n, a) => n + a.refs, 0);
  notify(
    `已删除 ${pending.frameName}，并从 ${pending.affected.length} 个片段中移除 ${total} 处引用`
  );
}

export function moveFrame(id: string, dir: -1 | 1): void {
  const list = [...get(frames)];
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i]!;
  list[i] = list[j]!;
  list[j] = a;
  frames.set(list);
  packResult.set(null);
}

export function setDuration(id: string, ms: number): void {
  if (!Number.isFinite(ms)) return;
  const v = Math.max(1, Math.round(ms));
  frames.set(get(frames).map((f) => (f.id === id ? { ...f, duration: v } : f)));
}

export function setAllDurations(ms: number): void {
  const v = Math.max(1, Math.round(ms));
  frames.set(get(frames).map((f) => ({ ...f, duration: v })));
}

export function clearAll(): void {
  for (const f of get(frames)) URL.revokeObjectURL(f.url);
  const pack = get(packResult);
  if (pack) URL.revokeObjectURL(pack.atlasUrl);
  frames.set([]);
  packResult.set(null);
  selectedId.set(null);
  clips.set([]);
  activeClipId.set(null);
  pendingFrameDelete.set(null);
  lastJSON = null;
}

// ---------- 动画片段 ----------

function updateClip(id: string, fn: (c: AnimClip) => AnimClip): void {
  clips.set(get(clips).map((c) => (c.id === id ? fn(c) : c)));
}

/** 新建片段：默认按当前顺序引用全部帧（复制当前时长），循环模式 */
export function addClip(): void {
  const list = get(frames);
  if (list.length === 0) {
    notify("请先导入 PNG 帧，再创建片段", "error");
    return;
  }
  const clip = makeClip(uniqueClipName(get(clips)), list, "loop");
  clips.set([...get(clips), clip]);
  notify(`已创建片段「${clip.name}」（含全部 ${list.length} 帧）`);
}

export function removeClip(id: string): void {
  const c = get(clips).find((x) => x.id === id);
  if (!c) return;
  clips.set(get(clips).filter((x) => x.id !== id));
  if (get(activeClipId) === id) activeClipId.set(null);
  notify(`已删除片段「${c.name}」`);
}

export function renameClip(id: string, name: string): void {
  const v = name.trim();
  if (!v) return;
  updateClip(id, (c) => ({ ...c, name: v }));
}

export function setClipLoop(id: string, loop: LoopMode): void {
  updateClip(id, (c) => ({ ...c, loop }));
}

/** 把一帧追加到片段末尾（复制该帧当前时长） */
export function clipAddFrame(clipId: string, frameId: string): void {
  const f = get(frames).find((x) => x.id === frameId);
  if (!f) return;
  updateClip(clipId, (c) => ({
    ...c,
    entries: [...c.entries, { frameId, duration: f.duration }]
  }));
}

export function clipRemoveEntry(clipId: string, index: number): void {
  updateClip(clipId, (c) => ({
    ...c,
    entries: c.entries.filter((_, i) => i !== index)
  }));
}

export function clipMoveEntry(clipId: string, index: number, dir: -1 | 1): void {
  updateClip(clipId, (c) => {
    const j = index + dir;
    if (index < 0 || j < 0 || j >= c.entries.length) return c;
    const entries = [...c.entries];
    const a = entries[index]!;
    entries[index] = entries[j]!;
    entries[j] = a;
    return { ...c, entries };
  });
}

/** 设置片段内某条目的时长（与帧列表时长互不影响） */
export function clipSetEntryDuration(clipId: string, index: number, ms: number): void {
  const v = clampDuration(ms);
  updateClip(clipId, (c) => ({
    ...c,
    entries: c.entries.map((e, i) => (i === index ? { ...e, duration: v } : e))
  }));
}

/** 设置/清除片段内某条目的事件标记（空字符串清除） */
export function clipSetEntryEvent(clipId: string, index: number, event: string): void {
  updateClip(clipId, (c) => ({
    ...c,
    entries: c.entries.map((e, i) => (i === index ? withEvent(e, event) : e))
  }));
}

/** 切换预览播放来源：null = 原始序列（全部帧） */
export function setActiveClip(id: string | null): void {
  if (id !== null && !get(clips).some((c) => c.id === id)) return;
  activeClipId.set(id);
}

// ---------- 打包 ----------

interface TrimmedFrame {
  item: FrameItem;
  canvas: HTMLCanvasElement;
  trim: TrimRect;
}

/** 裁切（或保留）单帧，返回内容画布与裁切信息 */
async function trimFrame(item: FrameItem, doTrim: boolean): Promise<TrimmedFrame> {
  const img = await blobToImage(item.blob);
  if (!doTrim) {
    const canvas = makeCanvas(item.width, item.height);
    ctx2d(canvas).drawImage(img, 0, 0);
    return { item, canvas, trim: { x: 0, y: 0, w: item.width, h: item.height } };
  }
  const pixels = imageToPixels(img, item.width, item.height);
  const bbox = computeAlphaBBox(pixels);
  if (!bbox) {
    // 完全透明：保留 1×1，避免 0 尺寸
    const canvas = makeCanvas(1, 1);
    return { item, canvas, trim: { x: 0, y: 0, w: 1, h: 1 } };
  }
  const canvas = makeCanvas(bbox.w, bbox.h);
  ctx2d(canvas).drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  return { item, canvas, trim: bbox };
}

/** 执行打包并生成图集 */
export async function pack(): Promise<void> {
  const list = get(frames);
  if (list.length === 0) {
    notify("请先导入 PNG 帧", "error");
    return;
  }
  const s = get(settings);
  busy.set(true);
  try {
    const trimmed: TrimmedFrame[] = [];
    for (const item of list) trimmed.push(await trimFrame(item, s.trim));

    const inputs: PackInput[] = trimmed.map((t) => ({
      id: t.item.id,
      name: t.item.name,
      w: t.canvas.width,
      h: t.canvas.height,
      trim: t.trim,
      srcW: t.item.width,
      srcH: t.item.height,
      duration: t.item.duration
    }));

    const layout: PackLayout = packFrames(inputs, s.padding, s.maxSize, s.pot);

    // 合成图集画布
    const atlas = makeCanvas(layout.atlasWidth, layout.atlasHeight);
    const ctx = ctx2d(atlas);
    const canvasById = new Map(trimmed.map((t) => [t.item.id, t.canvas]));
    for (const f of layout.frames) {
      const c = canvasById.get(f.id);
      if (c) ctx.drawImage(c, f.x, f.y);
    }

    const old = get(packResult);
    if (old) URL.revokeObjectURL(old.atlasUrl);
    const atlasBlob = await canvasToBlob(atlas);
    const result: PackResult = {
      atlasWidth: layout.atlasWidth,
      atlasHeight: layout.atlasHeight,
      frames: layout.frames,
      atlasBlob,
      atlasUrl: URL.createObjectURL(atlasBlob),
      padding: s.padding,
      trimmed: s.trim
    };
    packResult.set(result);
    lastJSON = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: s.trim,
      settings: s,
      clips: get(clips)
    });
    notify(`打包完成：${layout.atlasWidth}×${layout.atlasHeight}，共 ${layout.frames.length} 帧`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- 导出 ----------

export function exportPNG(): void {
  const p = get(packResult);
  if (!p) {
    notify("请先打包", "error");
    return;
  }
  downloadBlob(p.atlasBlob, "atlas.png");
}

export async function exportJSON(): Promise<void> {
  const p = get(packResult);
  if (!p || !lastJSON) {
    notify("请先打包", "error");
    return;
  }
  const s = get(settings);
  // 片段可能在打包后又编辑过：导出时以当前片段为准
  const nameById = new Map(p.frames.map((f) => [f.id, f.name]));
  let json: AtlasJSON = {
    ...lastJSON,
    meta: { ...lastJSON.meta, clips: clipsToJSON(get(clips), nameById) }
  };
  if (s.embedAtlas) {
    const dataURL = canvasToDataURL(await blobToCanvas(p.atlasBlob));
    json = { ...json, meta: { ...json.meta, atlasDataURL: dataURL } };
  }
  downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), "atlas.json");
  notify("已导出 atlas.png 与 atlas.json");
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const img = await blobToImage(blob);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}

// ---------- 导入 JSON 恢复 ----------

/**
 * 从导出的 JSON 恢复帧列表、时长与打包结果。
 * 图集图片来源：JSON 内嵌的 atlasDataURL，或用户同时选择的 atlas.png。
 */
export async function importJSON(jsonFile: File, atlasFile?: File): Promise<void> {
  busy.set(true);
  try {
    const raw: unknown = JSON.parse(await jsonFile.text());
    const parsed = parseAtlasJSON(raw);

    let atlasBlob: Blob;
    if (parsed.atlasDataURL) {
      atlasBlob = dataURLToBlob(parsed.atlasDataURL);
    } else if (atlasFile) {
      atlasBlob = atlasFile;
    } else {
      throw new Error("该 JSON 未内嵌图集，请同时选择导出的 atlas.png");
    }

    const atlasImg = await blobToImage(atlasBlob);
    if (atlasImg.naturalWidth < parsed.size.w || atlasImg.naturalHeight < parsed.size.h) {
      throw new Error(
        `图集图片尺寸 ${atlasImg.naturalWidth}×${atlasImg.naturalHeight} 小于 JSON 声明的 ${parsed.size.w}×${parsed.size.h}`
      );
    }

    // 从图集切出每帧内容，再按 spriteSourceSize 放回原始尺寸画布
    const restored: FrameItem[] = [];
    const packedFrames: PackedFrame[] = [];
    for (const f of parsed.frames) {
      const full = makeCanvas(f.sourceSize.w, f.sourceSize.h);
      ctx2d(full).drawImage(
        atlasImg,
        f.frame.x,
        f.frame.y,
        f.frame.w,
        f.frame.h,
        f.spriteSourceSize.x,
        f.spriteSourceSize.y,
        f.frame.w,
        f.frame.h
      );
      const blob = await canvasToBlob(full);
      const id = uid();
      restored.push({
        id,
        name: f.name,
        duration: f.duration,
        width: f.sourceSize.w,
        height: f.sourceSize.h,
        blob,
        url: URL.createObjectURL(blob)
      });
      packedFrames.push({
        id,
        name: f.name,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h,
        trim: { ...f.spriteSourceSize },
        srcW: f.sourceSize.w,
        srcH: f.sourceSize.h,
        duration: f.duration
      });
    }

    clearAll();
    frames.set(restored);
    settings.set({ ...parsed.settings });

    // 片段：新格式按 JSON 恢复（帧名 → 新帧 id）；旧格式自动创建默认片段
    const idByName = new Map(restored.map((f) => [f.name, f.id]));
    let restoredClips: AnimClip[];
    if (parsed.clips) {
      restoredClips = parsed.clips.map((pc) => ({
        id: uid(),
        name: pc.name,
        loop: pc.loop,
        entries: pc.frames.flatMap((pe) => {
          const frameId = idByName.get(pe.frame);
          if (!frameId) return []; // 引用未知帧名：忽略该条目
          return [
            {
              frameId,
              duration: clampDuration(pe.duration),
              ...(pe.event ? { event: pe.event } : {})
            }
          ];
        })
      }));
    } else {
      restoredClips = [makeClip("默认片段", restored, "loop")];
    }
    clips.set(restoredClips);
    activeClipId.set(null);

    packResult.set({
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      frames: packedFrames,
      atlasBlob,
      atlasUrl: URL.createObjectURL(atlasBlob),
      padding: parsed.settings.padding,
      trimmed: parsed.settings.trim
    });
    lastJSON = buildAtlasJSON(
      { atlasWidth: parsed.size.w, atlasHeight: parsed.size.h, frames: packedFrames },
      { imageName: parsed.imageName, trimmed: parsed.settings.trim, settings: parsed.settings, clips: restoredClips }
    );
    notify(
      parsed.clips
        ? `已从 JSON 恢复 ${restored.length} 帧、${restoredClips.length} 个片段与打包结果`
        : `已从 JSON 恢复 ${restored.length} 帧与打包结果（旧格式：已自动创建默认片段）`
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- IndexedDB 持久化 ----------

export async function saveNow(): Promise<void> {
  try {
    await saveProject(
      toStored(get(frames), get(settings), get(packResult), lastJSON, get(clips), get(activeClipId))
    );
    notify("项目已保存到浏览器本地");
  } catch (e) {
    notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function restoreFromDB(): Promise<boolean> {
  try {
    const stored = await loadProject();
    if (!stored || stored.frames.length === 0) return false;
    const restored: FrameItem[] = stored.frames.map((f) => ({
      id: f.id,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      blob: f.blob,
      url: URL.createObjectURL(f.blob)
    }));
    frames.set(restored);
    settings.set({ ...DEFAULT_SETTINGS, ...stored.settings });

    // 片段：旧存档可能没有该字段；引用已不存在的帧时防御性剔除
    const frameIds = new Set(restored.map((f) => f.id));
    const restoredClips: AnimClip[] = (stored.clips ?? []).map((c) => ({
      ...c,
      entries: (c.entries ?? []).filter((e) => frameIds.has(e.frameId))
    }));
    clips.set(restoredClips);
    activeClipId.set(
      stored.activeClipId && restoredClips.some((c) => c.id === stored.activeClipId)
        ? stored.activeClipId
        : null
    );

    if (stored.pack) {
      const parsed = parseAtlasJSON(stored.pack.json);
      const packedFrames: PackedFrame[] = parsed.frames.map((f, i) => ({
        id: restored[i]?.id ?? uid(),
        name: f.name,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h,
        trim: { ...f.spriteSourceSize },
        srcW: f.sourceSize.w,
        srcH: f.sourceSize.h,
        duration: f.duration
      }));
      packResult.set({
        atlasWidth: parsed.size.w,
        atlasHeight: parsed.size.h,
        frames: packedFrames,
        atlasBlob: stored.pack.atlasBlob,
        atlasUrl: URL.createObjectURL(stored.pack.atlasBlob),
        padding: parsed.settings.padding,
        trimmed: parsed.settings.trim
      });
      lastJSON = stored.pack.json;
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearStorage(): Promise<void> {
  await clearProject();
  clearAll();
  notify("已清空本地项目");
}

// 自动保存（防抖）
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveProject(
      toStored(get(frames), get(settings), get(packResult), lastJSON, get(clips), get(activeClipId))
    ).catch(() => {});
  }, 600);
}

export function startAutoSave(): void {
  frames.subscribe(() => scheduleSave());
  settings.subscribe(() => scheduleSave());
  packResult.subscribe(() => scheduleSave());
  clips.subscribe(() => scheduleSave());
  activeClipId.subscribe(() => scheduleSave());
}
