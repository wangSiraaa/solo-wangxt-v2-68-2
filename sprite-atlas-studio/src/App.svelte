<script lang="ts">
  import { onMount } from "svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import SettingsPanel from "./lib/components/SettingsPanel.svelte";
  import FrameList from "./lib/components/FrameList.svelte";
  import ClipPanel from "./lib/components/ClipPanel.svelte";
  import Preview from "./lib/components/Preview.svelte";
  import AtlasView from "./lib/components/AtlasView.svelte";
  import {
    addFiles,
    cancelRemoveFrame,
    confirmRemoveFrame,
    pendingFrameDelete,
    restoreFromDB,
    startAutoSave,
    status,
    notify
  } from "./lib/core/store";

  let ready = false;
  let dragOver = false;

  onMount(async () => {
    const restored = await restoreFromDB();
    if (restored) notify("已从浏览器本地恢复上次项目");
    startAutoSave();
    ready = true;
  });

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void addFiles(files);
  }
</script>

<svelte:window on:dragover|preventDefault={() => (dragOver = true)} on:drop={onDrop} />

<header>
  <h1>🎞️ Sprite Atlas Studio</h1>
  <span class="sub">序列帧 → 精灵图集 · 纯本地运行，图片不离开浏览器</span>
</header>

<Toolbar />

{#if $status}
  <div class="toast {$status.kind}" role="status">{$status.text}</div>
{/if}

{#if dragOver}
  <div class="drop-hint">松开以导入 PNG 帧</div>
{/if}

{#if $pendingFrameDelete}
  <div class="modal-backdrop">
    <div class="modal" id="delete-confirm-dialog" role="alertdialog" aria-modal="true">
      <h3>删除帧「{$pendingFrameDelete.frameName}」？</h3>
      <p>该帧正被以下 {$pendingFrameDelete.affected.length} 个片段引用：</p>
      <ul id="delete-affected-list">
        {#each $pendingFrameDelete.affected as a}
          <li data-affected-clip={a.clipName}>片段「{a.clipName}」· {a.refs} 处引用</li>
        {/each}
      </ul>
      <p>删除帧会同时从这些片段中移除对应条目（片段其余内容保留）。该操作不可撤销。</p>
      <div class="modal-ops">
        <button id="cancel-delete-btn" on:click={cancelRemoveFrame}>取消</button>
        <button id="confirm-delete-btn" class="danger-solid" on:click={confirmRemoveFrame}>
          删除帧并移除引用
        </button>
      </div>
    </div>
  </div>
{/if}

{#if ready}
  <main>
    <section class="left">
      <SettingsPanel />
      <FrameList />
      <ClipPanel />
    </section>
    <section class="center">
      <Preview />
    </section>
    <section class="right">
      <AtlasView />
    </section>
  </main>
{/if}

<style>
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 12px 16px 4px;
  }
  header h1 {
    margin: 0;
    font-size: 18px;
  }
  header .sub {
    color: var(--text-dim);
    font-size: 12px;
  }

  main {
    flex: 1;
    display: grid;
    grid-template-columns: 340px minmax(320px, 1fr) minmax(360px, 1.2fr);
    gap: 12px;
    padding: 12px 16px 16px;
    align-items: start;
  }
  .left,
  .center,
  .right {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .toast {
    margin: 8px 16px 0;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 13px;
    border: 1px solid var(--accent-2);
    background: rgba(56, 199, 147, 0.12);
  }
  .toast.error {
    border-color: var(--danger);
    background: rgba(229, 83, 75, 0.12);
  }

  .drop-hint {
    margin: 8px 16px 0;
    padding: 18px;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    text-align: center;
    color: var(--accent);
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    width: min(440px, 90vw);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
  }
  .modal h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }
  .modal p {
    margin: 6px 0;
    font-size: 13px;
    color: var(--text-dim);
  }
  .modal ul {
    margin: 6px 0;
    padding-left: 20px;
    font-size: 13px;
  }
  .modal-ops {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
  .modal-ops .danger-solid {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
  }

  @media (max-width: 1100px) {
    main {
      grid-template-columns: 1fr;
    }
  }
</style>
