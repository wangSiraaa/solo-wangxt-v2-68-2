# Sprite Atlas Studio

游戏美术本地序列帧 → 精灵图集工具。**纯 Web、纯本地**：所有图片处理都在浏览器内完成，不上传任何数据。

## 功能

- **导入 PNG 序列帧**：文件选择或拖拽，保持导入顺序（可拖拽/按钮调整）
- **帧时长**：逐帧设置毫秒数，或一键应用到全部帧
- **动画片段**：同一工程定义多个命名片段；每个片段引用已有帧，拥有独立顺序、单帧时长（与帧列表互不影响）、循环模式（循环/单次/往返）与可选事件标记
- **引用安全的删除**：删除被片段引用的帧时，先展示受影响片段清单，可选择取消或一并移除引用（原子生效）
- **透明边缘裁切**：按 alpha 通道计算包围盒，记录 `spriteSourceSize` 偏移
- **统一留白**：每帧四周固定像素留白（打包时把矩形放大 `padding*2` 后排布，内容居中）
- **矩形打包**：maxrects-packer，**固定方向不旋转**，图集尺寸支持 POT（2 的幂）
- **动画预览**：PixiJS 按真实时长播放；可切换「原始序列」或任一片段；单次模式停在末帧，往返模式端点不重复触发；事件触发时实时显示日志；从图集取子纹理并按裁切偏移摆放（等同引擎行为），实时显示当前帧在图集中的位置/尺寸
- **图集视图**：编号框标注每帧位置，表格列出 x/y/w/h、裁切偏移、原始尺寸、时长
- **导出**：`atlas.png` + `atlas.json`（TexturePacker Hash 兼容结构，扩展 `duration` / `frameOrder` / `clips` / `settings`；可内嵌图集 dataURL）
- **导入 JSON 恢复**：从导出的 JSON 完整恢复帧列表、顺序、时长、片段与打包结果（图集内嵌时无需另选图片；否则连同 `atlas.png` 一起选择）；**旧格式（无 `clips`）自动创建一个默认片段**
- **IndexedDB 持久化**：帧 PNG（Blob）、片段与事件、设置与打包结果自动保存到浏览器本地，刷新后恢复

## 技术栈

Svelte 5 + TypeScript（状态与 UI）· PixiJS v8（动画预览）· maxrects-packer（矩形打包）· idb（IndexedDB）· Vite

## 开发

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 构建到 dist/
npm run preview    # 预览构建产物
npm run check      # svelte-check 类型检查
```

## 测试

```bash
npm run gen-assets # 生成验证素材到 test-assets/（8 帧：不同尺寸 + 不等厚透明边缘）
npm test           # vitest：单元（裁切/打包/计时/片段播放器/序列化）+ 集成（真实 PNG 全管线）
npm run e2e        # Playwright：浏览器全流程（导入→打包→预览→片段→导出→导入 JSON 恢复→刷新恢复）
```

集成测试（`tests/integration/pipeline.test.ts`）用真实 PNG 验证：

- 裁切包围盒与生成素材的透明边缘完全一致
- 图集中每帧内容位置、统一留白（四周透明像素）
- 导出 JSON → 重新导入后帧列表/顺序/时长/位置尺寸完整恢复，且恢复帧与原图**逐像素一致**
- 预览计时：按每帧时长推进的帧序与解析式 `frameIndexAt` 一致

片段测试（`tests/unit/clips.test.ts` + `e2e/clips.spec.ts`）覆盖：

- 两个片段复用同一帧但时长互不影响
- 单次播放停在末帧；往返播放帧序为 0..n-1..0 且端点事件不重复触发
- 删除被引用帧：影响清单、取消、确认后所有片段同步移除引用（原子）
- 刷新与新/旧格式 JSON 往返后，片段顺序、循环模式、事件与图集坐标保持一致

## JSON 格式

```jsonc
{
  "frames": {
    "walk_01.png": {
      "frame": { "x": 2, "y": 2, "w": 42, "h": 48 },   // 图集中的位置与尺寸
      "rotated": false,                                 // 固定方向，恒为 false
      "trimmed": true,
      "spriteSourceSize": { "x": 8, "y": 10, "w": 42, "h": 48 }, // 裁切偏移
      "sourceSize": { "w": 64, "h": 64 },               // 原始尺寸
      "duration": 100                                   // 帧时长 ms
    }
  },
  "meta": {
    "app": "sprite-atlas-studio",
    "version": "1.0.0",
    "image": "atlas.png",
    "size": { "w": 256, "h": 512 },
    "frameOrder": ["walk_01.png", "..."],   // 原始播放顺序
    "settings": { "trim": true, "padding": 2, "maxSize": 2048, "pot": true },
    "totalDuration": 950,
    "clips": [                              // 动画片段（旧格式无此字段，导入时自动建默认片段）
      {
        "name": "walk",
        "loop": "pingpong",                 // loop 循环 / once 单次 / pingpong 往返
        "frames": [
          { "frame": "walk_01.png", "duration": 100, "event": "step" }, // event 可选
          { "frame": "walk_02.png", "duration": 80 }
        ]
      }
    ],
    "atlasDataURL": "data:image/png;base64,..."  // 可选：内嵌图集，JSON 可独立恢复
  }
}
```
