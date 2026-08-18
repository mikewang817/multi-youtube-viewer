# Multi YouTube Viewer（多屏 YouTube 播放器）

一个 Chrome / Safari 浏览器扩展：**在 YouTube 界面内**同时观看最多 **9 个**视频——浏览、添加、观看全程不离开当前页面。

## 体验流程

1. **边浏览边收集**：在 YouTube 首页/搜索/推荐里，鼠标悬停任意缩略图，点左上角「＋多屏」即加入
2. **正在看的视频也能带进来**：观看页右下角点「⧉ 把当前视频放入多屏」——视频**带着当前播放进度**进入多屏，页面里的播放自动暂停、多屏里自动接管出声，无缝交接
3. **一键展开多屏**：点右下角悬浮舱（有数量角标），当前页面上浮现一层玻璃拟态的全屏多屏视图；`Esc` 或「─」最小化后视频**继续在后台播放**（悬浮舱出现跳动的音频指示条），随时一键回来

## 功能

- **网格布局**：视频数量变化自动排布（1×1 → 2×2 → 3×3），拖动标题栏交换位置
- **自由布局**：一键切换，每个视频变成可拖动、缩放、置顶的圆角浮窗
- **悬停即听**：鼠标移到哪个视频上就自动听哪个，其余静音（发光描边标识；工具栏可关掉，改为点 🔇 手动选）
- **全局控制**：全部播放 / 全部暂停 / 静音全部 / 清空；也可粘贴链接批量添加
- **自动恢复**：布局与列表持久化，重新打开原样恢复（恢复时不自动播放）
- 右键菜单「添加到多屏播放」、作者禁嵌视频的降级提示、全屏观看时自动隐藏注入 UI

> 技术说明：完全不加载远程代码（MV3 合规）。多屏视图由 content script 直接渲染在 youtube.com
> 页面上（youtube.com 强制 Trusted Types，注入代码全程不使用 innerHTML）；视频用
> `youtube-nocookie.com/embed` iframe 嵌入，播放控制自行实现 YouTube widget 的 postMessage 协议。
> YouTube 自 2025-12 起按 Referer 判定嵌入方身份（152/153 拒绝策略），且「youtube.com 嵌自己」
> 会被一律拒绝——因此用 declarativeNetRequest 把**仅限本扩展创建**（URL 带 `myv=1` 标记）的
> embed 请求的 Referer 改写为中性身份 `multi-youtube-viewer.example`，不影响任何其他网站的嵌入。
> 多屏只存在于 YouTube 页内：在非 YouTube 页面点工具栏图标，会聚焦（或新开）一个
> YouTube 标签页并自动展开多屏。Safari 注意：Referer 改写依赖 declarativeNetRequest 的
> modifyHeaders，需要较新的 Safari（18+）。

## 安装：Chrome / Edge / Brave

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `extension/` 目录
4. 打开 youtube.com，右下角出现悬浮舱即安装成功

## 安装：Safari（macOS）

Safari 需要用 Xcode 把 WebExtension 包装成 App（需要 macOS 13+ / Safari 16.4+）。
**本仓库已预生成好 Xcode 工程**（`safari/Multi YouTube Viewer/`，已验证可编译）：

1. 打开 `safari/Multi YouTube Viewer/Multi YouTube Viewer.xcodeproj`，点 ▶ Run 运行一次生成的 App
2. Safari → 设置 → 高级 → 勾选「显示网页开发者功能」
3. Safari → 设置 → 开发者 → 勾选「允许未签名的扩展」（每次重启 Safari 后需要重新勾选，除非用开发者证书签名）
4. Safari → 设置 → 扩展 → 启用「Multi YouTube Viewer」

> 说明：Xcode 工程通过相对路径直接引用 `extension/` 源码（勿移动两个目录的相对位置）。
> 修改 `extension/` 后在 Xcode 里重新 Run 一次即可生效。

## 使用提示

- 浏览器自动播放策略要求：视频进入多屏时默认**静音播放**，点 🔇 选择要听的那一个（从观看页交接进来的视频会自动尝试接管声音）
- 部分视频的作者禁止站外嵌入（错误码 101/150），格子会显示提示并提供「在 YouTube 中打开」链接
- 悬停视频格子会浮现标题栏：拖动标题 = 移动/换位，🔇 = 声音焦点，↗ = 去 YouTube，✕ = 移除

## 项目结构

```
extension/           WebExtension 源码（Chrome 直接加载；Safari 由此转换）
├── manifest.json    MV3 清单
├── common.js        共用常量与 URL 解析
├── multiview.js     多屏引擎（覆盖层 UI、网格/自由布局、postMessage 播放控制、持久化）
├── multiview.css    多屏视图样式（玻璃拟态覆盖层）
├── content.js/css   youtube.com 站内集成（悬浮舱、观看页交接、缩略图悬停按钮）
├── background.js    Service worker（添加队列去重/上限、右键菜单、打开/聚焦多屏）
└── icons/           扩展图标（由 scripts/make-icons.py 生成）
```
