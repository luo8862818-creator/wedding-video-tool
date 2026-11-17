const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { renderVideo } = require("./render");

const app = express();
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");
const jobs = new Map();
let activeJobId = null;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(ROOT, { index: "index.html", dotfiles: "ignore" }));

function fail(res, status, error) {
  return res.status(status).json({ error });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "wedding-video-tool" });
});

app.post("/api/export", async (req, res) => {
  if (activeJobId) return fail(res, 409, "当前已有导出任务，请等待完成后再试。");

  const { sourcePath, musicPath = "", duration, fps, width, height, outputName } = req.body || {};
  if (typeof sourcePath !== "string" || !sourcePath.trim()) return fail(res, 400, "请填写邀请函 HTML 文件的完整路径。");

  const source = path.resolve(sourcePath.trim());
  if (path.extname(source).toLowerCase() !== ".html" || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return fail(res, 400, "找不到 HTML 文件，请检查路径是否正确。");
  }

  const seconds = Number(duration);
  const frameRate = Number(fps);
  const videoWidth = Number(width);
  const videoHeight = Number(height);
  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 300) return fail(res, 400, "视频时长必须是 3～300 秒的整数。");
  if (![25, 30, 60].includes(frameRate)) return fail(res, 400, "帧率仅支持 25、30 或 60 FPS。");
  if (![1080, 1920].includes(videoWidth) || ![1080, 1920].includes(videoHeight)) return fail(res, 400, "视频尺寸不受支持。");

  let music = null;
  if (musicPath.trim()) {
    music = path.resolve(musicPath.trim());
    if (!fs.existsSync(music) || !fs.statSync(music).isFile()) return fail(res, 400, "找不到背景音乐文件，请检查路径。");
  }

  const safeName = path.basename(String(outputName || "wedding-invitation.mp4")).replace(/[^\w\-.\u4e00-\u9fa5]/g, "_");
  const finalName = safeName.toLowerCase().endsWith(".mp4") ? safeName : `${safeName}.mp4`;
  const jobId = randomUUID();
  const job = {
    id: jobId,
    status: "running",
    progress: 0,
    stepLabel: "启动浏览器",
    message: "正在准备渲染",
    outputName: finalName,
    outputUrl: `/api/output/${encodeURIComponent(finalName)}`,
    error: null
  };

  jobs.set(jobId, job);
  activeJobId = jobId;
  res.status(202).json({ jobId });

  renderVideo({
    sourcePath: source,
    musicPath: music,
    outputPath: path.join(OUTPUT_DIR, finalName),
    duration: seconds,
    fps: frameRate,
    width: videoWidth,
    height: videoHeight,
    onProgress: (progress, stepLabel, message) => {
      Object.assign(job, { progress, stepLabel, message });
    }
  })
    .then(() => Object.assign(job, { status: "completed", progress: 100, stepLabel: "完成", message: "视频已生成" }))
    .catch((error) => {
      job.status = "failed";
      job.error = error.message || "未知导出错误";
      job.stepLabel = "导出失败";
      console.error(`[export:${jobId}]`, error);
    })
    .finally(() => {
      activeJobId = null;
    });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return fail(res, 404, "任务不存在或服务已重启。");
  res.json(job);
});

app.get("/api/output/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(filePath)) return fail(res, 404, "输出文件不存在。");
  res.download(filePath);
});

app.listen(PORT, HOST, () => {
  console.log("==========================================");
  console.log(" Wedding Video Tool 已启动");
  console.log(` 本地地址：http://${HOST}:${PORT}`);
  console.log(` 输出目录：${OUTPUT_DIR}`);
  console.log(" 按 Ctrl + C 停止服务");
  console.log("==========================================");
});
