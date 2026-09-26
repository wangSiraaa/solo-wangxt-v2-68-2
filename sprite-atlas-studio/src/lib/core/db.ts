import { openDB, type IDBPDatabase } from "idb";
import type { Clip, FrameItem, PackResult, Settings } from "./types";
import type { AtlasJSON } from "./serialize";

/**
 * IndexedDB 持久化：帧 PNG（Blob）、时长、设置、动画片段与最近一次打包结果
 * 全部保存在浏览器本地，不上传任何数据。
 */

const DB_NAME = "sprite-atlas-studio";
const STORE = "kv";
const PROJECT_KEY = "project";

export interface StoredPack {
  json: AtlasJSON;
  atlasBlob: Blob;
}

/** 持久化用的片段结构（可结构化克隆，不含 Blob） */
export type StoredClip = Clip;

export interface StoredProject {
  /** 1=旧格式（无 clips，恢复时自动生成默认片段）；2=含 clips */
  version: number;
  savedAt: number;
  settings: Settings;
  frames: Array<{
    id: string;
    name: string;
    duration: number;
    width: number;
    height: number;
    blob: Blob;
  }>;
  clips: StoredClip[];
  pack: StoredPack | null;
}

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    }
  });
}

export async function saveProject(p: StoredProject): Promise<void> {
  const d = await db();
  await d.put(STORE, p, PROJECT_KEY);
}

export async function loadProject(): Promise<StoredProject | null> {
  const d = await db();
  const v = (await d.get(STORE, PROJECT_KEY)) as StoredProject | undefined;
  return v ?? null;
}

export async function clearProject(): Promise<void> {
  const d = await db();
  await d.delete(STORE, PROJECT_KEY);
}

/** 由运行时状态构造可存储对象 */
export function toStored(
  frames: FrameItem[],
  settings: Settings,
  pack: PackResult | null,
  json: AtlasJSON | null,
  clips: Clip[]
): StoredProject {
  return {
    version: 2,
    savedAt: Date.now(),
    settings: { ...settings },
    frames: frames.map((f) => ({
      id: f.id,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      blob: f.blob
    })),
    // 片段只含字符串/数字/数组，结构化克隆可直接存储
    clips: clips.map((c) => ({ ...c, frames: c.frames.map((r) => ({ ...r })) })),
    pack: pack && json ? { json, atlasBlob: pack.atlasBlob } : null
  };
}
