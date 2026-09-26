import { derived, get, writable } from "svelte/store";
import type { Clip, FrameItem, PackResult, PackedFrame, Settings, TrimRect } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { computeAlphaBBox } from "./trim";
import { packFrames, type PackInput, type PackLayout } from "./pack";
import { buildAtlasJSON, parseAtlasJSON, type AtlasJSON } from "./serialize";
import {
  addClipFrame,
  clipFromDTO,
  clipsUsingFrame,
  createClip,
  defaultClipFromFrames,
  moveClipRef,
  pruneClipRefs,
  removeClipRef,
  removeFrameFromClips,
  renameClip,
  setClipLoop,
  setClipRefDuration,
  setClipRefEvent,
  uniqueClipName,
  type ClipFrameImpact
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

/** 动画片段（同序存储，顺序即片段列表顺序） */
export const clips = writable<Clip[]>([]);
/** 预览当前选中的片段 id（null 时取第一个片段） */
export const selectedClipId = writable<string | null>(null);

export const frameCount = derived(frames, ($f) => $f.length);
export const clipList = derived(clips, ($c) => $c);

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
    notify("请选择 PNG 文件", "error");
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
      const nextFrames = [...current, ...added];
      frames.set(nextFrames);
      // 工程里还没有任何片段时，自动按导入顺序创建默认片段
      const currentClips = get(clips);
      if (currentClips.length === 0) {
        const clip = defaultClipFromFrames(nextFrames);
        clips.set([clip]);
        selectedClipId.set(clip.id);
      }
      packResult.set(null); // 帧变化后旧的打包结果失效
      notify(`已导入 ${added.length} 帧`);
    }
  } finally {
    busy.set(false);
  }
}

// ---------- 删除帧：先展示片段影响，用户确认后原子移除 ----------

export interface PendingFrameDelete {
  frameId: string;
  frameName: string;
  /** 引用了该帧的片段（空数组表示没有片段引用，可直接删除） */
  impacts: ClipFrameImpact[];
}

export const pendingDelete = writable<PendingFrameDelete | null>(null);

/** 点击删除：有片段引用时弹出影响确认；无引用时直接原子删除 */
export function requestRemoveFrame(id: string): void {
  const f = get(frames).find((x) => x.id === id);
  if (!f) return;
  const impacts = clipsUsingFrame(get(clips), id);
  if (impacts.length === 0) {
    commitRemoveFrame(id, false);
    return;
  }
  pendingDelete.set({ frameId: id, frameName: f.name, impacts });
}

export function cancelRemoveFrame(): void {
  pendingDelete.set(null);
}

/**
 * 用户确认后的实际删除（一次同步状态更新完成，保证原子性）：
 * @param removeRefs true=同时从所有受影响片段移除引用；false 理论上不会进入提交
 */
export function commitRemoveFrame(id: string, removeRefs: boolean): void {
  const list = get(frames);
  const f = list.find((x) => x.id === id);
  if (!f) return;
  const impacts = clipsUsingFrame(get(clips), id);
  if (impacts.length > 0 && !removeRefs) {
    // 仍有引用且未授权移除引用 → 拒绝删除（取消）
    return;
  }

  URL.revokeObjectURL(f.url);
  frames.set(list.filter((x) => x.id !== id));
  if (impacts.length > 0) {
    clips.set(removeFrameFromClips(get(clips), id));
  }
  if (get(selectedId) === id) selectedId.set(null);
  packResult.set(null);
  pendingDelete.set(null);
  if (impacts.length > 0) {
    notify(`已删除帧并从 ${impacts.length} 个片段中移除引用`);
  }
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
  clips.set([]);
  selectedClipId.set(null);
  packResult.set(null);
  pendingDelete.set(null);
  lastJSON = null;
}

// ---------- 片段管理 ----------

export function selectClip(id: string): void {
  selectedClipId.set(id);
}

/** 新建空片段并选中 */
export function newClip(name?: string): Clip | null {
  const list = get(clips);
  const finalName = uniqueClipName(name?.trim() || "新片段", list);
  const clip = createClip(finalName);
  clips.set([...list, clip]);
  selectedClipId.set(clip.id);
  return clip;
}

/** 以当前全部帧、当前帧时长创建片段 */
export function newClipFromAllFrames(): Clip | null {
  const all = get(frames);
  if (all.length === 0) {
    notify("请先导入帧", "error");
    return null;
  }
  const list = get(clips);
  const clip = defaultClipFromFrames(all, uniqueClipName("新片段", list));
  clips.set([...list, clip]);
  selectedClipId.set(clip.id);
  return clip;
}

export function duplicateClip(id: string): void {
  const list = get(clips);
  const src = list.find((c) => c.id === id);
  if (!src) return;
  const copy: Clip = {
    ...src,
    id: uid(),
    name: uniqueClipName(`${src.name} 副本`, list),
    frames: src.frames.map((r) => ({ ...r }))
  };
  clips.set([...list, copy]);
  selectedClipId.set(copy.id);
}

export function deleteClip(id: string): void {
  const list = get(clips);
  if (list.length <= 1) {
    notify("至少保留一个片段", "error");
    return;
  }
  const next = list.filter((c) => c.id !== id);
  clips.set(next);
  if (get(selectedClipId) === id) selectedClipId.set(next[0]?.id ?? null);
}

function patchClip(id: string, fn: (c: Clip) => Clip): void {
  clips.set(get(clips).map((c) => (c.id === id ? fn(c) : c)));
}

export function addFrameToClip(clipId: string, frameId: string): void {
  const clip = get(clips).find((c) => c.id === clipId);
  const frame = get(frames).find((f) => f.id === frameId);
  if (!clip || !frame) return;
  patchClip(clipId, (c) => addClipFrame(c, frame));
}

export function removeClipFrameRef(clipId: string, refIndex: number): void {
  patchClip(clipId, (c) => removeClipRef(c, refIndex));
}

export function moveClipFrameRef(clipId: string, refIndex: number, dir: -1 | 1): void {
  patchClip(clipId, (c) => moveClipRef(c, refIndex, dir));
}

export function setClipFrameDuration(clipId: string, refIndex: number, ms: number): void {
  patchClip(clipId, (c) => setClipRefDuration(c, refIndex, ms));
}

export function setClipFrameEvent(clipId: string, refIndex: number, event: string): void {
  patchClip(clipId, (c) => setClipRefEvent(c, refIndex, event));
}

export function setClipMode(clipId: string, mode: Clip["loop"]): void {
  patchClip(clipId, (c) => setClipLoop(c, mode));
}

export function commitClipRename(clipId: string, name: string): void {
  const all = get(clips);
  const clip = all.find((c) => c.id === clipId);
  if (!clip) return;
  const renamed = renameClip(clip, name, all);
  if (renamed !== clip) clips.set(all.map((c) => (c.id === clipId ? renamed : c)));
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
  // 始终用当前片段重建一次，保证打包后又编辑过的片段也进入导出
  const fresh = buildAtlasJSON(
    { atlasWidth: p.atlasWidth, atlasHeight: p.atlasHeight, frames: p.frames },
    { imageName: lastJSON.meta.image, trimmed: p.trimmed, settings: s, clips: get(clips) }
  );
  lastJSON = fresh;
  let json = fresh;
  if (s.embedAtlas) {
    const dataURL = canvasToDataURL(await blobToCanvas(p.atlasBlob));
    json = { ...fresh, meta: { ...fresh.meta, atlasDataURL: dataURL } };
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
 * 从导出的 JSON 恢复帧列表、时长、动画片段与打包结果。
 * 图集图片来源：JSON 内嵌的 atlasDataURL，或用户同时选择的 atlas.png。
 * 旧格式（无 meta.clips）自动创建一个包含全部帧的默认片段。
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

    // 片段恢复：帧名 → 恢复后帧 id；旧格式 → 默认片段
    const byName = new Map(restored.map((f) => [f.name, f]));
    let restoredClips: Clip[];
    if (parsed.clips) {
      restoredClips = [];
      for (const dto of parsed.clips) {
        // 处理重名片段
        const name = uniqueClipName(dto.name, restoredClips);
        restoredClips.push(clipFromDTO({ ...dto, name }, byName));
      }
      if (restoredClips.length === 0) {
        restoredClips = [defaultClipFromFrames(restored)];
      }
    } else {
      restoredClips = [defaultClipFromFrames(restored)];
    }

    clearAll();
    frames.set(restored);
    clips.set(restoredClips);
    selectedClipId.set(restoredClips[0]?.id ?? null);
    settings.set({ ...parsed.settings });
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
      {
        imageName: parsed.imageName,
        trimmed: parsed.settings.trim,
        settings: parsed.settings,
        clips: restoredClips
      }
    );
    notify(`已从 JSON 恢复 ${restored.length} 帧、${restoredClips.length} 个片段与打包结果`);
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
      toStored(get(frames), get(settings), get(packResult), lastJSON, get(clips))
    );
    notify("项目已保存到浏览器本地");
  } catch (e) {
    notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** 校验并清洗存储中的片段（旧数据/异常数据兜底） */
function sanitizeClips(raw: unknown, validFrames: FrameItem[]): Clip[] {
  if (!Array.isArray(raw)) return [];
  const validIds = new Set(validFrames.map((f) => f.id));
  const out: Clip[] = [];
  for (const [i, c] of raw.entries()) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : `片段 ${i + 1}`;
    const loop = o.loop === "once" || o.loop === "pingpong" ? o.loop : "loop";
    const refsRaw = Array.isArray(o.frames) ? o.frames : [];
    const frames2 = refsRaw
      .map((r): Clip["frames"][number] | null => {
        if (typeof r !== "object" || r === null) return null;
        const ro = r as Record<string, unknown>;
        if (typeof ro.frameId !== "string" || !validIds.has(ro.frameId)) return null;
        const duration =
          typeof ro.duration === "number" && Number.isFinite(ro.duration) && ro.duration > 0
            ? Math.max(1, Math.round(ro.duration))
            : 100;
        const ref: Clip["frames"][number] = { frameId: ro.frameId, duration };
        if (typeof ro.event === "string" && ro.event.trim()) ref.event = ro.event.trim();
        return ref;
      })
      .filter((r): r is Clip["frames"][number] => r !== null);
    out.push({ id: typeof o.id === "string" && o.id ? o.id : uid(), name, loop, frames: frames2 });
  }
  return pruneClipRefs(out, validIds);
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

    // 片段：v2 且记录了 clips 字段时恢复；旧版本（v1，无 clips）自动生成默认片段
    let restoredClips: Clip[] = [];
    if (stored.version >= 2 && Array.isArray(stored.clips)) {
      restoredClips = sanitizeClips(stored.clips, restored);
    }
    if (restoredClips.length === 0) {
      // v1 旧数据或片段引用全部失效：兜底创建默认片段
      restoredClips = [defaultClipFromFrames(restored)];
    }
    clips.set(restoredClips);
    selectedClipId.set(restoredClips[0]?.id ?? null);

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
      toStored(get(frames), get(settings), get(packResult), lastJSON, get(clips))
    ).catch(() => {});
  }, 600);
}

export function startAutoSave(): void {
  frames.subscribe(() => scheduleSave());
  settings.subscribe(() => scheduleSave());
  packResult.subscribe(() => scheduleSave());
  clips.subscribe(() => scheduleSave());
}
