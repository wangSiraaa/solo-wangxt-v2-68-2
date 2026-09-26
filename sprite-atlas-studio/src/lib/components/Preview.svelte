<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Application, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
  import { Animator, ClipPlayer } from "../core/animator";
  import { activeClipId, clips, frames, packResult, selectedId, setActiveClip } from "../core/store";
  import { LOOP_LABELS } from "../core/clips";
  import type { ClipEntry, PackedFrame } from "../core/types";

  let wrap: HTMLDivElement;
  let app: Application | null = null;
  let sprite: Sprite | null = null;
  let border: Graphics | null = null;

  const animator = new Animator([]);
  const player = new ClipPlayer([], "loop");
  let playing = true;

  // 播放来源：all = 原始序列（全部帧）；clip = 选中的动画片段
  let mode: "all" | "clip" = "all";
  /** 当前片段条目解析结果：条目 + 对应帧下标（剔除已删除帧） */
  let activeEntries: Array<{ entry: ClipEntry; frameIndex: number }> = [];

  // 当前展示的帧信息（用于面板与测试断言）
  let curIndex = -1;
  let curEntryIndex = -1;
  let curName = "";
  let curDuration = 0;
  let curAtlasInfo = "";
  let curOffsetInfo = "";
  let clipFinished = false;

  interface LogItem {
    id: number;
    time: string;
    event: string;
    text: string;
  }
  let eventLog: LogItem[] = [];
  let logSeq = 0;
  let lastSourceKey = "";

  let textures: Texture[] = [];
  let offsets: Array<{ x: number; y: number }> = [];
  let packedFrames: PackedFrame[] | null = null;
  let baseTexture: Texture | null = null;
  let rebuildToken = 0;
  let baseX = 0;
  let baseY = 0;
  let stageScale = 1;

  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = url;
    });
  }

  function disposeTextures(): void {
    for (const t of textures) t.destroy(false);
    textures = [];
    if (baseTexture) {
      baseTexture.destroy(true);
      baseTexture = null;
    }
  }

  async function rebuild(): Promise<void> {
    const token = ++rebuildToken;
    if (!app) return;
    const list = $frames;
    const pack = $packResult;

    disposeTextures();
    offsets = [];
    packedFrames = pack ? pack.frames : null;
    animator.reset();

    if (list.length === 0) {
      if (sprite) sprite.visible = false;
      curIndex = -1;
      curEntryIndex = -1;
      curName = "";
      curAtlasInfo = "";
      curOffsetInfo = "";
      return;
    }

    if (pack) {
      // 引擎视角：从图集取子纹理，按裁切偏移摆回原始位置
      const img = await loadImage(pack.atlasUrl);
      if (token !== rebuildToken) return;
      baseTexture = Texture.from(img);
      textures = pack.frames.map(
        (f) => new Texture({ source: baseTexture!.source, frame: new Rectangle(f.x, f.y, f.w, f.h) })
      );
      offsets = pack.frames.map((f) => ({ x: f.trim.x, y: f.trim.y }));
    } else {
      const imgs = await Promise.all(list.map((f) => loadImage(f.url)));
      if (token !== rebuildToken) return;
      textures = imgs.map((img) => Texture.from(img));
      offsets = list.map(() => ({ x: 0, y: 0 }));
    }

    layoutStage();
    if (sprite) {
      if (mode === "clip") {
        if (activeEntries.length > 0) {
          applyClipFrame(Math.min(player.index, activeEntries.length - 1));
        } else {
          sprite.visible = false;
        }
      } else {
        sprite.visible = true;
        applyFrame(0);
      }
    }
  }

  function layoutStage(): void {
    if (!app || !sprite) return;
    const list = $frames;
    if (list.length === 0) return;
    const maxW = Math.max(...list.map((f) => f.width));
    const maxH = Math.max(...list.map((f) => f.height));
    const cw = app.renderer.width / app.renderer.resolution;
    const ch = app.renderer.height / app.renderer.resolution;
    stageScale = Math.max(0.05, Math.min(cw / maxW, ch / maxH) * 0.85);
    baseX = (cw - maxW * stageScale) / 2;
    baseY = (ch - maxH * stageScale) / 2;
    sprite.scale.set(stageScale);
    if (border) {
      border.clear();
      border.rect(0, 0, maxW, maxH).stroke({ width: 1, color: 0x4f8cff, alpha: 0.5 });
      border.scale.set(stageScale);
      border.position.set(baseX, baseY);
    }
  }

  function applyFrame(i: number): void {
    if (!sprite || i < 0 || i >= textures.length) return;
    const tex = textures[i];
    const off = offsets[i];
    if (!tex || !off) return;
    sprite.visible = true;
    sprite.texture = tex;
    sprite.position.set(baseX + off.x * stageScale, baseY + off.y * stageScale);

    curIndex = i;
    const list = $frames;
    const item = list[i];
    curName = item?.name ?? "";
    curDuration = item?.duration ?? 0;
    const pf = packedFrames?.[i];
    curAtlasInfo = pf ? `图集 (${pf.x}, ${pf.y}) ${pf.w}×${pf.h}` : "未打包";
    curOffsetInfo = pf ? `偏移 (${pf.trim.x}, ${pf.trim.y}) 原始 ${pf.srcW}×${pf.srcH}` : "";
    selectedId.set(item?.id ?? null);
  }

  /** 片段模式：展示第 entryIdx 个条目（时长取自条目，与帧列表互不影响） */
  function applyClipFrame(entryIdx: number): void {
    const a = activeEntries[entryIdx];
    if (!a) {
      curEntryIndex = -1;
      return;
    }
    applyFrame(a.frameIndex);
    curEntryIndex = entryIdx;
    curDuration = Math.max(1, a.entry.duration);
  }

  function nowStamp(): string {
    const d = new Date();
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function pushLog(event: string, text: string): void {
    eventLog = [...eventLog.slice(-49), { id: logSeq++, time: nowStamp(), event, text }];
  }

  /** 进入片段第 entryIdx 帧时触发其事件标记 */
  function logClipEvents(entryIdx: number): void {
    const a = activeEntries[entryIdx];
    const ev = a?.entry.event;
    if (!a || !ev) return;
    const name = $frames[a.frameIndex]?.name ?? "";
    pushLog(ev, `事件 "${ev}" · 帧 ${entryIdx + 1}（${name}）`);
  }

  /** 根据当前选中片段配置播放器（片段内容/循环模式/帧集合变化时调用） */
  function configureClip(): void {
    const clip = $clips.find((c) => c.id === $activeClipId) ?? null;
    const sourceKey = clip ? `clip:${clip.id}` : "all";
    if (sourceKey !== lastSourceKey) {
      lastSourceKey = sourceKey;
      eventLog = [];
    }
    if (!clip) {
      mode = "all";
      activeEntries = [];
      curEntryIndex = -1;
      clipFinished = false;
      // 切回原始序列时从当前展示的帧继续，避免跳帧
      const n = $frames.length;
      if (n > 0) animator.index = Math.min(Math.max(curIndex, 0), n - 1);
      return;
    }
    mode = "clip";
    const idxById = new Map($frames.map((f, i) => [f.id, i] as const));
    activeEntries = clip.entries.flatMap((entry) => {
      const frameIndex = idxById.get(entry.frameId);
      return frameIndex === undefined ? [] : [{ entry, frameIndex }];
    });
    player.setClip(activeEntries.map((a) => a.entry.duration), clip.loop);
    player.playing = playing;
    clipFinished = false;
    if (activeEntries.length > 0) {
      applyClipFrame(0);
      logClipEvents(0);
    } else {
      curEntryIndex = -1;
      if (sprite) sprite.visible = false;
    }
  }

  onMount(async () => {
    app = new Application();
    await app.init({
      backgroundAlpha: 0,
      antialias: false,
      resizeTo: wrap
    });
    app.canvas.style.imageRendering = "pixelated";
    wrap.appendChild(app.canvas);

    border = new Graphics();
    sprite = new Sprite();
    app.stage.addChild(border);
    app.stage.addChild(sprite);

    app.ticker.add((ticker) => {
      if (mode === "clip") {
        player.playing = playing;
        const entered = player.tick(ticker.deltaMS);
        for (const idx of entered) {
          applyClipFrame(idx);
          logClipEvents(idx);
        }
        clipFinished = player.finished;
      } else {
        animator.playing = playing;
        const i = animator.tick(ticker.deltaMS);
        if (i !== curIndex && i >= 0) applyFrame(i);
      }
    });
    app.renderer.on("resize", () => layoutStage());

    await rebuild();
  });

  onDestroy(() => {
    disposeTextures();
    app?.destroy(true, { children: true, texture: true });
    app = null;
  });

  $: activeClip = $clips.find((c) => c.id === $activeClipId) ?? null;

  // 帧集合或打包结果变化 → 重建纹理；时长变化 → 只更新动画器
  $: frameKey = $frames.map((f) => f.id).join(",");
  $: packKey = $packResult ? $packResult.atlasUrl : "";
  $: if (app) {
    void frameKey;
    void packKey;
    void rebuild();
  }
  $: if (app) {
    animator.setDurations($frames.map((f) => f.duration));
  }

  // 片段选择/内容/循环模式/帧集合变化 → 重新配置片段播放器
  $: clipKey = activeClip
    ? `${activeClip.id}|${activeClip.loop}|${activeClip.entries
        .map((e) => `${e.frameId}:${e.duration}:${e.event ?? ""}`)
        .join(",")}`
    : "";
  $: if (app) {
    void clipKey;
    void frameKey;
    configureClip();
  }

  function togglePlay(): void {
    playing = !playing;
    // 单次模式播完后再次播放 → 从头开始
    if (playing && mode === "clip" && player.finished) {
      player.reset();
      if (activeEntries.length > 0) {
        applyClipFrame(0);
        logClipEvents(0);
      }
      clipFinished = false;
    }
  }

  function onSourceChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    setActiveClip(v === "" ? null : v);
  }
</script>

<div class="panel">
  <h2>动画预览（PixiJS · 按真实时长播放）</h2>
  <div class="stage checker" bind:this={wrap} data-testid="preview-stage"></div>
  <div class="controls">
    <button id="play-btn" on:click={togglePlay}>{playing ? "⏸ 暂停" : "▶ 播放"}</button>
    <select
      id="clip-select"
      title="选择播放来源"
      value={$activeClipId ?? ""}
      on:change={onSourceChange}
    >
      <option value="">原始序列（全部帧）</option>
      {#each $clips as c (c.id)}
        <option value={c.id}>{c.name}（{LOOP_LABELS[c.loop]}）</option>
      {/each}
    </select>
    <span class="mono info" id="preview-frame-label">
      {#if mode === "clip" && activeClip}
        {#if curEntryIndex >= 0}
          片段「{activeClip.name}」· 帧 {curEntryIndex + 1}/{activeEntries.length} · {curName} · {curDuration}ms
          · {LOOP_LABELS[activeClip.loop]}{clipFinished ? " · 已结束" : ""}
        {:else}
          片段「{activeClip.name}」· 无帧
        {/if}
      {:else if curIndex >= 0}
        帧 {curIndex + 1}/{$frames.length} · {curName} · {curDuration}ms
      {:else}
        无帧
      {/if}
    </span>
  </div>
  <div class="mono dim" id="preview-atlas-info">
    {#if curIndex >= 0}
      {curAtlasInfo}{curOffsetInfo ? ` · ${curOffsetInfo}` : ""}
    {/if}
  </div>
  <div class="event-log-head">
    <span class="dim">事件日志（{eventLog.length}）</span>
    <button id="clear-log-btn" on:click={() => (eventLog = [])}>清除</button>
  </div>
  <div id="event-log" data-testid="event-log">
    {#if eventLog.length === 0}
      <div class="dim log-empty">暂无事件。为片段条目设置事件标记后，播放到该帧即在此记录。</div>
    {:else}
      {#each eventLog as item (item.id)}
        <div class="event-item mono" data-event={item.event}>{item.time} · {item.text}</div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .stage {
    width: 100%;
    height: 380px;
    border-radius: 8px;
    overflow: hidden;
    position: relative;
  }
  .stage :global(canvas) {
    display: block;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .info {
    color: var(--text);
  }
  .dim {
    color: var(--text-dim);
  }
  #preview-atlas-info {
    margin-top: 6px;
    min-height: 16px;
  }
  .event-log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .event-log-head button {
    padding: 2px 8px;
    font-size: 12px;
  }
  #event-log {
    margin-top: 4px;
    max-height: 110px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    background: var(--panel-2);
    font-size: 12px;
  }
  .event-item {
    padding: 1px 0;
    color: var(--accent-2);
  }
  .log-empty {
    padding: 4px 0;
  }
</style>
