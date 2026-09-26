<script lang="ts">
  import { get } from "svelte/store";
  import { onDestroy, onMount } from "svelte";
  import { Application, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
  import { ClipAnimator } from "../core/animator";
  import { clips, frames, packResult, selectedClipId, selectedId } from "../core/store";
  import type { Clip } from "../core/types";

  interface LogEntry {
    key: number;
    event: string;
    clipName: string;
    frameName: string;
    /** 片段内播放到该事件的时间（ms） */
    t: number;
  }

  let wrap: HTMLDivElement;
  let app: Application | null = null;
  let sprite: Sprite | null = null;
  let border: Graphics | null = null;

  const animator = new ClipAnimator({ durations: [], events: [], mode: "loop" });
  // 用户的播放意图（暂停/播放按钮）
  let wantPlay = true;

  // 纯播放态：仅由 Pixi ticker 在普通闭包中读写，绝不声明为响应式变量，
  // 避免每次 tick 触发 Svelte 重新执行片段配置（否则动画器会被反复重置回首帧）。
  const run = {
    curRefIndex: -1,
    finished: false,
    elapsedMs: 0
  };

  // 同步到 UI 的响应式镜像（由 syncUi 周期性更新）
  let curName = "";
  let curDuration = 0;
  let curAtlasInfo = "";
  let curOffsetInfo = "";
  let curEvent = "";
  let playing = true;
  let logs: LogEntry[] = [];
  let logSeq = 0;

  let textures = new Map<string, Texture>();
  let baseTexture: Texture | null = null;
  let rebuildToken = 0;
  let baseX = 0;
  let baseY = 0;
  let stageScale = 1;

  let currentClip: Clip | null = null;
  let lastConfiguredSig = "";
  let lastLoggedClipId: string | null = null;

  $: clip =
    $clips.find((c) => c.id === $selectedClipId) ?? $clips[0] ?? null;
  // 仅依赖片段原始数据签名，保证只有片段真正变化时才重配动画器
  $: clipSig = clip
    ? clip.id +
      "|" +
      clip.loop +
      "|" +
      clip.frames.map((r) => `${r.frameId}:${r.duration}:${r.event ?? ""}`).join(",")
    : "";

  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = url;
    });
  }

  function disposeTextures(): void {
    for (const t of textures.values()) t.destroy(false);
    textures = new Map();
    if (baseTexture) {
      baseTexture.destroy(true);
      baseTexture = null;
    }
  }

  async function rebuild(): Promise<void> {
    const token = ++rebuildToken;
    if (!app) return;
    const list = get(frames);
    const pack = get(packResult);

    disposeTextures();

    if (list.length === 0) {
      if (sprite) sprite.visible = false;
      run.curRefIndex = -1;
      return;
    }

    if (pack) {
      // 引擎视角：从图集取子纹理，按裁切偏移摆回原始位置
      const img = await loadImage(pack.atlasUrl);
      if (token !== rebuildToken) return;
      baseTexture = Texture.from(img);
      for (const f of pack.frames) {
        textures.set(
          f.id,
          new Texture({ source: baseTexture.source, frame: new Rectangle(f.x, f.y, f.w, f.h) })
        );
      }
    } else {
      const imgs = await Promise.all(list.map((f) => loadImage(f.url)));
      if (token !== rebuildToken) return;
      list.forEach((f, i) => {
        textures.set(f.id, Texture.from(imgs[i]!));
      });
    }

    layoutStage();
  }

  function layoutStage(): void {
    if (!app || !sprite) return;
    const list = get(frames);
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

  function paintRef(refIndex: number): void {
    if (!sprite) return;
    const c = currentClip;
    if (!c) return;
    const ref = c.frames[refIndex];
    if (!ref) {
      sprite.visible = false;
      return;
    }
    const tex = textures.get(ref.frameId);
    if (!tex) return;
    const item = get(frames).find((f) => f.id === ref.frameId);
    const pf = get(packResult)?.frames.find((p) => p.id === ref.frameId);
    const off = pf ? { x: pf.trim.x, y: pf.trim.y } : { x: 0, y: 0 };

    sprite.texture = tex;
    sprite.visible = true;
    sprite.position.set(baseX + off.x * stageScale, baseY + off.y * stageScale);

    run.curRefIndex = refIndex;
    selectedId.set(item?.id ?? null);
  }

  function pushEventLog(ev: { refIndex: number; name: string }): void {
    const c = currentClip;
    if (!c) return;
    const ref = c.frames[ev.refIndex];
    const item = ref ? get(frames).find((f) => f.id === ref.frameId) : undefined;
    const entry: LogEntry = {
      key: logSeq++,
      event: ev.name,
      clipName: c.name,
      frameName: item?.name ?? "",
      t: run.elapsedMs
    };
    logs = [entry, ...logs].slice(0, 100);
  }

  /** 片段真正变化时（重新）配置动画器并从头播放 */
  function configureClip(c: Clip | null, sig: string): void {
    if (!app) return;
    if (sig === lastConfiguredSig) return;
    lastConfiguredSig = sig;
    currentClip = c;

    if (!c || c.frames.length === 0) {
      run.curRefIndex = -1;
      run.finished = false;
      run.elapsedMs = 0;
      if (sprite) sprite.visible = false;
      return;
    }

    if (lastLoggedClipId !== c.id) {
      logs = [];
      lastLoggedClipId = c.id;
    }
    animator.configure({
      durations: c.frames.map((r) => r.duration),
      events: c.frames.map((r) => r.event),
      mode: c.loop
    });
    run.elapsedMs = 0;
    run.finished = false;
    wantPlay = true;
    paintRef(0);
  }

  /** 从纯播放态同步到响应式 UI 字段（在 ticker 内调用） */
  function syncUi(): void {
    const c = currentClip;
    const i = run.curRefIndex;
    playing = wantPlay && !run.finished;
    if (!c || i < 0) {
      curName = "";
      curDuration = 0;
      curAtlasInfo = "";
      curOffsetInfo = "";
      curEvent = "";
      return;
    }
    const ref = c.frames[i];
    const item = ref ? get(frames).find((f) => f.id === ref.frameId) : undefined;
    const pf = ref ? get(packResult)?.frames.find((p) => p.id === ref.frameId) : undefined;
    curName = item?.name ?? "";
    curDuration = ref?.duration ?? 0;
    curEvent = ref?.event ?? "";
    curAtlasInfo = pf ? `图集 (${pf.x}, ${pf.y}) ${pf.w}×${pf.h}` : "未打包";
    curOffsetInfo = pf ? `偏移 (${pf.trim.x}, ${pf.trim.y}) 原始 ${pf.srcW}×${pf.srcH}` : "";
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
      animator.playing = wantPlay;
      const res = animator.tick(ticker.deltaMS);
      if (wantPlay && !res.finished) run.elapsedMs += ticker.deltaMS;
      for (const ev of res.events) pushEventLog(ev);
      if (res.finished) {
        run.finished = true;
        wantPlay = false;
      } else {
        run.finished = false;
      }
      if (res.index >= 0 && res.index !== run.curRefIndex) paintRef(res.index);
      // 只更新一个原始计数器驱动 UI 同步，避免触发片段重配
      syncUi();
    });
    app.renderer.on("resize", () => layoutStage());

    await rebuild();
  });

  onDestroy(() => {
    disposeTextures();
    app?.destroy(true, { children: true, texture: true });
    app = null;
  });

  // 帧集合或打包结果变化 → 重建纹理
  $: frameKey = $frames.map((f) => f.id).join(",");
  $: packKey = $packResult ? $packResult.atlasUrl : "";
  $: if (app) {
    void frameKey;
    void packKey;
    void rebuild();
  }

  // 片段内容变化（顺序/时长/事件/模式/选择）→ 重配动画器
  $: if (app) configureClip(clip, clipSig);

  function togglePlay(): void {
    if (run.finished) {
      restart();
      return;
    }
    wantPlay = !wantPlay;
  }

  function restart(): void {
    animator.restart();
    run.elapsedMs = 0;
    run.finished = false;
    wantPlay = true;
    paintRef(0);
  }

  function selectClipById(e: Event): void {
    const id = (e.currentTarget as HTMLSelectElement).value;
    if (id) selectedClipId.set(id);
  }

  const MODE_LABEL: Record<Clip["loop"], string> = {
    loop: "循环",
    once: "单次",
    pingpong: "往返"
  };
</script>

<div class="panel">
  <h2>动画预览（PixiJS · 按片段真实时长播放）</h2>

  <div class="clip-bar">
    <label class="clip-select">
      片段
      <select id="preview-clip-select" value={clip?.id ?? ""} on:change={selectClipById}>
        {#each $clips as c (c.id)}
          <option value={c.id}>{c.name}（{MODE_LABEL[c.loop]} · {c.frames.length} 帧）</option>
        {/each}
      </select>
    </label>
    {#if clip}
      <span class="mono dim mode-label" id="preview-mode-label" data-mode={clip.loop}>
        {MODE_LABEL[clip.loop]}
      </span>
    {/if}
  </div>

  <div class="stage checker" bind:this={wrap} data-testid="preview-stage"></div>
  <div class="controls">
    <button id="play-btn" on:click={togglePlay}>
      {run.finished ? "↺ 重新播放" : playing ? "⏸ 暂停" : "▶ 播放"}
    </button>
    <button id="restart-btn" on:click={restart}>↺ 回到开头</button>
    <span class="mono info" id="preview-frame-label">
      {#if clip && run.curRefIndex >= 0}
        帧 {run.curRefIndex + 1}/{clip.frames.length} · {curName} · {curDuration}ms
        {#if curEvent}<span class="event-tag" data-current-event={curEvent}>⚡{curEvent}</span>{/if}
      {:else if clip}
        空片段
      {:else}
        无片段
      {/if}
    </span>
  </div>
  <div class="mono dim" id="preview-atlas-info">
    {#if run.curRefIndex >= 0}
      {curAtlasInfo}{curOffsetInfo ? ` · ${curOffsetInfo}` : ""}
    {/if}
  </div>

  <div class="log-wrap">
    <div class="log-head">
      <span>事件日志</span>
      <button id="clear-log-btn" on:click={() => (logs = [])}>清空</button>
    </div>
    {#if logs.length === 0}
      <div class="dim small log-empty" data-testid="event-log-empty">播放进入带事件标记的帧时在此记录。</div>
    {:else}
      <ul class="event-log" data-testid="event-log" id="event-log">
        {#each logs as log (log.key)}
          <li data-event-name={log.event} data-event-clip={log.clipName}>
            <span class="mono t">{log.t}ms</span>
            <span class="ev">⚡ {log.event}</span>
            <span class="dim">@ {log.clipName} / {log.frameName}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .clip-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 0;
  }
  .clip-select {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .clip-select select {
    max-width: 280px;
  }
  .mode-label {
    font-size: 12px;
  }
  .stage {
    width: 100%;
    height: 300px;
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
  }
  .info {
    color: var(--text);
  }
  .event-tag {
    color: #ffd166;
    margin-left: 6px;
  }
  .dim {
    color: var(--text-dim);
  }
  .log-wrap {
    margin-top: 10px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .event-log {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 150px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
  }
  .event-log li {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .event-log .t {
    width: 64px;
    color: var(--text-dim);
  }
  .event-log .ev {
    color: #ffd166;
  }
  .small {
    font-size: 12px;
  }
</style>
