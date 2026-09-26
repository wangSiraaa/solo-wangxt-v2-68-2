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

/** 当前片段引用行 */
async function setRefDuration(page: Page, clipName: string, index: number, ms: number): Promise<void> {
  const inputs = page.locator(`[data-clip-refs='${clipName}'] [data-ref-duration-for='${clipName}']`);
  await inputs.nth(index).fill(String(ms));
  await inputs.nth(index).dispatchEvent("change");
}

async function setRefEvent(page: Page, clipName: string, index: number, ev: string): Promise<void> {
  const inputs = page.locator(`[data-clip-refs='${clipName}'] [data-ref-event-for='${clipName}']`);
  await inputs.nth(index).fill(ev);
  await inputs.nth(index).dispatchEvent("change");
}

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

test.describe("动画片段与事件帧", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await importFrames(page);
  });

  test("导入帧后自动创建默认片段，引用全部帧", async ({ page }) => {
    const tabs = page.locator("[data-clip-tab]");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveText(/默认片段/);
    await expect(page.locator("[data-clip-refs] .ref-item")).toHaveCount(FRAME_NAMES.length);
    // 预览下拉中存在该片段
    await expect(page.locator("#preview-clip-select option")).toHaveCount(1);
  });

  test("两个片段复用同一帧，片段内时长互不影响", async ({ page }) => {
    // 默认片段（loop）：第 1 帧设为 300ms
    await setRefDuration(page, "默认片段", 0, 300);

    // 新建片段（会按当前全部帧创建）
    await page.locator("#new-clip-btn").click();
    await expect(page.locator("[data-clip-tab]")).toHaveCount(2);
    // 新片段自动命名为「新片段」
    const newClipName = "新片段";
    await expect(page.locator(`[data-clip-name-input='${newClipName}']`)).toBeVisible();

    // 新片段第 1 帧设为 50ms（此时新片段处于选中编辑态）
    await setRefDuration(page, newClipName, 0, 50);
    const newInputs = page.locator(`[data-ref-duration-for='${newClipName}']`);
    await expect(newInputs.nth(0)).toHaveValue("50");

    // 帧列表中的全局时长仍为初始 100（片段时长与帧脱钩）
    await expect(page.locator(`[data-duration-for="walk_01.png"]`)).toHaveValue("100");

    // 切回默认片段，值不被新片段改动（编辑器只渲染当前选中片段）
    await page.locator("[data-clip-tab='默认片段']").click();
    const defInputs = page.locator(`[data-ref-duration-for='默认片段']`);
    await expect(defInputs.nth(0)).toHaveValue("300");
  });

  test("预览：切换片段并按真实时长播放；事件触发写入日志", async ({ page }) => {
    // 默认片段：前两帧 200ms，首帧加事件
    await setRefDuration(page, "默认片段", 0, 200);
    await setRefDuration(page, "默认片段", 1, 200);
    await setRefEvent(page, "默认片段", 0, "step");

    // 预览选中默认片段，首帧事件在播放开始后出现
    await page.locator("#preview-clip-select").selectOption({ index: 0 });
    await expect(page.locator("#preview-frame-label")).toContainText("帧 1/8");
    await expect(page.locator("#event-log [data-event-name='step']").first()).toBeVisible({
      timeout: 3000
    });
    // 200ms 后切到第 2 帧
    await expect(page.locator("#preview-frame-label")).toContainText("帧 2/8", { timeout: 3000 });

    // 新建第二个片段，时长 80ms，切到该片段后播放速度不同
    await page.locator("#new-clip-btn").click();
    const newName = "新片段";
    await setRefDuration(page, newName, 0, 80);
    await setRefDuration(page, newName, 1, 80);
    await page.locator("#preview-clip-select").selectOption({ index: 1 });
    // 切换片段清空日志并从帧 1 开始
    await expect(page.locator("#preview-frame-label")).toContainText("帧 1/8");
    await expect(page.locator("#event-log [data-event-name='step']")).toHaveCount(0);
    // 80ms 一帧：很快进入帧 2
    await expect(page.locator("#preview-frame-label")).toContainText("帧 2/8", { timeout: 2000 });
  });

  test("单次模式：播放一次后停在末帧", async ({ page }) => {
    // 让默认片段为单次模式、每帧 60ms
    await page.locator("[data-clip-mode='默认片段']").selectOption("once");
    const durInputs = page.locator(`[data-ref-duration-for='默认片段']`);
    for (let i = 0; i < FRAME_NAMES.length; i++) {
      await durInputs.nth(i).fill("60");
      await durInputs.nth(i).dispatchEvent("change");
    }

    // 等待播放到末帧
    await expect(page.locator("#preview-frame-label")).toContainText(`帧 ${FRAME_NAMES.length}/8`, {
      timeout: 8000
    });
    // 末帧应显示最后一张 walk_08.png
    await expect(page.locator("#preview-frame-label")).toContainText("walk_08.png");
    // 播放按钮变为「重新播放」（finished）
    await expect(page.locator("#play-btn")).toContainText("重新播放", { timeout: 3000 });
    // 再等 1.5s 确认不会循环回帧 1
    await page.waitForTimeout(1500);
    await expect(page.locator("#preview-frame-label")).toContainText("walk_08.png");
    await expect(page.locator("#play-btn")).toContainText("重新播放");
  });

  test("往返模式：帧序正确且端点事件每轮只触发一次", async ({ page }) => {
    // 默认片段只保留前 3 帧并调成 120ms，端点与中间帧都加事件
    const clipRefs = page.locator("[data-clip-refs='默认片段'] .ref-item");
    while ((await clipRefs.count()) > 3) {
      await clipRefs.last().locator("button[title='从片段移除']").click();
    }
    await expect(clipRefs).toHaveCount(3);
    const durInputs = page.locator(`[data-ref-duration-for='默认片段']`);
    for (let i = 0; i < 3; i++) {
      await durInputs.nth(i).fill("120");
      await durInputs.nth(i).dispatchEvent("change");
    }
    await setRefEvent(page, "默认片段", 0, "HEAD");
    await setRefEvent(page, "默认片段", 1, "MID");
    await setRefEvent(page, "默认片段", 2, "TAIL");
    await page.locator("[data-clip-mode='默认片段']").selectOption("pingpong");

    const label = page.locator("#preview-frame-label");
    // 帧序：1 → 2 → 3 → 2 → 1 → 2 ...（端点 1、3 不连续重复）
    await expect(label).toContainText("帧 1/3");
    await expect(label).toContainText("帧 2/3", { timeout: 2500 });
    await expect(label).toContainText("帧 3/3", { timeout: 2500 });
    await expect(label).toContainText("帧 2/3", { timeout: 2500 });
    await expect(label).toContainText("帧 1/3", { timeout: 2500 });

    // 跑两轮以上（一轮 4 个位 × 120ms = 480ms；等 2.2s ≈ 4.5 轮）
    await page.waitForTimeout(2200);
    const headCount = await page.locator("#event-log [data-event-name='HEAD']").count();
    const tailCount = await page.locator("#event-log [data-event-name='TAIL']").count();
    const midCount = await page.locator("#event-log [data-event-name='MID']").count();

    // 结构正确性：日志最新在上。TAIL 两次触发之间必隔着其它事件，
    // 证明端点在反转处不会连续双触发。
    const flat = (
      await page.locator("#event-log li .ev").allInnerTexts()
    ).map((s) => s.replace("⚡", "").trim());
    for (let i = 0; i + 1 < flat.length; i++) {
      if (flat[i] === "TAIL") expect(flat[i + 1], "TAIL 后不应紧接 TAIL").not.toBe("TAIL");
    }

    // 计数比例：每轮 TAIL×1、MID×2、HEAD×1（另含首帧初始 HEAD，允许帧率误差）
    expect(tailCount).toBeGreaterThanOrEqual(3);
    expect(midCount).toBeGreaterThanOrEqual(6);
    expect(Math.abs(midCount - tailCount * 2)).toBeLessThanOrEqual(1);
    expect(headCount).toBeGreaterThanOrEqual(tailCount - 1);
    expect(headCount).toBeLessThanOrEqual(tailCount + 2);
  });

  test("删除共享帧：先显示所有受影响片段，取消则无变化，确认则原子移除", async ({ page }) => {
    // 准备第二个片段（默认片段引用全部帧；新片段同样引用全部帧）
    await page.locator("#new-clip-btn").click();
    await expect(page.locator("[data-clip-tab]")).toHaveCount(2);

    // 删除帧列表中的第 1 帧 → 弹出影响对话框，列出 2 个片段
    await page.locator(`.frame-item[data-frame-name="walk_01.png"] button[title="删除"]`).click();
    const dialog = page.getByTestId("delete-frame-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#delete-impact-list li")).toHaveCount(2);
    const impactNames = await page.locator("#delete-impact-list li strong").allInnerTexts();
    expect(impactNames.sort()).toEqual(["默认片段", "新片段"].sort());

    // 取消：帧与片段引用都不变
    await page.locator("#delete-cancel-btn").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
    await page.locator("[data-clip-tab='默认片段']").click();
    await expect(page.locator("[data-clip-refs='默认片段'] .ref-item")).toHaveCount(
      FRAME_NAMES.length
    );

    // 再次删除并确认：帧与两个片段中的引用一次性移除
    await page.locator(`.frame-item[data-frame-name="walk_01.png"] button[title="删除"]`).click();
    await expect(dialog).toBeVisible();
    await page.locator("#delete-confirm-btn").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length - 1);
    await expect(page.locator("[data-clip-refs='默认片段'] .ref-item")).toHaveCount(
      FRAME_NAMES.length - 1
    );
    await page.locator("[data-clip-tab='新片段']").click();
    await expect(page.locator("[data-clip-refs='新片段'] .ref-item")).toHaveCount(
      FRAME_NAMES.length - 1
    );
    // 受影响片段仍可在预览中切换播放
    await page.locator("#preview-clip-select").selectOption({ index: 1 });
    await expect(page.locator("#preview-frame-label")).toContainText("帧 1/7");
  });

  test("刷新后片段顺序、循环模式、事件保持一致（IndexedDB 持久化）", async ({ page }) => {
    // 默认片段改名/改模式/加事件
    const nameInput = page.locator("[data-clip-name-input='默认片段']");
    await nameInput.fill("待机");
    await nameInput.dispatchEvent("change");
    await page.locator("[data-clip-mode='待机']").selectOption("pingpong");
    await setRefEvent(page, "待机", 0, "breath");
    await setRefDuration(page, "待机", 0, 150);

    // 第二个片段（loop）
    await page.locator("#new-clip-btn").click();
    const c2 = page.locator("[data-clip-name-input='新片段']");
    await c2.fill("攻击");
    await c2.dispatchEvent("change");
    await setRefEvent(page, "攻击", 2, "hit");

    // 等待防抖自动保存
    await page.waitForTimeout(1200);
    await page.reload();

    // 顺序与名称恢复
    const tabs = page.locator("[data-clip-tab]");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAttribute("data-clip-tab", "待机");
    await expect(tabs.nth(1)).toHaveAttribute("data-clip-tab", "攻击");
    // 循环模式
    await expect(page.locator("[data-clip-mode='待机']")).toHaveValue("pingpong");
    await page.locator("[data-clip-tab='攻击']").click();
    await expect(page.locator("[data-clip-mode='攻击']")).toHaveValue("loop");
    // 事件与片段内时长
    await expect(page.locator("[data-ref-event-for='攻击']").nth(2)).toHaveValue("hit");
    await page.locator("[data-clip-tab='待机']").click();
    await expect(page.locator("[data-ref-event-for='待机']").nth(0)).toHaveValue("breath");
    await expect(page.locator("[data-ref-duration-for='待机']").nth(0)).toHaveValue("150");
  });

  test("导出 JSON 含片段；再导入后片段/模式/事件与图集坐标一致", async ({ page }) => {
    // 配置片段
    const nameInput = page.locator("[data-clip-name-input='默认片段']");
    await nameInput.fill("循环片段");
    await nameInput.dispatchEvent("change");
    await setRefEvent(page, "循环片段", 0, "go");
    await setRefDuration(page, "循环片段", 0, 123);
    await page.locator("#new-clip-btn").click();
    const c2 = page.locator("[data-clip-name-input='新片段']");
    await c2.fill("往返片段");
    await c2.dispatchEvent("change");
    await page.locator("[data-clip-mode='往返片段']").selectOption("pingpong");

    // 打包
    await page.locator("#pack-btn").click();
    await expect(page.locator("#atlas-image")).toBeVisible();
    const tableBefore = await readAtlasTable(page);

    // 导出
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#export-json-btn").click()
    ]);
    const json = JSON.parse(readFileSync((await download.path())!, "utf-8"));
    expect(json.meta.clips).toHaveLength(2);
    expect(json.meta.clips.map((c: { name: string }) => c.name)).toEqual(["循环片段", "往返片段"]);
    expect(json.meta.clips[1].loop).toBe("pingpong");
    expect(json.meta.clips[0].frames[0]).toMatchObject({
      frame: "walk_01.png",
      duration: 123,
      event: "go"
    });

    // 清空并重新导入该 JSON
    await page.locator("#clear-storage-btn").click();
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(0);
    await page.locator("#json-input").setInputFiles({
      name: "atlas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(json))
    });

    // 片段恢复
    const tabs = page.locator("[data-clip-tab]");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAttribute("data-clip-tab", "循环片段");
    await expect(tabs.nth(1)).toHaveAttribute("data-clip-tab", "往返片段");
    await expect(page.locator("[data-clip-mode='循环片段']")).toHaveValue("loop");
    await expect(page.locator("[data-ref-event-for='循环片段']").nth(0)).toHaveValue("go");
    await expect(page.locator("[data-ref-duration-for='循环片段']").nth(0)).toHaveValue("123");
    // 切换到往返片段标签页后校验其模式
    await tabs.nth(1).click();
    await expect(page.locator("[data-clip-mode='往返片段']")).toHaveValue("pingpong");

    // 图集坐标与导出前完全一致
    await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
    const tableAfter = await readAtlasTable(page);
    expect(tableAfter).toEqual(tableBefore);
  });

  test("导入旧格式 JSON（无 clips）自动创建默认片段", async ({ page }) => {
    // 先打包导出一份新 JSON，再裁掉 meta.clips 模拟 1.0.0 旧格式
    await page.locator("#pack-btn").click();
    await expect(page.locator("#atlas-image")).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#export-json-btn").click()
    ]);
    const json = JSON.parse(readFileSync((await download.path())!, "utf-8"));
    json.meta.version = "1.0.0";
    delete json.meta.clips;

    await page.locator("#clear-storage-btn").click();
    await page.locator("#json-input").setInputFiles({
      name: "old-atlas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(json))
    });

    await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
    // 自动出现一个包含全部帧、loop 模式的默认片段
    await expect(page.locator("[data-clip-tab]")).toHaveCount(1);
    await expect(page.locator("[data-clip-tab='默认片段']")).toBeVisible();
    await expect(page.locator("[data-clip-refs='默认片段'] .ref-item")).toHaveCount(
      FRAME_NAMES.length
    );
    await expect(page.locator("[data-clip-mode='默认片段']")).toHaveValue("loop");
    await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
  });
});
