<script lang="ts">
  import {
    activeClipId,
    addClip,
    clipAddFrame,
    clipMoveEntry,
    clipRemoveEntry,
    clipSetEntryDuration,
    clipSetEntryEvent,
    clips,
    frames,
    removeClip,
    renameClip,
    setActiveClip,
    setClipLoop
  } from "../core/store";
  import { LOOP_LABELS, LOOP_MODES } from "../core/clips";
  import type { LoopMode } from "../core/types";

  /** 当前展开编辑的片段 */
  let editId: string | null = null;
  /** 待添加到片段的帧 */
  let addFrameId = "";

  $: if (!$clips.some((c) => c.id === editId)) {
    editId = $clips[0]?.id ?? null;
  }
  $: editClip = $clips.find((c) => c.id === editId) ?? null;
  $: frameById = new Map($frames.map((f) => [f.id, f]));
  $: totalMs = editClip ? editClip.entries.reduce((a, e) => a + Math.max(1, e.duration), 0) : 0;
  $: if (addFrameId && !$frames.some((f) => f.id === addFrameId)) addFrameId = "";

  function onRename(id: string, e: Event): void {
    renameClip(id, (e.currentTarget as HTMLInputElement).value);
  }

  function onAddClip(): void {
    addClip();
    // 展开新建的片段（追加在末尾）
    const last = $clips[$clips.length - 1];
    if (last) editId = last.id;
  }

  function onAddFrame(): void {
    if (!editId || !addFrameId) return;
    clipAddFrame(editId, addFrameId);
  }
</script>

<div class="panel clips-panel">
  <div class="head">
    <h2>动画片段（{$clips.length}）</h2>
    <button id="add-clip-btn" disabled={$frames.length === 0} on:click={onAddClip} title="以当前全部帧创建片段">
      ＋ 新建片段
    </button>
  </div>

  {#if $clips.length === 0}
    <div class="empty">
      尚无片段。片段可复用同一批帧，各自拥有独立顺序、单帧时长、循环模式与事件标记。
    </div>
  {:else}
    <div id="clip-list">
      {#each $clips as c (c.id)}
        <div
          class="clip-row"
          class:selected={c.id === editId}
          data-clip-name={c.name}
          data-selected={c.id === editId}
          role="button"
          tabindex="0"
          on:click={() => (editId = c.id)}
          on:keydown={(e) => e.key === "Enter" && (editId = c.id)}
        >
          <input
            class="name"
            type="text"
            value={c.name}
            data-rename-for={c.name}
            on:change={(e) => onRename(c.id, e)}
          />
          <select
            class="loop"
            value={c.loop}
            data-loop-for={c.name}
            on:change={(e) => setClipLoop(c.id, (e.currentTarget as HTMLSelectElement).value as LoopMode)}
          >
            {#each LOOP_MODES as m}
              <option value={m}>{LOOP_LABELS[m]}</option>
            {/each}
          </select>
          <button
            class="preview-btn"
            class:active={$activeClipId === c.id}
            data-preview-clip={c.name}
            title="在预览中播放该片段"
            on:click={() => setActiveClip($activeClipId === c.id ? null : c.id)}
          >
            {$activeClipId === c.id ? "■ 播放中" : "▶ 预览"}
          </button>
          <button class="danger" title="删除片段" on:click={() => removeClip(c.id)}>✕</button>
        </div>
      {/each}
    </div>

    {#if editClip}
      <div class="clip-detail" data-editing-clip={editClip.name}>
        <div class="dim mono detail-head">
          片段「{editClip.name}」· {editClip.entries.length} 项 · 共 {totalMs}ms · {LOOP_LABELS[editClip.loop]}
        </div>
        {#if editClip.entries.length === 0}
          <div class="empty">该片段为空，请从下方添加帧。</div>
        {:else}
          <div id="clip-entries">
            {#each editClip.entries as entry, i (i)}
              {@const f = frameById.get(entry.frameId)}
              <div class="clip-entry" data-entry-index={i}>
                <span class="idx mono">{i + 1}</span>
                <span class="thumb checker">
                  {#if f}<img src={f.url} alt={f.name} />{/if}
                </span>
                <span class="fname" title={f?.name ?? "（帧已删除）"}>{f?.name ?? "（帧已删除）"}</span>
                <input
                  type="number"
                  min="1"
                  class="dur"
                  value={entry.duration}
                  data-entry-dur={i}
                  on:change={(e) =>
                    clipSetEntryDuration(editClip.id, i, Number((e.currentTarget as HTMLInputElement).value))}
                />
                <span class="dim">ms</span>
                <input
                  type="text"
                  class="evt"
                  placeholder="事件（可选）"
                  value={entry.event ?? ""}
                  data-entry-event={i}
                  on:change={(e) => clipSetEntryEvent(editClip.id, i, (e.currentTarget as HTMLInputElement).value)}
                />
                <span class="ops">
                  <button title="上移" on:click={() => clipMoveEntry(editClip.id, i, -1)}>↑</button>
                  <button title="下移" on:click={() => clipMoveEntry(editClip.id, i, 1)}>↓</button>
                  <button class="danger" title="移出片段" data-entry-remove={i} on:click={() => clipRemoveEntry(editClip.id, i)}>✕</button>
                </span>
              </div>
            {/each}
          </div>
        {/if}
        <div class="add-row">
          <select id="clip-add-select" bind:value={addFrameId}>
            <option value="" disabled>选择要添加的帧…</option>
            {#each $frames as f (f.id)}
              <option value={f.id}>{f.name}</option>
            {/each}
          </select>
          <button id="clip-add-btn" disabled={!addFrameId} on:click={onAddFrame}>添加到片段</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .clips-panel {
    max-height: 60vh;
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .head h2 {
    margin: 0;
  }
  .empty {
    color: var(--text-dim);
    padding: 8px 2px;
    font-size: 12px;
  }
  #clip-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .clip-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-2);
    cursor: pointer;
  }
  .clip-row.selected {
    border-color: var(--accent);
  }
  .clip-row .name {
    flex: 1;
    min-width: 0;
  }
  .clip-row .loop {
    width: 76px;
  }
  .preview-btn.active {
    border-color: var(--accent-2);
    color: var(--accent-2);
  }
  .clip-detail {
    margin-top: 10px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .detail-head {
    margin-bottom: 8px;
  }
  #clip-entries {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .clip-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .idx {
    width: 16px;
    text-align: right;
    color: var(--text-dim);
  }
  .thumb {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    overflow: hidden;
    flex: none;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
  }
  .fname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dur {
    width: 56px;
  }
  .evt {
    width: 90px;
  }
  .ops {
    display: flex;
    gap: 3px;
  }
  .ops button {
    padding: 1px 5px;
    font-size: 11px;
  }
  .add-row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .add-row select {
    flex: 1;
    min-width: 0;
  }
  .dim {
    color: var(--text-dim);
  }
</style>
