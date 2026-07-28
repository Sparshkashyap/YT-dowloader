const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const COOKIE_FILE = path.join(__dirname, "cookies.txt");

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
      if (!origin) return callback(null, true); // curl / server-to-server / health checks
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.endsWith(".vercel.app")) return callback(null, true); // any preview/prod Vercel deploy
      console.log("[CORS blocked]", origin);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json());

// ---------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------
const YT_URL_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;

function isValidYoutubeUrl(url) {
  return typeof url === "string" && YT_URL_REGEX.test(url.trim());
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
    attempt: job.attempt || null, // which client is currently being tried
  });
  job.clients.forEach((res) => res.write(`data: ${payload}\n\n`));
}

// ---------------------------------------------------------------------
// yt-dlp client fallback chain
//
// YouTube's bot-check behaves differently per "client" yt-dlp pretends to
// be. No single client is reliably unblocked — it shifts over time and by
// IP range — so instead of picking one, we try several in order and move
// to the next the moment one fails. Cookies (if present) help the
// cookie-aware clients; clients that don't support cookies just ignore
// them (yt-dlp skips them automatically with a warning).
// ---------------------------------------------------------------------
const CLIENT_CHAIN = ["android", "ios", "tv", "web_safari", "web"];

function baseArgs() {
  const args = ["--js-runtimes", "deno", "--no-playlist", "--retries", "2", "--fragment-retries", "2"];
  if (fs.existsSync(COOKIE_FILE)) args.push("--cookies", COOKIE_FILE);
  return args;
}

function buildFormatArgs(type, quality) {
  if (type === "video") {
    const heightMap = { "1080p": 1080, "720p": 720, "480p": 480, best: null };
    const height = Object.prototype.hasOwnProperty.call(heightMap, quality) ? heightMap[quality] : null;
    const formatStr = height ? `bv*[height<=${height}]+ba/b[height<=${height}]` : "bv*+ba/b";
    return ["-f", formatStr, "--merge-output-format", "mp4"];
  }
  const bitrate = ["128", "192", "320"].includes(quality) ? quality : "192";
  return ["-x", "--audio-format", "mp3", "--audio-quality", `${bitrate}K`];
}

/**
 * Try each client in CLIENT_CHAIN, one at a time, until one produces a
 * finished file (exit code 0) or the chain is exhausted.
 */
function runWithFallback({ jobId, url, type, quality, outputTemplate, onDone }) {
  const job = jobs.get(jobId);
  if (!job) return;

  let chainIndex = 0;

  function attemptNext() {
    if (chainIndex >= CLIENT_CHAIN.length) {
      job.status = "error";
      job.error = "Download failed. YouTube is blocking this server right now — try again in a bit.";
      broadcast(jobId);
      onDone(false);
      return;
    }

    const client = CLIENT_CHAIN[chainIndex];
    chainIndex += 1;

    job.status = "downloading";
    job.attempt = client;
    job.progress = 0;
    broadcast(jobId);

    const args = [
      ...baseArgs(),
      "--extractor-args", `youtube:player_client=${client}`,
      ...buildFormatArgs(type, quality),
      "-o", outputTemplate,
      "--newline",
      url,
    ];

    const child = spawn("yt-dlp", args);
    let lastErrLine = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const match = text.match(/(\d{1,3}\.\d)%/);
      if (match) {
        job.progress = parseFloat(match[1]);
        broadcast(jobId);
      }
    });

    child.stderr.on("data", (chunk) => {
      lastErrLine = chunk.toString().trim() || lastErrLine;
      console.log(`[yt-dlp ${jobId} client=${client}]`, chunk.toString().trim());
    });

    child.on("error", () => {
      // yt-dlp binary itself missing/crashed — no point trying other clients
      job.status = "error";
      job.error = "yt-dlp not found on server.";
      broadcast(jobId);
      onDone(false);
    });

    child.on("close", (code) => {
      if (code === 0) {
        onDone(true);
        return;
      }
      console.log(`[yt-dlp ${jobId}] client "${client}" failed (${lastErrLine.slice(0, 120)}), trying next...`);
      attemptNext();
    });
  }

  attemptNext();
}

// ---------------------------------------------------------------------
// GET video metadata via YouTube's public oEmbed API — no bot-check
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

  const jobId = createJobId();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  jobs.set(jobId, { status: "starting", progress: 0, clients: [] });

  runWithFallback({
    jobId,
    url,
    type,
    quality,
    outputTemplate,
    onDone: (success) => {
      const job = jobs.get(jobId);
      if (!job) return;

      if (!success) {
        job.clients.forEach((r) => r.end());
        return;
      }

      const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(jobId));
      if (!files.length) {
        job.status = "error";
        job.error = "File not found after download completed.";
        broadcast(jobId);
        job.clients.forEach((r) => r.end());
        return;
      }

      job.status = "done";
      job.progress = 100;
      job.filePath = path.join(DOWNLOAD_DIR, files[0]);
      job.fileName = files[0];
      broadcast(jobId);
      job.clients.forEach((r) => r.end());
    },
  });

  res.json({ jobId });
});

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
  res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress, attempt: job.attempt })}\n\n`);
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