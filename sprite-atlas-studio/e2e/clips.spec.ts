import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "test-assets");
const FRAME_NAMES = readdirSync(ASSETS).filter((f) => f.endsWith(".png")).sort();

async function importFrames(page: Page): Promise<void> {
  const files = FRAME_NAMES.map((f) => join(ASSETS, f));
  await page.locator("#png-input").setInputFiles(files);
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
}

/** 从图集表格读出 name → [x, y, w, h] */
async function readAtlasTable(page: Page): Promise<Record<string, number[]>> {
  const rows = page.locator("#atlas-table tbody tr");
  const out: Record<string, number[]> = {};
  for (const row of await rows.all()) {
    const name = await row.locator("td").nth(1).innerText();
    const nums: number[] = [];
    for (const col of [2, 3, 4, 5]) {
      nums.push(Number(await row.locator("td").nth(col).innerText()));
    }
    out[name] = nums;
  }
  return out;
}

/** 重命名片段（fill 后触发 change） */
async function renameClip(page: Page, from: string, to: string): Promise<void> {
  const input = page.locator(`[data-rename-for="${from}"]`);
  await input.fill(to);
  await input.dispatchEvent("change");
  await expect(page.locator(`[data-rename-for="${to}"]`)).toBeVisible();
}

/** 设置当前展开片段第 i 项的时长 */
async function setEntryDuration(page: Page, i: number, ms: number): Promise<void> {
  const input = page.locator(`[data-entry-dur="${i}"]`);
  await input.fill(String(ms));
  await input.dispatchEvent("change");
  await expect(input).toHaveValue(String(ms));
}

/** 设置当前展开片段第 i 项的事件标记 */
async function setEntryEvent(page: Page, i: number, event: string): Promise<void> {
  const input = page.locator(`[data-entry-event="${i}"]`);
  await input.fill(event);
  await input.dispatchEvent("change");
  await expect(input).toHaveValue(event);
}

/** 删除当前展开片段的最后几项，使其只剩 keep 项 */
async function trimEntriesTo(page: Page, keep: number): Promise<void> {
  const count = await page.locator("#clip-entries .clip-entry").count();
  for (let i = count - 1; i >= keep; i--) {
    await page.locator(`[data-entry-remove="${i}"]`).click();
  }
  await expect(page.locator("#clip-entries .clip-entry")).toHaveCount(keep);
}

async function eventNames(page: Page): Promise<string[]> {
  return page.locator("#event-log .event-item").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-event") ?? "")
  );
}

test("片段：复用同一帧时长互不影响；单次停在末帧；往返帧序与事件次数正确", async ({ page }) => {
  await page.goto("/");
  await importFrames(page);

  // --- 片段 walk：3 项、各 60ms、往返、每项都有事件 ---
  await page.locator("#add-clip-btn").click();
  await renameClip(page, "片段 1", "walk");
  await page.locator('[data-loop-for="walk"]').selectOption("pingpong");
  await trimEntriesTo(page, 3);
  for (const i of [0, 1, 2]) await setEntryDuration(page, i, 60);
  await setEntryEvent(page, 0, "e0");
  await setEntryEvent(page, 1, "e1");
  await setEntryEvent(page, 2, "e2");

  // --- 片段 run：3 项、首项 200ms、单次 ---
  await page.locator("#add-clip-btn").click();
  await renameClip(page, "片段 2", "run");
  await page.locator('[data-loop-for="run"]').selectOption("once");
  await trimEntriesTo(page, 3);
  await setEntryDuration(page, 0, 200);

  // 暂停预览，便于读稳定的标签
  await page.locator("#play-btn").click();
  await expect(page.locator("#play-btn")).toHaveText("▶ 播放");

  // --- 验收：两个片段复用 walk_01.png 但时长互不影响，且不影响帧列表时长 ---
  await page.locator('[data-clip-name="walk"]').click();
  await expect(page.locator('[data-entry-dur="0"]')).toHaveValue("60");
  await expect(page.locator('[data-duration-for="walk_01.png"]')).toHaveValue("100");
  await page.locator("#clip-select").selectOption({ label: "walk（往返）" });
  await expect(page.locator("#preview-frame-label")).toContainText("片段「walk」");
  await expect(page.locator("#preview-frame-label")).toContainText("帧 1/3");
  await expect(page.locator("#preview-frame-label")).toContainText("60ms");

  await page.locator('[data-clip-name="run"]').click();
  await expect(page.locator('[data-entry-dur="0"]')).toHaveValue("200");
  await page.locator("#clip-select").selectOption({ label: "run（单次）" });
  await expect(page.locator("#preview-frame-label")).toContainText("200ms");

  // --- 验收：往返播放的帧序与事件次数（端点不重复触发） ---
  await page.locator("#clip-select").selectOption({ label: "walk（往返）" });
  await page.locator("#play-btn").click(); // 恢复播放
  await expect
    .poll(async () => (await eventNames(page)).length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(9);
  const got = (await eventNames(page)).slice(0, 9);
  const pattern = ["e0", "e1", "e2", "e1"]; // 往返帧序 0,1,2,1 循环
  expect(got).toEqual(Array.from({ length: 9 }, (_, i) => pattern[i % 4]));
  // 端点事件不连续重复
  for (let i = 1; i < got.length; i++) expect(got[i]).not.toBe(got[i - 1]);

  // --- 验收：单次播放停在末帧 ---
  await page.locator("#clip-select").selectOption({ label: "run（单次）" });
  await expect(page.locator("#preview-frame-label")).toContainText("已结束", { timeout: 5000 });
  await expect(page.locator("#preview-frame-label")).toContainText("帧 3/3");
  await page.waitForTimeout(600);
  await expect(page.locator("#preview-frame-label")).toContainText("帧 3/3");
  await expect(page.locator("#preview-frame-label")).toContainText("已结束");
});

test("删除被引用帧：展示影响、可取消、确认后所有片段同步移除且可预览", async ({ page }) => {
  await page.goto("/");
  await importFrames(page);

  // 未被引用的帧：直接删除，无确认框
  await page.locator('[data-delete-frame="walk_08.png"]').click();
  await expect(page.locator("#delete-confirm-dialog")).toHaveCount(0);
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(7);

  // 两个片段都引用 walk_01.png
  await page.locator("#add-clip-btn").click();
  await renameClip(page, "片段 1", "walk");
  await page.locator("#add-clip-btn").click();
  await renameClip(page, "片段 2", "run");

  // 删除被引用帧 → 弹出影响说明
  await page.locator('[data-delete-frame="walk_01.png"]').click();
  await expect(page.locator("#delete-confirm-dialog")).toBeVisible();
  await expect(page.locator("#delete-affected-list li")).toHaveCount(2);
  await expect(page.locator("#delete-affected-list")).toContainText("片段「walk」· 1 处引用");
  await expect(page.locator("#delete-affected-list")).toContainText("片段「run」· 1 处引用");

  // 取消：一切不变
  await page.locator("#cancel-delete-btn").click();
  await expect(page.locator("#delete-confirm-dialog")).toHaveCount(0);
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(7);
  await expect(page.locator("#clip-entries .clip-entry")).toHaveCount(7);

  // 确认：帧与所有片段中的引用一并移除（原子）
  await page.locator('[data-delete-frame="walk_01.png"]').click();
  await page.locator("#confirm-delete-btn").click();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(6);
  await expect(page.locator("#clip-entries .clip-entry")).toHaveCount(6); // run（当前展开）
  await page.locator('[data-clip-name="walk"]').click();
  await expect(page.locator("#clip-entries .clip-entry")).toHaveCount(6);
  await expect(page.locator(".detail-head")).toContainText("6 项");

  // 受影响片段仍可预览播放
  await page.locator("#clip-select").selectOption({ label: "walk（循环）" });
  await expect(page.locator("#preview-frame-label")).toContainText("片段「walk」· 帧 1/6");
  await expect(page.locator("#preview-frame-label")).toContainText("帧 2/6", { timeout: 3000 });
  await page.locator("#clip-select").selectOption({ label: "run（循环）" });
  await expect(page.locator("#preview-frame-label")).toContainText("片段「run」· 帧 1/6");

  // 原子性：刷新后帧与片段引用保持一致（不会出现帧没了但片段还引用）
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(6);
  await expect(page.locator("#clip-list .clip-row")).toHaveCount(2);
  await expect(page.locator("#clip-entries .clip-entry")).toHaveCount(6);
});

test("片段持久化与新旧 JSON 往返：顺序、循环模式、事件、图集坐标一致", async ({ page }) => {
  await page.goto("/");
  await importFrames(page);

  // 打包，记录图集坐标
  await page.locator("#pack-btn").click();
  await expect(page.locator("#atlas-image")).toBeVisible();
  const tableBefore = await readAtlasTable(page);
  expect(Object.keys(tableBefore)).toHaveLength(FRAME_NAMES.length);

  // walk：往返 + 事件；run：单次
  await page.locator("#add-clip-btn").click();
  await renameClip(page, "片段 1", "walk");
  await page.locator('[data-loop-for="walk"]').selectOption("pingpong");
  await setEntryEvent(page, 0, "step");
  await setEntryEvent(page, 4, "jump");
  await page.locator("#add-clip-btn").click();
  await renameClip(page, "片段 2", "run");
  await page.locator('[data-loop-for="run"]').selectOption("once");

  // --- 刷新后从 IndexedDB 恢复 ---
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator("#clip-list .clip-row")).toHaveCount(2);
  expect(await page.locator("#clip-list .clip-row").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-clip-name"))
  )).toEqual(["walk", "run"]); // 片段顺序保持
  await expect(page.locator('[data-loop-for="walk"]')).toHaveValue("pingpong");
  await expect(page.locator('[data-loop-for="run"]')).toHaveValue("once");
  await expect(page.locator('[data-entry-event="0"]')).toHaveValue("step");
  await expect(page.locator('[data-entry-event="4"]')).toHaveValue("jump");
  await expect(page.locator('[data-entry-event="1"]')).toHaveValue("");
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
  expect(await readAtlasTable(page)).toEqual(tableBefore); // 图集坐标一致

  // --- 导出新格式 JSON：包含片段 ---
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-json-btn").click()
  ]);
  const json = JSON.parse(readFileSync(await jsonDownload.path(), "utf-8"));
  expect(json.meta.clips).toHaveLength(2);
  expect(json.meta.clips[0].name).toBe("walk");
  expect(json.meta.clips[0].loop).toBe("pingpong");
  expect(json.meta.clips[0].frames).toHaveLength(8);
  expect(json.meta.clips[0].frames[0]).toEqual({ frame: "walk_01.png", duration: 100, event: "step" });
  expect(json.meta.clips[0].frames[4].event).toBe("jump");
  expect(json.meta.clips[0].frames[1].event).toBeUndefined();
  expect(json.meta.clips[1].name).toBe("run");
  expect(json.meta.clips[1].loop).toBe("once");

  // --- 新格式 JSON 往返：清空 → 导入 → 片段与图集坐标一致 ---
  await page.getByRole("button", { name: "清空" }).click();
  await expect(page.locator("#clip-list .clip-row")).toHaveCount(0);
  await page.locator("#json-input").setInputFiles({
    name: "atlas.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json))
  });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
  await expect(page.locator("#clip-list .clip-row")).toHaveCount(2);
  expect(await page.locator("#clip-list .clip-row").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-clip-name"))
  )).toEqual(["walk", "run"]);
  await expect(page.locator('[data-loop-for="walk"]')).toHaveValue("pingpong");
  await expect(page.locator('[data-loop-for="run"]')).toHaveValue("once");
  await expect(page.locator('[data-entry-event="0"]')).toHaveValue("step");
  await expect(page.locator('[data-entry-event="4"]')).toHaveValue("jump");
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
  expect(await readAtlasTable(page)).toEqual(tableBefore);

  // --- 旧格式 JSON（无 meta.clips）：自动创建默认片段 ---
  const oldJson = JSON.parse(JSON.stringify(json));
  delete oldJson.meta.clips;
  await page.getByRole("button", { name: "清空" }).click();
  await page.locator("#json-input").setInputFiles({
    name: "atlas.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(oldJson))
  });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
  await expect(page.locator("#clip-list .clip-row")).toHaveCount(1);
  await expect(page.locator("#clip-list .clip-row")).toHaveAttribute("data-clip-name", "默认片段");
  await expect(page.locator('[data-loop-for="默认片段"]')).toHaveValue("loop");
  await expect(page.locator("#clip-entries .clip-entry")).toHaveCount(FRAME_NAMES.length);
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
  expect(await readAtlasTable(page)).toEqual(tableBefore);
});
