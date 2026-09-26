<script lang="ts">
  import {
    addFrameToClip,
    clips,
    commitClipRename,
    deleteClip,
    duplicateClip,
    frameCount,
    frames,
    moveClipFrameRef,
    newClipFromAllFrames,
    removeClipFrameRef,
    selectClip,
    selectedClipId,
    setClipFrameDuration,
    setClipFrameEvent,
    setClipMode
  } from "../core/store";
  import { clipForwardDuration } from "../core/clips";
  import { clipCycleDuration } from "../core/animator";
  import type { Clip } from "../core/types";

  const MODE_LABEL: Record<Clip["loop"], string> = {
    loop: "循环",
    once: "单次",
    pingpong: "往返"
  };

  $: clip =
    $clips.find((c) => c.id === $selectedClipId) ?? $clips[0] ?? null;
  $: frameById = new Map($frames.map((f) => [f.id, f]));
  $: available = clip ? $frames.filter((f) => !clip!.frames.some((r) => r.frameId === f.id)) : [];
  $: forwardMs = clip ? clipForwardDuration(clip) : 0;
  $: cycleMs = clip ? clipCycleDuration(
      clip.frames.map((r) => r.duration),
      clip.loop
    ) : 0;

  let renameDraft = "";

  function startRename(c: Clip) {
    renameDraft = c.name;
  }

  // 切换选中片段时同步重名草稿
  $: if (clip) renameDraft = clip.name;
</script>

<div class="panel clips-panel">
  <div class="head">
    <h2>动画片段</h2>
    <button
      id="new-clip-btn"
      disabled={$frameCount === 0}
      title="按当前全部帧与帧时长新建片段"
      on:click={() => newClipFromAllFrames()}
    >
      ＋ 新建片段
    </button>
  </div>

  {#if $clips.length === 0}
    <div class="empty">尚无片段。导入帧后会自动创建默认片段，或点击「新建片段」。</div>
  {:else}
    <div class="clip-tabs" role="tablist" aria-label="片段列表">
      {#each $clips as c (c.id)}
        <button
          class="tab"
          class:active={clip?.id === c.id}
          role="tab"
          aria-selected={clip?.id === c.id}
          data-clip-tab={c.name}
          on:click={() => selectClip(c.id)}
        >
          {c.name}
          <span class="mode-tag">{MODE_LABEL[c.loop]}</span>
        </button>
      {/each}
    </div>

    {#if clip}
      <div class="editor">
        <div class="row clip-props">
          <input
            class="name-input"
            aria-label="片段名称"
            data-clip-name-input={clip.name}
            value={renameDraft}
            on:input={(e) => (renameDraft = e.currentTarget.value)}
            on:change={() => commitClipRename(clip.id, renameDraft)}
            on:focus={() => startRename(clip)}
          />
          <label class="mode-select">
            循环模式
            <select
              data-clip-mode={clip.name}
              value={clip.loop}
              on:change={(e) => setClipMode(clip.id, e.currentTarget.value as Clip["loop"])}
            >
              <option value="loop">循环</option>
              <option value="once">单次（停在末帧）</option>
              <option value="pingpong">往返（端点不重复）</option>
            </select>
          </label>
        </div>

        <div class="row ops">
          <button data-duplicate-clip={clip.name} on:click={() => duplicateClip(clip.id)}>
            复制片段
          </button>
          <button
            class="danger"
            data-delete-clip={clip.name}
            disabled={$clips.length <= 1}
            title={$clips.length <= 1 ? "至少保留一个片段" : "删除该片段"}
            on:click={() => deleteClip(clip.id)}
          >
            删除片段
          </button>
          <span class="dim mono duration-sum" data-clip-duration={clip.name}>
            正向 {forwardMs}ms{#if clip.loop === "pingpong"} · 一轮往返 {cycleMs}ms{/if}
          </span>
        </div>

        <ol class="refs" data-clip-refs={clip.name}>
          {#each clip.frames as ref, i (i)}
            {@const f = frameById.get(ref.frameId)}
            <li class="ref-item" data-ref-index={i}>
              <span class="idx mono">{i + 1}</span>
              {#if f}
                <span class="thumb checker"><img src={f.url} alt={f.name} /></span>
                <span class="meta">
                  <span class="name" title={f.name}>{f.name}</span>
                  <span class="line">
                    <input
                      class="dur"
                      type="number"
                      min="1"
                      aria-label="该片段内单帧时长"
                      data-ref-duration-for={clip.name}
                      value={ref.duration}
                      on:change={(e) =>
                        setClipFrameDuration(clip.id, i, Number(e.currentTarget.value))}
                    />
                    ms
                    <input
                      class="event"
                      type="text"
                      placeholder="事件名（可选）"
                      aria-label="事件标记"
                      data-ref-event-for={clip.name}
                      value={ref.event ?? ""}
                      on:change={(e) => setClipFrameEvent(clip.id, i, e.currentTarget.value)}
                    />
                    {#if ref.event}
                      <span class="event-flag" data-event-flag={ref.event}>⚡ {ref.event}</span>
                    {/if}
                  </span>
                </span>
              {:else}
                <span class="dim">失效引用</span>
              {/if}
              <span class="ref-ops">
                <button title="上移" on:click={() => moveClipFrameRef(clip.id, i, -1)}>↑</button>
                <button title="下移" on:click={() => moveClipFrameRef(clip.id, i, 1)}>↓</button>
                <button
                  title="从片段移除"
                  class="danger"
                  on:click={() => removeClipFrameRef(clip.id, i)}
                >
                  ✕
                </button>
              </span>
            </li>
          {/each}
        </ol>
        {#if clip.frames.length === 0}
          <div class="dim small">该片段还没有帧，从下方添加。</div>
        {/if}

        {#if available.length > 0}
          <div class="add-zone">
            <div class="dim small">添加帧到片段末尾：</div>
            <div class="add-list">
              {#each available as f (f.id)}
                <button
                  class="add-btn"
                  data-add-frame={`${clip.name}|${f.name}`}
                  title={`添加 ${f.name}`}
                  on:click={() => addFrameToClip(clip.id, f.id)}
                >
                  <span class="thumb checker"><img src={f.url} alt={f.name} /></span>
                  <span class="add-name">{f.name}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head h2 {
    margin: 0;
  }
  .empty {
    color: var(--text-dim);
    padding: 10px 4px;
    font-size: 13px;
  }
  .clip-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 10px 0;
  }
  .tab {
    padding: 4px 10px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel-2);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tab.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .mode-tag {
    color: var(--text-dim);
    font-size: 11px;
  }
  .tab.active .mode-tag {
    color: var(--accent);
  }
  .clip-props {
    gap: 10px;
    flex-wrap: wrap;
  }
  .name-input {
    flex: 1;
    min-width: 120px;
  }
  .mode-select {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ops {
    margin: 8px 0;
    flex-wrap: wrap;
  }
  .duration-sum {
    margin-left: auto;
    font-size: 12px;
  }
  .refs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow: auto;
  }
  .ref-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-2);
  }
  .idx {
    width: 20px;
    text-align: right;
    color: var(--text-dim);
  }
  .thumb {
    width: 36px;
    height: 36px;
    border-radius: 4px;
    overflow: hidden;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .dur {
    width: 56px;
  }
  .event {
    width: 110px;
  }
  .event-flag {
    font-size: 11px;
    color: #ffd166;
  }
  .ref-ops {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .ref-ops button {
    padding: 2px 6px;
    font-size: 12px;
  }
  .dim {
    color: var(--text-dim);
  }
  .small {
    font-size: 12px;
  }
  .add-zone {
    margin-top: 10px;
    border-top: 1px dashed var(--border);
    padding-top: 8px;
  }
  .add-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .add-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 3px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-2);
    font-size: 11px;
    max-width: 150px;
  }
  .add-btn .thumb {
    width: 26px;
    height: 26px;
  }
  .add-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
