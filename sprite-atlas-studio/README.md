# Sprite Atlas Studio

游戏美术本地序列帧 → 精灵图集工具。**纯 Web、纯本地**：所有图片处理都在浏览器内完成，不上传任何数据。

## 功能

- **导入 PNG 序列帧**：文件选择或拖拽，保持导入顺序（可拖拽/按钮调整）
- **帧时长**：逐帧设置毫秒数，或一键应用到全部帧
- **透明边缘裁切**：按 alpha 通道计算包围盒，记录 `spriteSourceSize` 偏移
- **统一留白**：每帧四周固定像素留白（打包时把矩形放大 `padding*2` 后排布，内容居中）
- **矩形打包**：maxrects-packer，**固定方向不旋转**，图集尺寸支持 POT（2 的幂）
- **动画片段（Clip）**：同一工程可定义多个命名片段；每个片段引用已有帧，拥有独立的顺序、单帧时长、循环模式（**循环 / 单次 / 往返**）与可选**事件标记**。两个片段可复用同一帧且时长互不影响
- **动画预览**：PixiJS 可切换片段，按片段内真实帧时长播放；事件帧触发时写入事件日志；往返模式端点不重复触发，单次模式播完停在末帧
- **删除保护**：删除被片段引用的帧时，先列出所有受影响片段；可取消，或确认后帧删除与引用移除一次性原子完成
- **图集视图**：编号框标注每帧位置，表格列出 x/y/w/h、裁切偏移、原始尺寸、时长
- **导出**：`atlas.png` + `atlas.json`（TexturePacker Hash 兼容结构，扩展 `duration` / `frameOrder` / `settings` / `clips`；可内嵌图集 dataURL）
- **导入 JSON 恢复**：从导出的 JSON 完整恢复帧列表、顺序、时长、动画片段（顺序/循环模式/事件）与打包结果；**导入 1.0.0 旧格式（无 clips）时自动创建一个包含全部帧的默认片段**
- **IndexedDB 持久化**：帧 PNG（Blob）、设置、动画片段与打包结果自动保存到浏览器本地，刷新后恢复

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
npm test           # vitest：单元（裁切/打包/计时/片段/序列化）+ 集成（真实 PNG 全管线）
npm run e2e        # Playwright：浏览器全流程（导入→打包→预览→导出→导入 JSON 恢复→刷新恢复，含片段/事件/三种循环模式）
```

集成测试（`tests/integration/pipeline.test.ts`）用真实 PNG 验证：

- 裁切包围盒与生成素材的透明边缘完全一致
- 图集中每帧内容位置、统一留白（四周透明像素）
- 导出 JSON → 重新导入后帧列表/顺序/时长/位置尺寸完整恢复，且恢复帧与原图**逐像素一致**
- 预览计时：按每帧时长推进的帧序与解析式 `frameIndexAt` 一致

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
    // 1.1.0+ 动画片段（旧格式无此字段，导入时自动创建默认片段）
    "clips": [
      {
        "name": "跑步",
        "loop": "loop",                      // loop（循环）| once（停在末帧）| pingpong（往返，端点不重复）
        "frames": [
          { "frame": "walk_01.png", "duration": 120, "event": "step" }, // event 可省略
          { "frame": "walk_02.png", "duration": 80 }
        ]
      }
    ],
    "atlasDataURL": "data:image/png;base64,..."  // 可选：内嵌图集，JSON 可独立恢复
  }
}
```
