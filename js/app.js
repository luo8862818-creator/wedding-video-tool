const form = document.querySelector("#export-form");
const exportButton = document.querySelector("#export-button");
const presetSelect = document.querySelector("#preset");
const resolutionLabel = document.querySelector("#resolution-label");
const statusPill = document.querySelector("#status-pill");
const progressText = document.querySelector("#progress-text");
const progressValue = document.querySelector("#progress-value");
const progressBar = document.querySelector("#progress-bar");
const stepText = document.querySelector("#step-text");
const fileText = document.querySelector("#file-text");
const message = document.querySelector("#message");
const downloadLink = document.querySelector("#download-link");

const presets = {
  portrait: { width: 1080, height: 1920, label: "1080 × 1920" },
  landscape: { width: 1920, height: 1080, label: "1920 × 1080" },
  square: { width: 1080, height: 1080, label: "1080 × 1080" }
};

let pollingTimer = null;

function updateResolution() {
  resolutionLabel.textContent = presets[presetSelect.value].label;
}
presetSelect.addEventListener("change", updateResolution);

function setStatus(type, text) {
  statusPill.className = `status-pill ${type}`;
  statusPill.textContent = text;
}

function setProgress(percent, label) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  progressBar.style.width = `${safePercent}%`;
  progressValue.textContent = `${safePercent}%`;
  if (label) progressText.textContent = label;
}

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`;
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法获取任务状态");

    setProgress(result.progress, result.message);
    stepText.textContent = result.stepLabel || "处理中";
    fileText.textContent = result.outputName || "生成中";

    if (result.status === "completed") {
      clearInterval(pollingTimer);
      pollingTimer = null;
      exportButton.disabled = false;
      setStatus("success", "导出完成");
      setProgress(100, "视频已生成");
      showMessage("导出成功。请检查 output 文件夹中的 MP4 文件。", "success");
      downloadLink.href = result.outputUrl;
      downloadLink.textContent = `打开文件：${result.outputName}`;
      downloadLink.hidden = false;
      return;
    }

    if (result.status === "failed") {
      clearInterval(pollingTimer);
      pollingTimer = null;
      exportButton.disabled = false;
      setStatus("error", "导出失败");
      showMessage(result.error || "导出失败，请查看服务端终端日志。", "error");
    }
  } catch (error) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    exportButton.disabled = false;
    setStatus("error", "连接中断");
    showMessage(error.message, "error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pollingTimer) clearInterval(pollingTimer);

  const preset = presets[presetSelect.value];
  const payload = {
    sourcePath: document.querySelector("#source-path").value.trim(),
    musicPath: document.querySelector("#music-path").value.trim(),
    duration: Number(document.querySelector("#duration").value),
    fps: Number(document.querySelector("#fps").value),
    width: preset.width,
    height: preset.height,
    outputName: document.querySelector("#output-name").value.trim()
  };

  exportButton.disabled = true;
  downloadLink.hidden = true;
  setStatus("running", "准备导出");
  setProgress(0, "正在提交任务");
  stepText.textContent = "检查参数";
  fileText.textContent = payload.outputName || "待生成";
  showMessage("正在连接本地导出服务……");

  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "创建导出任务失败");

    setStatus("running", "正在导出");
    showMessage("任务已启动。渲染期间请保持服务运行。");
    await pollJob(result.jobId);
    if (exportButton.disabled) {
      pollingTimer = setInterval(() => pollJob(result.jobId), 700);
    }
  } catch (error) {
    exportButton.disabled = false;
    setStatus("error", "启动失败");
    showMessage(error.message, "error");
  }
});

updateResolution();
