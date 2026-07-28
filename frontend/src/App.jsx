import { useState, useRef, useEffect } from "react";
import axios from "axios";
import confetti from "canvas-confetti";
import {
  Download,
  Music,
  Video,
  Loader2,
  Link2,
  PlayCircle,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  ShieldCheck,
} from "lucide-react";
import "./index.css";
import { getConsent, setConsent, initAnalytics, trackEvent } from "./analytics";

const API = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

const VIDEO_QUALITIES = [
  { value: "best", label: "Best available" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];

const AUDIO_QUALITIES = [
  { value: "320", label: "320 kbps (High)" },
  { value: "192", label: "192 kbps (Standard)" },
  { value: "128", label: "128 kbps (Small)" },
];

function formatDuration(sec) {
  if (!sec && sec !== 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatViews(n) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} views`;
}

// confetti bomb when a download finishes — color set matches the chosen type
function celebrateDownload(kind) {
  const palette =
    kind === "audio"
      ? ["#16a34a", "#22c55e", "#4ade80", "#ffffff"]
      : ["#dc2626", "#ef4444", "#f87171", "#ffffff"];

  const duration = 1400;
  const end = Date.now() + duration;

  // center burst
  confetti({
    particleCount: 90,
    spread: 100,
    startVelocity: 45,
    origin: { y: 0.6 },
    colors: palette,
    scalar: 1,
  });

  // two side cannons, staggered, for a fuller "bomb" feel
  (function frame() {
    confetti({
      particleCount: 4,
      angle: 60,
      spread: 60,
      origin: { x: 0, y: 0.7 },
      colors: palette,
    });
    confetti({
      particleCount: 4,
      angle: 120,
      spread: 60,
      origin: { x: 1, y: 0.7 },
      colors: palette,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [splashExiting, setSplashExiting] = useState(false);

  const [url, setUrl] = useState("");
  const [type, setType] = useState("video");
  const [quality, setQuality] = useState("best");

  const [videoInfo, setVideoInfo] = useState(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState("");

  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [readyJobId, setReadyJobId] = useState(null);
  const [justDetected, setJustDetected] = useState(false);
  const [showConsent, setShowConsent] = useState(false);

  const debounceRef = useRef(null);
  const eventSourceRef = useRef(null);
  const revealTimerRef = useRef(null);

  useEffect(() => {
    setQuality(type === "video" ? "best" : "192");
  }, [type]);

  // analytics consent: ask once; if already answered, respect it silently
  useEffect(() => {
    const consent = getConsent();
    if (consent === "granted") {
      initAnalytics();
    } else if (consent === null) {
      setShowConsent(true);
    }
  }, []);

  const acceptAnalytics = () => {
    setConsent("granted");
    setShowConsent(false);
  };

  const declineAnalytics = () => {
    setConsent("denied");
    setShowConsent(false);
  };

  // brand splash: hold for ~1.1s, fade out over 400ms -> ~1.5s total
  useEffect(() => {
    const exitTimer = setTimeout(() => setSplashExiting(true), 1100);
    const removeTimer = setTimeout(() => setShowSplash(false), 1500);
    return () => {
      clearTimeout(exitTimer);
      clearTimeout(removeTimer);
    };
  }, []);

  useEffect(() => {
    setVideoInfo(null);
    setInfoError("");
    setReadyJobId(null);
    setStage("");

    if (!url.trim()) return;

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setInfoLoading(true);
      try {
        const res = await axios.post(`${API}/api/info`, { url });
        setVideoInfo(res.data);

        // brand-reveal moment: icon pops in for a beat when a valid link lands
        setJustDetected(true);
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = setTimeout(() => setJustDetected(false), 900);
      } catch (err) {
        setInfoError(err.response?.data?.message || "Couldn't load video info");
      } finally {
        setInfoLoading(false);
      }
    }, 600);

    return () => clearTimeout(debounceRef.current);
  }, [url]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      clearTimeout(revealTimerRef.current);
    };
  }, []);

  const startDownload = async () => {
    if (!url.trim()) {
      setErrorMsg("Paste a YouTube URL first");
      return;
    }

    setDownloading(true);
    setErrorMsg("");
    setProgress(0);
    setStage("starting");
    setReadyJobId(null);
    trackEvent("download_started", { content_type: type, quality });

    try {
      const res = await axios.post(`${API}/api/download`, { url, type, quality });
      const { jobId } = res.data;

      const es = new EventSource(`${API}/api/progress/${jobId}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        setStage(data.status);
        setProgress(data.progress || 0);

        if (data.status === "done") {
          setDownloading(false);
          setReadyJobId(jobId);
          celebrateDownload(type);
          trackEvent("download_completed", { content_type: type, quality });
          es.close();
        }
        if (data.status === "error") {
          setDownloading(false);
          setErrorMsg(data.error || "Download failed");
          trackEvent("download_failed", { content_type: type, reason: data.error || "unknown" });
          es.close();
        }
      };

      es.onerror = () => {
        es.close();
      };
    } catch (err) {
      setDownloading(false);
      setStage("error");
      setErrorMsg(err.response?.data?.message || "Couldn't start download");
      trackEvent("download_failed", { content_type: type, reason: "request_error" });
    }
  };

  const fileHref = readyJobId ? `${API}/api/file/${readyJobId}` : null;

  return (
    <>
      {showSplash && (
        <div className={`splash ${splashExiting ? "splash-exit" : ""}`}>
          <div className="splash-content">
            <div className="splash-icon">
              <Download size={38} color="#fff" strokeWidth={2.4} />
            </div>
            <h1 className="splash-title">YT</h1>
            <p className="splash-sub">videos & audio, made simple</p>
          </div>
        </div>
      )}

      <div className="app-shell">
        <div className="glow glow-video" aria-hidden="true" />
        <div className="glow glow-audio" aria-hidden="true" />
        <div className="glow glow-accent" aria-hidden="true" />

      <div className="app-container">
        {/* Header */}
        <div className="app-header">
          <h1 className="app-title">YT Downloader</h1>
          <p className="app-subtitle">Paste a link, preview it, pick a quality, download.</p>
        </div>

        {/* Card */}
        <div className="card">
          {/* URL input */}
          <label className="field-label">YouTube URL</label>
          <div className="url-input-wrapper">
            <span className={`url-input-icon ${justDetected ? "icon-reveal" : ""}`}>
              {videoInfo ? (
                <PlayCircle size={18} className={type === "audio" ? "icon-audio" : "icon-video"} />
              ) : (
                <Link2 size={18} />
              )}
              {justDetected && <span className="reveal-ring" aria-hidden="true" />}
            </span>
            <input
              className="url-input"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {infoLoading && (
              <span className="url-input-spinner">
                <Loader2 className="spinner" size={18} />
              </span>
            )}
          </div>

          {infoError && (
            <p className="field-error">
              <XCircle size={14} /> {infoError}
            </p>
          )}

          {/* Video preview */}
          {videoInfo && (
            <div className="preview-card">
              <img className="preview-thumb" src={videoInfo.thumbnail} alt={videoInfo.title} />
              <div className="preview-meta">
                <p className="preview-title">{videoInfo.title}</p>
                <p className="preview-uploader">{videoInfo.uploader}</p>
                {(videoInfo.duration || videoInfo.viewCount) && (
                  <div className="preview-stats">
                    {videoInfo.duration && (
                      <span className="preview-stat">
                        <Clock size={12} /> {formatDuration(videoInfo.duration)}
                      </span>
                    )}
                    {videoInfo.viewCount && (
                      <span className="preview-stat">
                        <Eye size={12} /> {formatViews(videoInfo.viewCount)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Type selector */}
          <div className="type-grid">
            <button
              onClick={() => setType("video")}
              className={`type-btn video ${type === "video" ? "selected" : ""}`}
            >
              <Video size={20} />
              Video MP4
            </button>

            <button
              onClick={() => setType("audio")}
              className={`type-btn audio ${type === "audio" ? "selected" : ""}`}
            >
              <Music size={20} />
              MP3 Audio
            </button>
          </div>

          {/* Quality selector */}
          <div className="quality-block">
            <label className="field-label">Quality</label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              className="quality-select"
            >
              {(type === "video" ? VIDEO_QUALITIES : AUDIO_QUALITIES).map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>

          {/* Download button */}
          <button onClick={startDownload} disabled={downloading || !url.trim()} className="download-btn">
            {downloading ? (
              <>
                <Loader2 className="spinner" size={18} />
                {stage === "starting" ? "Starting..." : `Downloading... ${progress.toFixed(0)}%`}
              </>
            ) : (
              <>
                <Download size={18} />
                Download Now
              </>
            )}
          </button>

          {downloading && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          )}

          {errorMsg && !downloading && (
            <div className="alert alert-danger">
              <p className="alert-danger-text">
                <XCircle size={18} /> {errorMsg}
              </p>
            </div>
          )}

          {readyJobId && (
            <div className="alert alert-success">
              <p className="alert-success-text">
                <CheckCircle2 size={18} /> Ready to save
              </p>
              <a href={fileHref} className="save-btn">
                <Download size={18} />
                Save {type === "video" ? "MP4" : "MP3"}
              </a>
            </div>
          )}
        </div>

        <p className="app-footer">Fast • Simple • Free</p>
      </div>
    </div>

    {showConsent && (
      <div className="consent-banner">
        <div className="consent-icon">
          <ShieldCheck size={20} />
        </div>
        <p className="consent-text">
          Ye site anonymous usage analytics (Google Analytics) use karti hai taaki hum tool ko behtar bana sakein — no personal data, sirf aggregate stats.
        </p>
        <div className="consent-actions">
          <button className="consent-btn decline" onClick={declineAnalytics}>
            Decline
          </button>
          <button className="consent-btn accept" onClick={acceptAnalytics}>
            Allow
          </button>
        </div>
      </div>
    )}
    </>
  );
}

export default App;