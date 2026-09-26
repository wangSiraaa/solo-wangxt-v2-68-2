<script lang="ts">
  import { cancelRemoveFrame, commitRemoveFrame, pendingDelete } from "../core/store";
</script>

{#if $pendingDelete}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    on:click={cancelRemoveFrame}
    on:keydown={(e) => e.key === "Escape" && cancelRemoveFrame()}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="dialog panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      tabindex="-1"
      on:click|stopPropagation
      data-testid="delete-frame-dialog"
    >
      <h3 id="delete-dialog-title">删除帧「{$pendingDelete.frameName}」？</h3>
      <p class="warn">
        该帧正被以下 {$pendingDelete.impacts.length} 个片段引用，删除帧会同时从这些片段中移除对应引用：
      </p>
      <ul class="impact-list" id="delete-impact-list">
        {#each $pendingDelete.impacts as imp (imp.clipId)}
          <li data-impact-clip={imp.clipName}>
            <strong>{imp.clipName}</strong>
            <span class="dim">引用 {imp.count} 次</span>
          </li>
        {/each}
      </ul>
      <p class="dim small">取消则保留帧与全部引用；确认后帧删除与引用移除一次性完成，不可撤销。</p>
      <div class="buttons">
        <button id="delete-cancel-btn" on:click={cancelRemoveFrame}>取消</button>
        <button
          id="delete-confirm-btn"
          class="danger"
          on:click={() => commitRemoveFrame($pendingDelete!.frameId, true)}
        >
          删除帧并移除引用
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    width: min(440px, calc(100vw - 32px));
    padding: 18px;
  }
  .dialog h3 {
    margin: 0 0 10px;
    font-size: 15px;
  }
  .warn {
    margin: 0 0 10px;
    font-size: 13px;
  }
  .impact-list {
    margin: 0 0 10px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-2);
    list-style: none;
    max-height: 180px;
    overflow: auto;
  }
  .impact-list li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
  }
  .dim {
    color: var(--text-dim);
  }
  .small {
    font-size: 12px;
    margin: 0 0 14px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
