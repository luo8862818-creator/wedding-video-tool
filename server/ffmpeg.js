const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

function createVideo({ framesDir, outputPath, fps, duration, musicPath, onProgress }) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      reject(new Error("没有找到 FFmpeg 可执行文件。请检查 ffmpeg-static 是否安装完整。"));
      return;
    }

    const framePattern = path.join(framesDir, "frame-%06d.png");
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-framerate", String(fps),
      "-i", framePattern
    ];

    if (musicPath) {
      args.push("-stream_loop", "-1", "-i", musicPath);
    }

    args.push(
      "-t", String(duration),
      "-map", "0:v:0"
    );

    if (musicPath) args.push("-map", "1:a:0");
    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p"
    );

    if (musicPath) {
      args.push("-c:a", "aac", "-b:a", "192k", "-af", "apad");
    }

    args.push("-movflags", "+faststart", outputPath);

    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    process.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    process.on("error", error => reject(new Error(`无法启动 FFmpeg：${error.message}`)));
    process.on("close", code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`FFmpeg 合成失败（退出码 ${code}）。${stderr.slice(-3000)}`));
      }
    });
  });
}

module.exports = { createVideo };
