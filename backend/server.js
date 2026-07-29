const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "ytstream-download-youtube-videos.p.rapidapi.com";

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
// RapidAPI (YTStream) call
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

// Combined (single-file, video+audio already merged) formats only — no
// muxing needed, so the browser can download this URL directly. YouTube
// only offers these up to ~360p; higher qualities require separate
// video/audio streams merged server-side, which we can't do (Render's IP
// gets 403'd by the CDN when fetching video bytes directly).
function pickCombinedFormat(formats, quality) {
  if (!formats?.length) return null;
  const sorted = [...formats].sort((a, b) => (b.height || 0) - (a.height || 0));

  const heightMap = { "1080p": 1080, "720p": 720, "480p": 480 };
  const targetHeight = heightMap[quality];
  if (!targetHeight) return sorted[0]; // "best" available combined format

  const atOrBelow = sorted.filter((f) => (f.height || 0) <= targetHeight);
  return atOrBelow[0] || sorted[sorted.length - 1];
}

function pickAudioStream(adaptiveFormats) {
  const audioStreams = (adaptiveFormats || []).filter((f) => f.mimeType?.startsWith("audio/"));
  if (!audioStreams.length) return null;

  const mp4Audio = audioStreams.filter((f) => f.mimeType.includes("mp4"));
  const pool = mp4Audio.length ? mp4Audio : audioStreams;

  return [...pool].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

function extFromMime(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("webm")) return "webm";
  return "audio";
}

function sanitizeFilename(name) {
  return name.replace(/[^\w\s.-]/g, "").trim().slice(0, 80) || "youtube-download";
}

// ---------------------------------------------------------------------
// GET video metadata — oEmbed (free, unlimited, no bot-check)
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
// Resolve a direct, browser-downloadable CDN URL. Synchronous — no
// server-side file processing, so there's nothing to stream progress on;
// the browser handles the actual download using its own (unflagged) IP.
// ---------------------------------------------------------------------
app.post("/api/download", async (req, res) => {
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

  try {
    const data = await fetchStreamData(videoId);
    const safeTitle = sanitizeFilename(data.title || videoId);

    if (type === "audio") {
      const audioStream = pickAudioStream(data.adaptiveFormats);
      if (!audioStream) {
        return res.status(404).json({ message: "No audio stream available for this video." });
      }
      return res.json({
        downloadUrl: audioStream.url,
        fileName: `${safeTitle}.${extFromMime(audioStream.mimeType)}`,
      });
    }

    const combined = pickCombinedFormat(data.formats, quality);
    if (!combined) {
      return res.status(404).json({
        message: "No direct-downloadable video format available for this video.",
      });
    }
    return res.json({
      downloadUrl: combined.url,
      fileName: `${safeTitle}.mp4`,
      qualityLabel: combined.qualityLabel,
    });
  } catch (err) {
    console.log("[download error]", err.message);
    res.status(500).json({
      message: "Couldn't get a download link. The video may be unavailable, or the service hit its request limit.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});