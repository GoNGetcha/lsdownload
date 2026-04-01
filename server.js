const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const { JSDOM } = require("jsdom");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const tempDir = path.join(__dirname, "temp");
const publicDir = path.join(__dirname, "public");

async function ensureTempDir() {
  await fsp.mkdir(tempDir, { recursive: true });
}

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extractMediaUrls(htmlText) {
  const dom = new JSDOM(htmlText);
  const { document } = dom.window;
  const urls = new Set();

  // 과제 요구사항에 따라 HLS(.m3u8)만 수집
  const urlPattern = /(https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?)/gi;

  const mediaElements = document.querySelectorAll("video, audio, source");
  mediaElements.forEach((el) => {
    const src = el.getAttribute("src");
    if (src && /^https?:\/\//i.test(src)) {
      if (/\.m3u8(\?.*)?$/i.test(src)) urls.add(src);
    }
  });

  const attrs = document.querySelectorAll("[href], [data-src], [data-url]");
  attrs.forEach((el) => {
    ["href", "data-src", "data-url"].forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value && /^https?:\/\//i.test(value) && /\.m3u8(\?.*)?$/i.test(value)) {
        urls.add(value);
      }
    });
  });

  const scripts = document.querySelectorAll("script");
  scripts.forEach((script) => {
    const text = script.textContent || "";
    const matches = text.match(urlPattern) || [];
    matches.forEach((m) => urls.add(m));
  });

  const bodyTextMatches = htmlText.match(urlPattern) || [];
  bodyTextMatches.forEach((m) => urls.add(m));

  return Array.from(urls);
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return u;
  }
}

function headersToFfmpegArg(headers) {
  const lines = Object.entries(headers)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  return lines;
}

function defaultHeadersForUrl(_inputUrl) {
  const base = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "*/*",
  };
  return base;
}

function convertToFormat(inputUrl, outputPath, format) {
  return new Promise((resolve, reject) => {
    const normalized = normalizeUrl(inputUrl);
    // Referer 없이 User-Agent만 제공 (요청사항)
    const headerArg = headersToFfmpegArg(defaultHeadersForUrl(normalized));
    const command = ffmpeg(normalized).inputOptions(["-headers", headerArg]);

    if (format === "mp3") {
      command
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate("192k")
        .format("mp3");
    } else {
      command
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions(["-movflags +faststart"])
        .format("mp4");
    }

    command
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

app.use(express.json());
app.use(express.static(publicDir));

app.post("/api/parse-html", upload.single("htmlFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "HTML 파일이 필요합니다." });
    }

    const htmlText = req.file.buffer.toString("utf8");
    const urls = extractMediaUrls(htmlText);

    if (urls.length === 0) {
      return res.status(400).json({
        error: "HTML 안에서 mp4/mp3/m3u8 등의 미디어 URL을 찾지 못했습니다.",
      });
    }

    return res.json({ urls });
  } catch (err) {
    return res.status(500).json({ error: `파싱 실패: ${err.message}` });
  }
});

app.post("/api/download", async (req, res) => {
  try {
    const { mediaUrl, format } = req.body;

    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
      return res.status(400).json({ error: "유효한 mediaUrl이 필요합니다." });
    }
    if (!/\.m3u8(\?.*)?$/i.test(mediaUrl)) {
      return res.status(400).json({ error: "mediaUrl은 .m3u8(HLS)만 지원합니다." });
    }
    if (!["mp4", "mp3"].includes(format)) {
      return res.status(400).json({ error: "format은 mp4 또는 mp3만 가능합니다." });
    }

    await ensureTempDir();

    const fileId = crypto.randomUUID();
    const extension = format === "mp3" ? ".mp3" : ".mp4";
    const outputName = safeFilename(`download_${fileId}${extension}`);
    const outputPath = path.join(tempDir, outputName);

    await convertToFormat(mediaUrl, outputPath, format);

    res.download(outputPath, outputName, async () => {
      try {
        await fsp.unlink(outputPath);
      } catch (e) {
        if (e.code !== "ENOENT") {
          console.error("temp file cleanup failed:", e.message);
        }
      }
    });
  } catch (err) {
    return res.status(500).json({
      error:
        "다운로드/변환 실패: URL이 만료되었거나 접근 권한이 없을 수 있습니다. " +
        err.message,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
