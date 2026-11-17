# Wedding Video Tool

一个运行在 Windows 本机的 HTML 婚礼邀请函视频导出工具。使用原生 HTML/CSS/JavaScript 构建操作界面，由 Node.js 提供本地服务，Playwright 控制 Chromium 渲染网页，FFmpeg 合成 MP4。

## 技术栈

- Node.js：本地服务与任务调度
- Express：提供本地 HTTP API
- Playwright + Chromium：加载本地邀请函 HTML 并逐帧截图
- ffmpeg-static：提供 FFmpeg 可执行文件
- HTML / CSS / JavaScript：导出控制面板

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本
- npm
- 首次安装需要网络下载 npm 依赖和 Chromium

## 安装

在项目根目录打开终端：

```bash
npm install
npx playwright install chromium
```

## 启动

可以双击 `start.bat`，也可以在终端运行：

```bash
npm start
```

浏览器访问：

```text
http://127.0.0.1:3000
```

停止服务：回到启动服务的终端按 `Ctrl + C`。

## 使用

1. 在页面填写婚礼邀请函的本机绝对路径，例如 `C:\Users\用户名\Desktop\wedding\index.html`。
2. 可选填写背景音乐文件的本机绝对路径。
3. 选择画面比例、帧率、视频时长和输出文件名。
4. 点击“开始导出 MP4”。
5. 成品保存到项目根目录的 `output` 文件夹。

默认抖音竖屏规格为 1080 × 1920、30 FPS。

## 当前版本的渲染方式与限制

当前为第一版基础渲染流程：

- Playwright 以所选分辨率打开本地 HTML。
- 等待页面加载、字体就绪和图片加载。
- 根据视频时长，将页面从顶部滚动到页面底部，并逐帧截图。
- FFmpeg 将 PNG 序列编码为 H.264 MP4；背景音乐可选，提供后会循环铺满视频时长。

请注意：

1. 当前滚动方式是从页面顶部到页面底部的线性滚动，不会自动理解邀请函中的分镜、停留点或复杂动画节奏。
2. 页面自身的定时器、CSS 动画、视频和音频播放可能仍按真实时间运行，因此复杂动态页面还需要增加“导出模式/时间轴控制接口”，才能保证逐帧确定性和音画同步。
3. 本版本以静态网页、图片和普通滚动页面为第一验证目标。导出前请确认素材使用相对路径且本地可访问。
4. 逐帧 PNG 会临时写入系统临时目录，合成完成后自动清理；最终 MP4 写入 `output`。
5. 当前服务只绑定 `127.0.0.1`，仅供本机使用。不要改成公网监听，也不要将服务暴露到局域网或互联网。

## 项目结构

```text
wedding-video-tool/
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
├── server/
│   ├── server.js
│   ├── render.js
│   └── ffmpeg.js
├── config/
│   └── video.config.js
├── output/
├── package.json
├── start.bat
└── .gitignore
```

## Git 忽略规则

`node_modules/`、导出视频和临时文件不应提交到 Git。请保留 `package-lock.json`，用于锁定依赖版本。
