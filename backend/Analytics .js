// Lightweight GA4 wrapper. Nothing loads or tracks until the user has
// explicitly accepted the consent banner — gtag.js is injected on demand,
// not on page load, so no request goes to Google before consent.

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const CONSENT_KEY = "yt-downloader-analytics-consent"; // "granted" | "denied"

let initialized = false;

export function getConsent() {
  return localStorage.getItem(CONSENT_KEY); // null | "granted" | "denied"
}

export function setConsent(value) {
  localStorage.setItem(CONSENT_KEY, value);
  if (value === "granted") initAnalytics();
}

export function initAnalytics() {
  if (initialized || !GA_ID || getConsent() !== "granted") return;
  initialized = true;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  // anonymize_ip keeps this squarely in "essential aggregate usage" territory
  gtag("config", GA_ID, { anonymize_ip: true });
}

export function trackEvent(name, params = {}) {
  if (!initialized || getConsent() !== "granted") return;
  window.gtag?.("event", name, params);
}