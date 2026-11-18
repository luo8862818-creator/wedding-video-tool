# Wedding Video Tool

Windows 本地 HTML 婚礼邀请函视频导出工具。Playwright 按指定视频时间离线渲染网页，FFmpeg 通过流式 PNG 输入编码 MP4 并合成可选背景音乐。

## 当前导出流程

1. 导入 HTML/完整项目，或填写本机 index.html 路径。导出期间暂停工具自己的实时预览，避免同时运行两份邀请函。
2. 默认全部使用离线逐帧导出。优先使用声明了 `wedding-video-capture=deterministic` 的播放器 `renderAt/renderCapture/ready/totalMs`；普通网页使用 Playwright Clock，必须通过 `meta name="wedding-video-duration-ms" content="5000"` 或 `player.totalMs` 声明时长。无法控制的动画或未知结束时间会报告原因，绝不自动退回实时录屏。`WEDDING_CAPTURE_MODE=live` 仅用于显式选择旧录制路径。
3. 第 n 帧固定对应 `n × 1000 / FPS` 毫秒，按顺序定位并截图，不按电脑实际渲染速度跳帧。PNG 经带背压的管道送入 FFmpeg，不堆积全部帧、不落盘 PNG 序列。
4. 使用 H.264 / veryfast / CRF 18 / 两线程编码，输入帧率直接决定时间戳，不再经过 FPS 补帧滤镜。保留原有分辨率和 FPS 选项。
5. 背景音乐从视频零时刻开始，循环并在视频结束时间截断。完成严格帧数检查与完整解码校验后，才替换正式 MP4。
6. 日志记录渲染/编码帧数、渲染耗时、视频时长、输出参数、管道背压和连续重复帧。重复帧区分结束停留、运动状态变化和未知静止，不把正常停留判成错误。

GIF / 动态 WebP / APNG 使用 ImageDecoder 按帧时长定位；视频需通过 autoplay 或 data-capture-start-ms 指定时间起点。CSS 背景动图、SVG SMIL、实时媒体和未受控 Worker 等会报告具体限制，不能当成已经支持。播放器接口模式由页面负责自定义 Canvas 的确定性绘制。

## 安装与启动

```powershell
npm ci
npx playwright install chromium
npm start
```

打开 http://127.0.0.1:3000

## 使用

- **单文件网页**：点击“选择 HTML 文件”，适用于 CSS、JavaScript、图片等资源全部内嵌在 HTML 中的独立文件。
- **完整项目**：点击“选择文件夹”，适用于引用外部 CSS、JS、图片、字体、音频等资源的网页；所选文件夹根目录必须有 index.html。
- 可选选择背景音乐；音乐从最终视频起点开始，循环或裁剪到网页录制结束。
- Playwright 的页面录像只包含画面，不会直接录入网页自身播放的音频；如果邀请函 HTML 内有背景音乐，请在工具中选择对应的原始音频文件。
- 选择画面比例、FPS 和输出文件名，点击“开始真实播放并导出 MP4”。
- 不需要提前检测时长，也不需要手动填写视频秒数。
- 导出完成后可在页面内播放或下载 MP4。成品保存在 output 目录。

## 同步原则

- 页面通过 renderAt 定义各阶段的时间，或让普通网页的定时器与 rAF 在 Playwright 虚拟时钟下推进；不会把整个页面强行平均滚动。
- 渲染耗时和播放时间分开统计，慢速渲染只增加导出耗时。
- 输出帧数为 ceil(totalMs × FPS / 1000)，不静默丢帧或用上一帧补齐采集缺口。
- 原素材帧率、页面运动速度及播放器性能仍影响主观观感，不能仅凭标称 FPS 判断合格。
- 背景音乐以最终录制视频时长为边界，结束时同步裁剪。

## 结束时间说明

离线模式使用 player.totalMs 或 wedding-video-duration-ms 明确结束时间，包括结束停留；时长不是整帧数时最多向上补足一个帧间隔。没有明确时长时报告诊断，不通过真实播放猜测结束。

仅显式旧实时模式保留以下启发式结束判断：

1. 页面出现明确的播放完成标记。
2. 已经实际发生过滚动的容器到达底部，并等待末尾动画结束及短暂稳定。
3. CSS transform 驱动的长内容移动到末尾，并等待稳定。
4. 没有滚动容器的分屏动画，在长时间没有可检测的画面位移后结束。

自动结束判断是对普通自动播放网页的通用启发式检测。若网页存在超过 20 秒的章节间停顿、循环动画、滚动循环或非常规画面切换，工具可能无法仅凭网页结构准确推断“创作者认为的结束时刻”。此时应调整网页的播放结束行为，或在后续版本增加可配置的结束条件。单纯选择一个 HTML 文件不会自动包含它引用的外部资源；如网页依赖外部素材，请导入完整文件夹。

## 输出与校验

- 默认输出：1080 × 1920、30 FPS、H.264、MP4。
- 离线模式严格校验 ceil(时长 × FPS) 个输出帧，解码进度的最后一帧 PTS 不作为完整视频时长。
- FFmpeg 封装到临时文件；完整解码校验通过后，才替换 output 目录中的正式 MP4。
- 导出历史记录保存实际视频时长、帧数、平均 FPS、导出耗时和结束判断原因。

## 本地文件说明

- 项目素材导入到 workspaces 目录。
- 输出视频保存在 output 目录。
- 浏览器临时录制文件使用系统临时目录，任务结束后清理。
- 服务仅绑定 127.0.0.1，不要暴露到公网。


## 编码器与排查选项

离线模式默认使用软件 H.264，旧实时模式保留编码器自动选择。Windows PowerShell 可在启动服务前设置：

```powershell
# 直接使用已安装的 Chrome，可免下载独立 Chromium
$env:WEDDING_BROWSER_CHANNEL = "chrome"
# 若驱动在真实录制中不稳定，强制使用限制两线程的软件编码
$env:WEDDING_ENCODER = "software"
npm start
```

`WEDDING_ENCODER` 也接受 `auto`、`h264_qsv`、`h264_nvenc`、`h264_amf`。指定硬件不可用时仍探测软件后备。可用 `FFMPEG_PATH` 指定主 FFmpeg，`FFMPEG_SOFTWARE_PATH` 指定带 libx264 的后备 FFmpeg；默认使用 ffmpeg-static。

硬件/软件选择使用同尺寸的 30 张 JPEG 测试画面及真实 MP4 输出。它是启动探测，不能保证所有驱动在复杂长片中表现相同。编码队列超过约两秒/32 MiB 的界限时会停止并提示，避免悄悄生成已经丢帧的成片。正常静止段需要重复帧，这本身不是故障。

无需设置 WEDDING_CAPTURE_MODE 即默认离线导出。只有显式设置 live 才使用旧实时录制；声明必须确定性导出的网页会拒绝 live。

大项目优先填写本机 HTML 路径，避免反复上传同目录里并未引用的 JPG 原图。若源动画本身帧率很低，提高输出 FPS 不会增加动作细节。

## 测试

`npm test` 运行队列、时间戳、内存界限及过载保护测试。需要本机浏览器和 FFmpeg 的实测用例默认跳过，可执行：

```powershell
$env:RUN_MEDIA_TESTS = "1"
$env:WEDDING_BROWSER_CHANNEL = "chrome"
$env:WEDDING_ENCODER = "software"
npm test
```

媒体用例实际录制一个短测试页面，完整解码验证 1080×1920 / 30 FPS，并检查 iframe 播放器检测、结尾停留和进度值。不会导出整个用户项目或上传照片。
