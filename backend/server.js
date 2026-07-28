const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "ytstream-download-youtube-videos.p.rapidapi.com";

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://yt-dowloader-cfol.onrender.com",
  process.env.CLIENT_ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.endsWith(".vercel.app")) return callback(null, true);
      console.log("[CORS blocked]", origin);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json());

// ---------------------------------------------------------------------
// URL / video-id handling
// ---------------------------------------------------------------------
const YT_URL_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;

function isValidYoutubeUrl(url) {
  return typeof url === "string" && YT_URL_REGEX.test(url.trim());
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]+)/,
    /(?:youtube\.com\/shorts\/)([\w-]+)/,
    /(?:youtube\.com\/embed\/)([\w-]+)/,
    /(?:youtu\.be\/)([\w-]+)/,
  ];
  for (const re of patterns) {
    const match = url.match(re);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------
// RapidAPI (YTStream) call — returns formats/adaptiveFormats with direct
// googlevideo.com CDN links. No bot-check, no cookies, no proxy needed.
// ---------------------------------------------------------------------
async function fetchStreamData(videoId) {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not configured on server");

  const res = await fetch(`https://${RAPIDAPI_HOST}/dl?id=${videoId}`, {
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_HOST,
    },
  });

  if (!res.ok) throw new Error(`RapidAPI returned ${res.status}`);
  const data = await res.json();
  if (data.status !== "OK") throw new Error(data.errorId || "RapidAPI returned an error");
  return data;
}

function pickVideoStream(adaptiveFormats, quality) {
  const videoStreams = adaptiveFormats.filter((f) => f.mimeType?.startsWith("video/"));
  if (!videoStreams.length) return null;

  // prefer mp4 (avc1) for best compatibility with ffmpeg muxing + playback
  const mp4Streams = videoStreams.filter((f) => f.mimeType.includes("mp4"));
  const pool = mp4Streams.length ? mp4Streams : videoStreams;

  const heightMap = { "1080p": 1080, "720p": 720, "480p": 480 };
  const targetHeight = heightMap[quality];

  const sorted = [...pool].sort((a, b) => (b.height || 0) - (a.height || 0));

  if (!targetHeight) return sorted[0]; // "best"

  // closest match at or below the requested height, else the smallest available
  const atOrBelow = sorted.filter((f) => (f.height || 0) <= targetHeight);
  return atOrBelow[0] || sorted[sorted.length - 1];
}

function pickAudioStream(adaptiveFormats) {
  const audioStreams = adaptiveFormats.filter((f) => f.mimeType?.startsWith("audio/"));
  if (!audioStreams.length) return null;

  // prefer audio/mp4 (AAC) — muxes cleanly into an mp4 container
  const mp4Audio = audioStreams.filter((f) => f.mimeType.includes("mp4"));
  const pool = mp4Audio.length ? mp4Audio : audioStreams;

  return [...pool].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

// ---------------------------------------------------------------------
// Stream a remote URL to a local file, reporting progress via callback
// ---------------------------------------------------------------------
const CDN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://www.youtube.com/",
  "Origin": "https://www.youtube.com",
  "Accept": "*/*",
};

async function downloadToFile(url, destPath, onProgress) {
  const res = await fetch(url, { headers: CDN_HEADERS });
  if (!res.ok || !res.body) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Stream download failed (${res.status}) ${bodyText.slice(0, 150)}`);
  }

  const total = parseInt(res.headers.get("content-length") || "0", 10);
  let loaded = 0;

  const writeStream = fs.createWriteStream(destPath);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.length;
    writeStream.write(Buffer.from(value));
    if (total && onProgress) onProgress(loaded / total);
  }

  await new Promise((resolve, reject) => {
    writeStream.end((err) => (err ? reject(err) : resolve()));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// ---------------------------------------------------------------------
// Job store + SSE broadcast
// ---------------------------------------------------------------------
const jobs = new Map();

function createJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function broadcast(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const payload = JSON.stringify({
    status: job.status,
    progress: job.progress,
    error: job.error || null,
    fileName: job.fileName || null,
  });
  job.clients.forEach((res) => res.write(`data: ${payload}\n\n`));
}

// ---------------------------------------------------------------------
// GET video metadata — oEmbed (free, unlimited, no bot-check) for the
// lightweight preview; RapidAPI quota is saved for actual downloads.
// ---------------------------------------------------------------------
app.post("/api/info", async (req, res) => {
  const { url } = req.body;

  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ message: "Please paste a valid YouTube URL" });
  }

  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    );
    if (!response.ok) throw new Error(`oEmbed returned ${response.status}`);

    const data = await response.json();
    res.json({
      title: data.title,
      thumbnail: data.thumbnail_url,
      uploader: data.author_name,
      duration: null,
      viewCount: null,
    });
  } catch (err) {
    console.log("[info error]", err.message);
    res.status(500).json({ message: "Couldn't load video info. Check the link and try again." });
  }
});

// ---------------------------------------------------------------------
// Start a download job
// ---------------------------------------------------------------------
app.post("/api/download", (req, res) => {
  const { url, type, quality } = req.body;

  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ message: "Please paste a valid YouTube URL" });
  }
  if (!["video", "audio"].includes(type)) {
    return res.status(400).json({ message: "Invalid type" });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ message: "Couldn't parse video ID from that URL" });
  }

  const jobId = createJobId();
  jobs.set(jobId, { status: "starting", progress: 0, clients: [] });
  res.json({ jobId });

  processDownload({ jobId, videoId, type, quality }).catch((err) => {
    const job = jobs.get(jobId);
    if (!job) return;
    console.log(`[job ${jobId}] failed:`, err.message);
    job.status = "error";
    job.error = "Download failed. The video may be unavailable, or the service hit its request limit.";
    broadcast(jobId);
    job.clients.forEach((r) => r.end());
  });
});

async function processDownload({ jobId, videoId, type, quality }) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "downloading";
  job.progress = 2;
  broadcast(jobId);

  const data = await fetchStreamData(videoId);
  const adaptiveFormats = data.adaptiveFormats || [];

  const tmpVideo = path.join(DOWNLOAD_DIR, `${jobId}.video.tmp`);
  const tmpAudio = path.join(DOWNLOAD_DIR, `${jobId}.audio.tmp`);
  let finalPath;
  let finalName;

  if (type === "audio") {
    const bitrate = ["128", "192", "320"].includes(quality) ? quality : "192";
    const audioStream = pickAudioStream(adaptiveFormats);
    if (!audioStream) throw new Error("No audio stream available");

    await downloadToFile(audioStream.url, tmpAudio, (frac) => {
      job.progress = Math.round(5 + frac * 80); // 5-85% = download
      broadcast(jobId);
    });

    job.progress = 88;
    broadcast(jobId);

    finalName = `${jobId}.mp3`;
    finalPath = path.join(DOWNLOAD_DIR, finalName);
    await runFfmpeg(["-y", "-i", tmpAudio, "-vn", "-b:a", `${bitrate}k`, "-ar", "44100", finalPath]);

    fs.unlink(tmpAudio, () => {});
  } else {
    const videoStream = pickVideoStream(adaptiveFormats, quality);
    const audioStream = pickAudioStream(adaptiveFormats);
    if (!videoStream || !audioStream) throw new Error("Required streams not available");

    const videoTotal = parseInt(videoStream.contentLength || "0", 10) || 1;
    const audioTotal = parseInt(audioStream.contentLength || "0", 10) || 1;
    const combinedTotal = videoTotal + audioTotal;

    await downloadToFile(videoStream.url, tmpVideo, (frac) => {
      job.progress = Math.round(5 + (frac * videoTotal * 75) / combinedTotal);
      broadcast(jobId);
    });

    await downloadToFile(audioStream.url, tmpAudio, (frac) => {
      job.progress = Math.round(5 + ((videoTotal + frac * audioTotal) * 75) / combinedTotal);
      broadcast(jobId);
    });

    job.progress = 90;
    broadcast(jobId);

    finalName = `${jobId}.mp4`;
    finalPath = path.join(DOWNLOAD_DIR, finalName);
    // -c copy: no re-encoding, just remux — fast, and preserves original quality
    await runFfmpeg([
      "-y",
      "-i", tmpVideo,
      "-i", tmpAudio,
      "-c", "copy",
      "-map", "0:v:0",
      "-map", "1:a:0",
      finalPath,
    ]);

    fs.unlink(tmpVideo, () => {});
    fs.unlink(tmpAudio, () => {});
  }

  job.status = "done";
  job.progress = 100;
  job.filePath = finalPath;
  job.fileName = finalName;
  broadcast(jobId);
  job.clients.forEach((r) => r.end());
}

// ---------------------------------------------------------------------
// Live progress stream
// ---------------------------------------------------------------------
app.get("/api/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress })}\n\n`);
  job.clients.push(res);

  req.on("close", () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
});

// ---------------------------------------------------------------------
// Serve the completed file
// ---------------------------------------------------------------------
app.get("/api/file/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== "done" || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({ message: "File not ready or already cleaned up" });
  }

  const ext = path.extname(job.fileName);
  const niceName = `youtube-download-${jobId.slice(0, 6)}${ext}`;

  res.download(job.filePath, niceName, (err) => {
    if (err) console.error("[download error]", err.message);
  });
});

// ---------------------------------------------------------------------
// Housekeeping: delete files older than 1hr, every 30 min
// ---------------------------------------------------------------------
setInterval(() => {
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach((f) => {
      const filePath = path.join(DOWNLOAD_DIR, f);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > 60 * 60 * 1000) fs.unlink(filePath, () => {});
      });
    });
  });
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});