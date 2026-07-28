const express = require("express");
const cors = require("cors");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const COOKIE_FILE = path.join(__dirname, "cookies.txt");

const app = express();
const PORT = process.env.PORT || 5000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// yt.be / youtube.com/watch/shorts/embed — anything else gets rejected
const YT_URL_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------
// CORS — allow the production frontend, localhost dev, AND any Vercel
// preview-deployment URL for this project (Vercel generates a new
// unique subdomain for every deploy, so a single exact-match string
// breaks the moment you push a new commit / open a preview build).
// ---------------------------------------------------------------------

// comma-separated list of exact allowed origins, e.g.
// CLIENT_ORIGIN="https://yt-dowloader-three.vercel.app,http://localhost:5173"
const EXPLICIT_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, "")) // strip trailing slash if someone pastes one
  .filter(Boolean);

// matches any preview URL Vercel generates for this project, e.g.
// https://yt-dowloader-hroe2rwai-sparsh-kashyaps-projects.vercel.app
const VERCEL_PREVIEW_REGEX = /^https:\/\/yt-dowloader-[a-z0-9]+-sparsh-kashyaps-projects\.vercel\.app$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser requests (curl, server-to-server, health checks)
  const clean = origin.replace(/\/$/, "");
  return EXPLICIT_ORIGINS.includes(clean) || VERCEL_PREVIEW_REGEX.test(clean);
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true);
      console.warn("[CORS blocked]", origin);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json());

/**
 * In-memory job store.
 * jobId -> { status, progress, error, filePath, fileName, sseClients: [] }
 * status: starting | downloading | done | error
 */
const jobs = new Map();

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function isValidYoutubeUrl(url) {
  return typeof url === "string" && YT_URL_REGEX.test(url.trim());
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
  job.sseClients.forEach((res) => res.write(`data: ${payload}\n\n`));
}

// whether cookies.txt exists — if it doesn't, we skip --cookies instead of
// crashing every single yt-dlp call with "cookies file not found"
function cookieArgs() {
  return fs.existsSync(COOKIE_FILE) ? ["--cookies", COOKIE_FILE] : [];
}

// android client can't use cookies at all (yt-dlp silently skips it), so
// once cookies are present we stick to clients that support cookie auth.
// The "n"/signature challenge these need is solved by Deno (see Dockerfile).
const CLIENT_ARGS = [
 "--extractor-args",
 "youtube:player_client=web",
 "--js-runtimes",
 "deno",
 "--remote-components",
 "ejs:github"
];

function commonArgs() {
  return [...cookieArgs(), ...CLIENT_ARGS];
}

// ---------------------------------------------------------------------
// GET video metadata (title, thumbnail, duration) before downloading
// ---------------------------------------------------------------------
app.post("/api/info", (req, res) => {
  const { url } = req.body;

  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ message: "Please paste a valid YouTube URL" });
  }

  const args = [...commonArgs(), "--dump-json", "--no-playlist", url];

  // execFile (no shell) -> args passed as an array, no injection risk
  execFile(
    "yt-dlp",
    args,
    { maxBuffer: 1024 * 1024 * 10, timeout: 20000 },
    (error, stdout, stderr) => {
      if (error) {
        console.error("[info error]", stderr || error.message);
        return res
          .status(500)
          .json({ message: "Couldn't fetch video info. Check the link and try again." });
      }
      try {
        const data = JSON.parse(stdout);
        res.json({
          title: data.title,
          thumbnail: data.thumbnail,
          duration: data.duration,
          uploader: data.uploader,
          viewCount: data.view_count,
        });
      } catch (e) {
        res.status(500).json({ message: "Failed to parse video info" });
      }
    }
  );
});

// ---------------------------------------------------------------------
// Start a download job. Returns a jobId immediately; client tracks
// progress over SSE at /api/progress/:jobId
// ---------------------------------------------------------------------
app.post("/api/download", (req, res) => {
  const { url, type, quality } = req.body;

  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ message: "Please paste a valid YouTube URL" });
  }
  if (!["video", "audio"].includes(type)) {
    return res.status(400).json({ message: "Invalid type" });
  }

  const jobId = newJobId();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  let args;
  if (type === "video") {
    const heightMap = { "1080p": 1080, "720p": 720, "480p": 480, best: null };
    const height = Object.prototype.hasOwnProperty.call(heightMap, quality)
      ? heightMap[quality]
      : null;
    const formatStr = height
      ? `bv*[height<=${height}]+ba/b[height<=${height}]`
      : "bv*+ba/b";
    args = [
      ...commonArgs(),
      "-f", formatStr,
      "--merge-output-format", "mp4",
      "-o", outputTemplate,
      "--newline",
      "--no-playlist",
      url,
    ];
  } else {
    const bitrate = ["128", "192", "320"].includes(quality) ? quality : "192";
    args = [
      ...commonArgs(),
      "-x", "--audio-format", "mp3",
      "--audio-quality", `${bitrate}K`,
      "-o", outputTemplate,
      "--newline",
      "--no-playlist",
      url,
    ];
  }

  jobs.set(jobId, { status: "starting", progress: 0, sseClients: [] });

  // spawn with an args array — never string-interpolate the url into a shell command
  const child = spawn("yt-dlp", args);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    const match = text.match(/(\d{1,3}\.\d)%/);
    const job = jobs.get(jobId);
    if (job && match) {
      job.status = "downloading";
      job.progress = parseFloat(match[1]);
      broadcast(jobId);
    }
  });

  child.stderr.on("data", (chunk) => {
    console.error(`[yt-dlp ${jobId}]`, chunk.toString().trim());
  });

  child.on("error", (err) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "error";
    job.error = "yt-dlp not found on server. Is it installed?";
    broadcast(jobId);
  });

  child.on("close", (code) => {
    const job = jobs.get(jobId);
    if (!job) return;

    if (code !== 0) {
      job.status = "error";
      job.error = "Download failed. Video may be private, age-restricted, or unavailable.";
      broadcast(jobId);
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.startsWith(jobId));
    if (!files.length) {
      job.status = "error";
      job.error = "File not found after download completed.";
      broadcast(jobId);
      return;
    }

    job.status = "done";
    job.progress = 100;
    job.filePath = path.join(DOWNLOAD_DIR, files[0]);
    job.fileName = files[0];
    broadcast(jobId);
    job.sseClients.forEach((r) => r.end());
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
  res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress })}\n\n`);
  job.sseClients.push(res);

  req.on("close", () => {
    job.sseClients = job.sseClients.filter((c) => c !== res);
  });
});

// ---------------------------------------------------------------------
// Serve the completed file as a proper attachment download
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