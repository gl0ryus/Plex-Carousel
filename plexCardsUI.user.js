// ==UserScript==
// @name         Plex 16:9 Cards
// @namespace    https://app.plex.tv
// @version      3.4.7
// @description  Cinematic hero carousel (logo art, dynamic color, autoplay trailers), 16:9 backdrop cards, and a streamlined top bar for Plex Web
// @author       gl0ryus
// @license      MIT
// @match        https://app.plex.tv/*
// @grant        GM_addStyle
// @run-at       document-start
// @homepageURL  https://github.com/gl0ryus/Plex-Carousel
// @supportURL   https://github.com/gl0ryus/Plex-Carousel/issues
// @downloadURL  https://raw.githubusercontent.com/gl0ryus/Plex-Carousel/main/plexCardsUI.user.js
// @updateURL    https://raw.githubusercontent.com/gl0ryus/Plex-Carousel/main/plexCardsUI.user.js
// ==/UserScript==

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TARGET_RATIO    = 9 / 16;  // card aspect ratio target
const PORTRAIT_MIN    = 1.15;    // portrait aspect ratio lower bound (h/w)
const PORTRAIT_MAX    = 1.90;    // portrait aspect ratio upper bound (h/w)
const CARD_MAX_WIDTH  = 800;     // px — wider elements are treated as row containers

const HERO_VIEWPORT_RESERVE = 300; // px reserved at the bottom for the first hub row

const HERO_INTERVAL_MS            = 6000;  // ms between carousel auto-advances
const HERO_DEBOUNCE_MS            = 400;   // ms debounce before carousel init attempt
const HERO_SLIDE_LIMIT            = 10;    // max slides shown in carousel
const HERO_INTERSECTION_THRESHOLD = 0.1;  // carousel pauses when less than this fraction is visible
const HERO_AMBIENT_OPACITY        = 0.55; // in-carousel local ambient glow opacity
const AMBIENT_OPACITY             = 0.6;  // full-page background blur opacity (replaces Plex's flat backdrop on home)

const CAROUSEL_CONTENT    = 'shows'; // 'shows' | 'movies' | 'both'

const RECENT_ITEMS_LIMIT  = 50;   // items fetched per library section from the API
const SKELETON_TIMEOUT_MS = 6000; // ms before loading skeleton is force-removed
const SUMMARY_MAX_LENGTH  = 220;  // max characters shown in carousel item summary

const ENABLE_TOP_NAV       = true; // move pinned libraries into the top bar + collapsible search icon
const NAV_SEARCH_WIDTH     = 480;  // px width of the search box when expanded
const ENABLE_DYNAMIC_ACCENT = true; // tint hero accents with each slide's dominant artwork color (vs fixed Plex gold)
const ENABLE_HERO_TRAILERS  = true; // autoplay a muted trailer in the hero after a short dwell, when the item has one
const HERO_TRAILER_DELAY_MS = 1200; // ms of hover before the trailer begins
const ENABLE_ONLINE_TRAILERS = true; // if no local trailer file exists, pull one from Plex's online trailer service
// ── END CONFIG ───────────────────────────────────────────────────────────────

// Routes the home skin must not touch. Plex is a single-page app, so Tampermonkey's @exclude can't
// catch these in-app navigations — we intercept the route below and switch the page skin off instead.
const EXCLUDE_ROUTE_RE = /[#\/](settings|media|server)(?=[\/?#]|$)/i;

// Page skin — hero carousel, 16:9 cards, dark backgrounds, immersive home.
// Captured so it can be switched off on excluded routes (settings / media / server).
const PLEX_PAGE_STYLE = GM_addStyle(`
.plex-loading-skeleton {
  position: fixed; inset: 0; overflow: hidden;
  background: #1c1c1c; z-index: 9998; opacity: 1;
  transition: opacity 0.55s ease; pointer-events: none;
}
.plex-loading-skeleton.plex-skeleton-done { opacity: 0; }
@keyframes plexWaveLR { from { transform: translateX(-100%); } to { transform: translateX(100%);  } }
@keyframes plexWaveRL { from { transform: translateX(100%);  } to { transform: translateX(-100%); } }
@keyframes plexWaveTB { from { transform: translateY(-100%); } to { transform: translateY(100%);  } }
@keyframes plexWaveBT { from { transform: translateY(100%);  } to { transform: translateY(-100%); } }
.plex-loading-skeleton::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(108deg, transparent 35%, rgba(255,255,255,0.035) 50%, transparent 65%);
  will-change: transform; animation: plexWaveLR 9s ease-in-out infinite; animation-delay: -4s;
}
.plex-wave-rl::after { animation-name: plexWaveRL; background: linear-gradient( 72deg, transparent 35%, rgba(255,255,255,0.035) 50%, transparent 65%); }
.plex-wave-tb::after { animation-name: plexWaveTB; background: linear-gradient(195deg, transparent 35%, rgba(255,255,255,0.035) 50%, transparent 65%); }
.plex-wave-bt::after { animation-name: plexWaveBT; background: linear-gradient( 15deg, transparent 35%, rgba(255,255,255,0.035) 50%, transparent 65%); }
.plex-hero-wrapper {
  position: relative; margin: 6px 20px 26px;
  animation: plexHeroIn 0.45s ease forwards;
}
@keyframes plexHeroIn {
  from { opacity: 0; transform: translateY(-12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.plex-hero-ambient {
  position: absolute; inset: 10px -10px -90px;
  background-size: cover; background-position: center 25%;
  filter: blur(45px) saturate(1.6); opacity: 0.55; transform: translateZ(0);
  border-radius: 20px; pointer-events: none;
  transition: opacity 0.7s ease; z-index: 0;
}
.plex-hero {
  position: relative; z-index: 1; width: 100%;
  overflow: hidden; border-radius: 14px; flex-shrink: 0; background: #111;
  box-shadow: 0 10px 36px rgba(0,0,0,0.65), 0 3px 10px rgba(0,0,0,0.40), inset 0 0 0 1px rgba(255,255,255,0.08);
}
.plex-hero-track { position: absolute; inset: 0; }
.plex-hero-slide { position: absolute; inset: 0; opacity: 0; transition: opacity 0.7s ease; pointer-events: none; }
.plex-hero-slide.active { opacity: 1; pointer-events: auto; }
.plex-hero-bg { position: absolute; inset: 0; background-size: cover; background-position: center 25%; }
.plex-hero-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: none; opacity: 0; transition: opacity 0.6s ease; pointer-events: none; }
.plex-hero-video.plex-show { opacity: 1; }
.plex-hero-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to right, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.55) 40%, rgba(0,0,0,0.1) 70%, transparent 100%),
              linear-gradient(to top, rgba(0,0,0,0.45) 0%, transparent 35%);
}
.plex-hero-title-block { position: absolute; top: 24px; left: 28px; right: 48%; }
.plex-hero-bottom-block { position: absolute; bottom: 24px; left: 28px; right: 48%; }
.plex-hero-show { font-size: 32px; font-weight: 900; color: #fff; line-height: 1.15; margin-bottom: 0; text-shadow: 0 2px 10px rgba(0,0,0,0.7); }
.plex-hero-logo { max-width: min(100%, 460px) !important; max-height: 100px !important; width: auto !important; height: auto !important; object-fit: contain; object-position: left top; display: block; opacity: 0; transition: opacity 0.3s ease; filter: drop-shadow(0 3px 14px rgba(0,0,0,0.85)) drop-shadow(0 0 2px rgba(0,0,0,0.55)); }
.plex-hero-logo.plex-loaded { opacity: 1; }
.plex-hero-ep { font-size: 17px; font-weight: 600; color: rgba(255,255,255,0.92); margin-bottom: 4px; text-shadow: 0 1px 5px rgba(0,0,0,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
:root { --plex-accent: #E5A00D; }   /* dynamic per-slide accent — set from the hero artwork's dominant color */
.plex-hero-meta { font-size: 13px; font-weight: 700; color: var(--plex-accent, #E5A00D); letter-spacing: 0.05em; margin-bottom: 10px; text-shadow: 0 1px 4px rgba(0,0,0,0.7); transition: color 0.5s ease; }
.plex-hero-summary { font-size: 13px; line-height: 1.55; color: rgba(255,255,255,0.60); text-shadow: 0 1px 3px rgba(0,0,0,0.7); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.plex-hero-slide:not([data-item-type="episode"]) .plex-hero-ep { font-size: 22px; font-weight: 700; white-space: normal; }
.plex-hero-slide:not([data-item-type="episode"]) .plex-hero-meta { font-size: 15px; }
.plex-hero-slide:not([data-item-type="episode"]) .plex-hero-summary { font-size: 14px; -webkit-line-clamp: 4; }
.plex-hero-btn {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 38px; height: 38px; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.35); background: rgba(0,0,0,0.55);
  color: #fff; font-size: 16px; cursor: pointer; opacity: 0;
  transition: opacity 0.2s, background 0.2s, border-color 0.2s;
  z-index: 10; padding: 0; display: flex; align-items: center; justify-content: center;
}
.plex-hero:hover .plex-hero-btn { opacity: 1; }
.plex-hero-btn:hover { background: rgba(0,0,0,0.8); border-color: rgba(255,255,255,0.7); }
.plex-hero-prev { left: 12px; }
.plex-hero-next { right: 12px; }
.plex-hero-dots { position: absolute; bottom: 14px; right: 18px; display: flex; gap: 5px; z-index: 10; }
.plex-hero-dot { width: 7px; height: 7px; border-radius: 50%; border: none; background: rgba(255,255,255,0.3); cursor: pointer; padding: 0; transition: background 0.25s, transform 0.25s; }
.plex-hero-dot.active { background: var(--plex-accent, #E5A00D); transform: scale(1.3); }
.plex-hero-progress { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: rgba(255,255,255,0.12); z-index: 10; }
.plex-hero-bar { height: 100%; width: 0%; background: var(--plex-accent, #E5A00D); }
#plex-ambient-global {
  position: fixed; inset: 0;
  background-size: cover; background-position: center 25%;
  filter: blur(60px) saturate(1.4); transform: translateZ(0); will-change: opacity;
  opacity: 0; pointer-events: none; z-index: 0;
  transition: opacity 0.7s ease;
}
html { background: #111 !important; }
body, #plex { background: transparent !important; }
.dark-scrollbar { background: transparent !important; }
[class*="FullPage-container"] { background: transparent !important; }
body.plex-topnav [class*="NavBar-container"] {   /* floating dark pill nav over the ambient blur */
  background: rgba(0,0,0,0.6) !important; border-radius: 16px !important; margin: 10px 14px !important;
  border: 1px solid rgba(255,255,255,0.06) !important; box-shadow: 0 8px 26px rgba(0,0,0,0.5) !important;
  -webkit-backdrop-filter: blur(10px) saturate(1.2) !important; backdrop-filter: blur(10px) saturate(1.2) !important;
}
html body [class*="PageHeader-pageHeader"] { display: none !important; }
[class*="MetadataPosterCardBadge-badge"], [class*="MetadataPosterCardBadge-topRightBadge"] { display: none !important; }
[class*="MetadataPosterCardTitle-centeredSingleLineTitle"] {
  background: transparent !important;
  text-shadow: 0 0 6px rgba(0,0,0,1), 0 0 16px rgba(0,0,0,0.8), 0 0 36px rgba(0,0,0,0.5), 0 0 60px rgba(0,0,0,0.2) !important;
}
[class*="VirtualHubScroller-hub"] { padding-bottom: 4px !important; margin-bottom: 0 !important; }
[class*="VirtualHubScroller-hub"] [class*="Scroller-scroller"] {
  -webkit-mask-image: linear-gradient(to right, black 88%, transparent 100%) !important;
  mask-image: linear-gradient(to right, black 88%, transparent 100%) !important;
}
[class*="HubHeader"], [class*="hubHeader"], [class*="HubTitle"], [class*="hubTitle"] {
  padding-top: 10px !important; padding-bottom: 4px !important; margin-top: 0 !important;
}
img[data-plex-processed="1"] { object-fit: cover !important; object-position: center center !important; width: 100% !important; height: 100% !important; }
img[data-plex-fallback="1"]  { object-fit: cover !important; object-position: center 20% !important; opacity: 1 !important; visibility: visible !important; }   /* Plex hides the img after its own error state — force the poster back */
[data-plex-card="1"] { border-radius: 10px !important; }
[data-plex-role="title"] {
  position: absolute !important; top: 8px !important; left: 8px !important; right: 8px !important;
  margin: 0 !important; padding: 0 !important; background: transparent !important;
  font-size: 14px !important; font-weight: 900 !important; line-height: 1.2 !important;
  color: #ffffff !important;
  text-shadow: 0 0 6px rgba(0,0,0,1), 0 0 16px rgba(0,0,0,0.8), 0 0 36px rgba(0,0,0,0.5), 0 0 60px rgba(0,0,0,0.2) !important;
  text-decoration: none !important; letter-spacing: 0.01em !important;
  white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; display: block !important;
}
[data-plex-role="subtitle"] {
  position: absolute !important; bottom: 13px !important; left: 8px !important; right: 8px !important;
  margin: 0 !important; padding: 0 !important; background: transparent !important;
  font-size: 11px !important; font-weight: 700 !important; line-height: 1.2 !important;
  color: rgba(255,255,255,0.92) !important;
  text-shadow: 0 0 5px rgba(0,0,0,1), 0 0 14px rgba(0,0,0,0.8), 0 0 28px rgba(0,0,0,0.45) !important;
  text-decoration: none !important;
  white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; display: block !important;
}
[data-plex-role="episode"] {
  position: absolute !important; bottom: 1px !important; left: 8px !important;
  margin: 0 !important; padding: 0 !important; background: transparent !important;
  font-size: 10px !important; font-weight: 700 !important; line-height: 1.2 !important;
  color: #E5A00D !important;
  text-shadow: 0 0 4px rgba(0,0,0,1), 0 0 12px rgba(0,0,0,0.8), 0 0 24px rgba(0,0,0,0.4) !important;
  display: block !important; letter-spacing: 0.04em !important;
}
/* ── Immersive home: carousel rests below the nav; content scrolls behind the frosted nav; ambient blur replaces Plex's flat backdrop ── */
body.plex-home [class*="FullPageBackground-backgroundContainer"] { background: transparent !important; }
body.plex-home [class*="FullPageBackground"] canvas { display: none !important; }
body.plex-home [class*="Page-pageScroller"] { height: 100vh !important; }
body.plex-home .plex-hero-wrapper { margin-top: 68px !important; }   /* carousel sits below the nav at rest */
body.plex-home .plex-hero { box-shadow: 0 16px 40px rgba(0,0,0,0.5), 0 0 55px -12px var(--plex-accent, #E5A00D) !important; }   /* smaller glow, no transition — cheaper repaint on each advance */
/* The header float pulls the expanded library drawer up under the nav, so pad its content down to clear the floating pill. */
body.plex-home [class*="SourceSidebarContent-expandedSidebarContent"] { padding-top: 68px !important; }
`);

// Strip the page skin immediately if we loaded straight onto an excluded route (deep link).
if (PLEX_PAGE_STYLE) PLEX_PAGE_STYLE.disabled = EXCLUDE_ROUTE_RE.test(location.hash);

// Top-nav skin — pinned libraries + collapsible search. Always on so navigation stays consistent across pages.
GM_addStyle(`
/* ── Top-nav rework: pinned libraries + collapsible search ────────────────── */
#plex-pinned-topbar { display: flex; flex: 1 1 auto; align-items: center; justify-content: center; gap: 26px; height: 48px; transition: opacity 0.2s ease; }
.plex-pin {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
  font-size: 16px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(255,255,255,0.85); background: none; border: none; cursor: pointer; padding: 0;
  white-space: nowrap; transition: color 0.15s ease;
}
.plex-pin:hover { color: #fff; }
.plex-pin.active { color: #E5A00D; }   /* nav highlight stays gold — decoupled from the rotating hero accent */
#plex-pinned-topbar.plex-dim { opacity: 0.12; pointer-events: none; }
.plex-search-collapsible {
  position: absolute !important; top: 50%; transform: translateY(-50%);
  width: 46px !important; min-width: 0 !important; flex: none !important;
  overflow: hidden; z-index: 30; transition: width 0.25s ease;
}
.plex-search-collapsible.plex-search-open { width: var(--plex-search-width, 480px) !important; overflow: visible; }
.plex-search-collapsible > div:first-child { width: 100% !important; }
body.plex-topnav [class*="SourceSidebar-collapsedSidebar"] { display: none !important; }
body.plex-topnav [class*="SourceSidebar-sidebarUnderlay"] { width: 0 !important; min-width: 0 !important; overflow: hidden !important; }
`);

(function () {
'use strict';

function isPlexTranscodeUrl(src) {
  return typeof src === 'string' && src.includes('/photo/:/transcode');
}

function buildBackdropUrl(src) {
  if (!isPlexTranscodeUrl(src)) return null;
  try {
    const base = src.startsWith('http') ? src : `${location.origin}${src}`;
    const url = new URL(base);
    const inner = url.searchParams.get('url');
    if (!inner) return null;
    if (!inner.includes('/thumb') && !inner.includes('/composite')) return null;
    const newInner = inner
      .replace(/\/thumb(\/\d*)?$/, '/art$1').replace(/\/thumb\//, '/art/')
      .replace(/\/composite(\/\d*)?$/, '/art$1').replace(/\/composite\//, '/art/');
    if (newInner === inner) return null;
    url.searchParams.set('url', newInner);
    const w = parseInt(url.searchParams.get('width') || '0', 10);
    const h = parseInt(url.searchParams.get('height') || '0', 10);
    if (w > 0 && h > 0) url.searchParams.set('height', String(Math.round(w * TARGET_RATIO)));
    return src.startsWith('http') ? url.toString() : `${url.pathname}${url.search}`;
  } catch { return null; }
}

function parsePx(styleStr, prop) {
  const m = styleStr.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)px`));
  return m ? parseFloat(m[1]) : null;
}

function isPortrait(w, h) {
  if (!w || !h || w > CARD_MAX_WIDTH) return false;
  return (h / w) >= PORTRAIT_MIN && (h / w) <= PORTRAIT_MAX;
}

function collectPortraitContainers(img) {
  const found = [];
  let el = img.parentElement;
  for (let i = 0; i < 10; i++) {
    if (!el || el === document.body) break;
    const style = el.getAttribute('style') || '';
    if (style.includes('px')) {
      const w = parsePx(style, 'width'), h = parsePx(style, 'height');
      if (w !== null && h !== null && isPortrait(w, h)) found.push({ el, origW: w, origH: h });
    }
    el = el.parentElement;
  }
  return found;
}

function findRowContainer(img, cardOrigH) {
  let el = img.parentElement;
  for (let i = 0; i < 10; i++) {
    if (!el || el === document.body) break;
    const style = el.getAttribute('style') || '';
    if (style.includes('px')) {
      const w = parsePx(style, 'width'), h = parsePx(style, 'height');
      if (w !== null && h !== null && w > CARD_MAX_WIDTH && h >= cardOrigH && h <= cardOrigH + 150)
        return { el, origH: h };
    }
    el = el.parentElement;
  }
  return null;
}

function applyFixes(cardContainers, rowContainer, newCardH) {
  for (const { el, origW } of cardContainers) {
    if (el.dataset.plexFixed) continue;
    el.dataset.plexFixed = '1';
    el.style.setProperty('height', `${Math.round(origW * TARGET_RATIO)}px`, 'important');
  }
  if (rowContainer && !rowContainer.el.dataset.plexFixed) {
    rowContainer.el.dataset.plexFixed = '1';
    rowContainer.el.style.setProperty('height', `${newCardH + 12}px`, 'important');
  }
}

function overlayCardText(img) {
  const imageContainer = img.closest('[class*="MetadataPosterListItem-card"]');
  if (!imageContainer) return;
  const cardWrapper = imageContainer.parentElement;
  if (!cardWrapper || cardWrapper.dataset.plexCard) return;
  cardWrapper.dataset.plexCard = '1';
  cardWrapper.style.setProperty('overflow', 'hidden', 'important');
  const titleEls = Array.from(cardWrapper.children).filter(
    el => el !== imageContainer && el.matches('[class*="MetadataPosterCardTitle"]')
  );
  const aEls = titleEls.filter(el => el.tagName === 'A');
  const spanEl = titleEls.find(el => el.tagName === 'SPAN');
  if (aEls[0]) aEls[0].dataset.plexRole = 'title';
  if (aEls[1]) aEls[1].dataset.plexRole = 'subtitle';
  if (spanEl)  spanEl.dataset.plexRole  = 'episode';
}

// Resize the portrait card to 16:9 and overlay its text.
function applyCardFix(img, cardContainers) {
  const cardOrigH    = cardContainers[0].origH;
  const newCardH     = Math.round(cardContainers[0].origW * TARGET_RATIO);
  const rowContainer = findRowContainer(img, cardOrigH);
  applyFixes(cardContainers, rowContainer, newCardH);
  overlayCardText(img);
}

// No backdrop art (404) → show the original poster cropped into the 16:9 card.
// The card keeps its 16:9 size so the row stays uniform instead of one card snapping back to portrait.
function onBackdropError(img) {
  if (img.dataset.plexFallback) return;
  img.dataset.plexFallback = '1';
  img.src = img.dataset.origSrc;
}

const pendingImages = new Set();
let retryScheduled = false;
let retryFrames    = 0;

function processImage(img) {
  if (!isHomePage()) return;
  if (img.closest('[class*="SearchResult"]')) return;   // leave search dropdown thumbnails alone
  if (img.dataset.plexProcessed || img.dataset.plexFallback) return;
  const src = img.src || img.getAttribute('data-src') || '';
  if (!isPlexTranscodeUrl(src)) return;
  const backdropSrc = buildBackdropUrl(src);
  if (!backdropSrc) return;
  img.dataset.plexProcessed = '1';
  img.dataset.origSrc = src;
  img.addEventListener('error', () => onBackdropError(img), { once: true });   // attach before the swap so no error is missed
  const cardContainers = collectPortraitContainers(img);
  if (cardContainers.length === 0) {
    pendingImages.add(img);
    retryFrames = 0;   // fresh work — restart the retry budget
  } else {
    applyCardFix(img, cardContainers);
  }
  if (img.src) img.src = backdropSrc;
  else img.setAttribute('data-src', backdropSrc);
}

function retryPending() {
  for (const img of Array.from(pendingImages)) {
    if (!img.isConnected) { pendingImages.delete(img); continue; }
    const cardContainers = collectPortraitContainers(img);
    if (cardContainers.length === 0) continue;
    pendingImages.delete(img);
    applyCardFix(img, cardContainers);
  }
}

function scheduleRetry() {
  if (retryScheduled || pendingImages.size === 0) return;                       // don't stack rAF loops
  if (retryFrames++ > 90) { pendingImages.clear(); retryFrames = 0; return; }    // give up on stuck images (~1.5s)
  retryScheduled = true;
  requestAnimationFrame(() => { retryScheduled = false; retryPending(); scheduleRetry(); });
}

function scanTree(root) {
  const imgs = root.tagName === 'IMG' ? [root] : root.querySelectorAll('img');
  let hadPending = false;
  imgs.forEach(img => { processImage(img); if (pendingImages.has(img)) hadPending = true; });
  if (hadPending) scheduleRetry();
}

// Whole-page upkeep — runs once per mutation batch (not per added node) to avoid redundant queries.
function runMaintenance() {
  hideHomeBar();
  setupTopNav();
  applyImmersiveHome();
  maybeInitCarousel();
}

const OBSERVER_CONFIG = { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src'] };

const observer = new MutationObserver(mutations => {
  let hadNew = false;
  for (const m of mutations) {
    if (m.type === 'childList') {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList?.contains('plex-loading-skeleton')) return;
        scanTree(node);
        hadNew = true;
      });
    } else if (m.type === 'attributes' && m.target.tagName === 'IMG' &&
               !m.target.dataset.plexProcessed && !m.target.dataset.plexFallback) {
      processImage(m.target);
      hadNew = true;
    }
  }
  if (hadNew) {
    runMaintenance();
    if (pendingImages.size > 0) scheduleRetry();
    if (heroEl) guardCarousel();
  }
});

let heroTimerId        = null;
let heroSlide          = 0;
let heroDebounce       = null;
let heroEl             = null;
let heroDispose        = null;   // tears down the current hero's observer/timers/listeners before a rebuild
let heroInitInProgress = false;
let skeletonEl         = null;
let skeletonTimer      = null;
let globalAmbientEl    = null;
let immersiveHeaderEl  = null;

function hideHomeBar() {
  if (!isHomePage()) return;   // only home hides its page header; settings / media / server keep theirs
  const bar = document.querySelector('[class*="PageHeader-pageHeader"]');
  if (!bar || bar.dataset.plexHidden) return;
  bar.style.setProperty('display', 'none', 'important');
  bar.dataset.plexHidden = '1';
  new MutationObserver(() => {
    if (bar.style.display !== 'none') bar.style.setProperty('display', 'none', 'important');
  }).observe(bar, { attributes: true, attributeFilter: ['style'] });
}

function setupTopNav() {
  if (!ENABLE_TOP_NAV) return;
  const nav = document.querySelector('[class*="NavBar-container"]');
  if (!nav || !nav.children[0]) return;
  const leftSection = nav.children[0];
  const logo   = leftSection.querySelector('[class*="logoContainer"]');
  const search = leftSection.querySelector('[class*="UniversalSearch-searchInputContainer"]');
  if (!logo || !search) return;

  // Build the pinned-library buttons once. Home is dropped (the Plex logo already goes home).
  if (!document.getElementById('plex-pinned-topbar')) {
    const pinSrc = [...document.querySelectorAll('[class*="SourceSidebarLink-sourceLink"]')]
      .filter(o => !/HomeSourceLink/i.test(o.className || '') &&
                   (o.getAttribute('aria-label') || o.textContent || '').trim().toLowerCase() !== 'home');
    if (!pinSrc.length) return;   // sidebar links not in the DOM yet — a later mutation retries
    const bar = document.createElement('div');
    bar.id = 'plex-pinned-topbar';
    pinSrc.forEach(orig => {
      const btn = document.createElement('button');
      btn.className = 'plex-pin';
      btn.textContent = orig.getAttribute('aria-label') || orig.textContent.trim();
      btn.addEventListener('click', () => {
        orig.click();
        bar.querySelectorAll('.plex-pin').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
      });
      bar.appendChild(btn);
    });
    logo.after(bar);
    document.body.classList.add('plex-topnav');   // activates the sidebar-hiding CSS
  }

  // Turn the search box into an icon that expands rightward over the pins.
  if (!search.classList.contains('plex-search-collapsible') && logo.offsetWidth) {
    leftSection.style.position = 'relative';
    leftSection.style.justifyContent = 'flex-start';
    if (nav.children[1]) nav.children[1].style.paddingRight = '32px';   // keep the profile icon off the edge
    search.style.left = `${logo.offsetLeft + logo.offsetWidth + 8}px`;
    search.style.setProperty('--plex-search-width', `${NAV_SEARCH_WIDTH}px`);
    search.classList.add('plex-search-collapsible');
  }
  const input = search.querySelector('input');
  if (input && !input.dataset.plexNavWired) {
    input.dataset.plexNavWired = '1';
    const bar = document.getElementById('plex-pinned-topbar');
    const open  = () => { search.classList.add('plex-search-open'); if (bar) bar.classList.add('plex-dim'); };
    const close = () => { if (input.value) return; search.classList.remove('plex-search-open'); if (bar) bar.classList.remove('plex-dim'); };
    input.addEventListener('focus', open);
    input.addEventListener('blur', () => setTimeout(close, 200));
    search.addEventListener('click', () => input.focus());
    close();
  }
}

// Immersive home only: float Plex's header out of flow so content scrolls behind the nav (frosted), not clipped below it.
// Scoped via the `plex-home` body class; reverted on other pages so they keep Plex's normal layout.
function applyImmersiveHome() {
  if (!ENABLE_TOP_NAV) return;
  const home = isHomePage();
  document.body.classList.toggle('plex-home', home);
  if (!immersiveHeaderEl || !immersiveHeaderEl.isConnected) {
    const nav = document.querySelector('[class*="NavBar-container"]');
    if (!nav) return;
    let h = nav.parentElement;
    for (let i = 0; i < 5 && h; i++) {
      const r = h.getBoundingClientRect();
      if (Math.round(r.top) === 0 && r.height >= 56 && r.height <= 92) { immersiveHeaderEl = h; break; }
      h = h.parentElement;
    }
  }
  const header = immersiveHeaderEl;
  if (!header) return;
  if (home === (header.style.position === 'absolute')) return;   // already in the desired state
  if (home) {
    header.style.setProperty('position', 'absolute', 'important');
    header.style.setProperty('top', '0', 'important');
    header.style.setProperty('left', '0', 'important');
    header.style.setProperty('right', '0', 'important');
    header.style.setProperty('z-index', '900', 'important');
  } else {
    ['position', 'top', 'left', 'right', 'zIndex'].forEach(p => { header.style[p] = ''; });
  }
}

// Keep the page skin in sync with the current route. Plex is a single-page app, so we watch in-app
// navigation (hash + History API) and switch the home skin off on settings / media / server pages.
function onRouteChange() {
  if (PLEX_PAGE_STYLE) PLEX_PAGE_STYLE.disabled = isExcludedPage();
  if (isHomePage()) {
    injectSkeleton();
    if (globalAmbientEl) { globalAmbientEl.style.display = ''; globalAmbientEl.style.opacity = AMBIENT_OPACITY; }
  } else {
    removeSkeleton();
    if (heroTimerId) { clearInterval(heroTimerId); heroTimerId = null; }
    if (globalAmbientEl) globalAmbientEl.style.opacity = '0';
    if (isExcludedPage()) {                       // tear the hero fully down so the excluded page is clean
      if (heroDispose) { heroDispose(); heroDispose = null; }
      if (heroEl) { heroEl.remove(); heroEl = null; }
      if (globalAmbientEl) globalAmbientEl.style.display = 'none';
    }
  }
  applyImmersiveHome();
}

function init() {
  observer.observe(document.documentElement, OBSERVER_CONFIG);
  injectSkeleton();
  scanTree(document.documentElement);
  runMaintenance();
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
  ['pushState', 'replaceState'].forEach(m => {   // Plex routes via the hash, but cover History API navigations too
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); onRouteChange(); return r; };
  });
  onRouteChange();   // sync the initial route (handles a deep link straight onto an excluded page)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function isExcludedPage() {
  return EXCLUDE_ROUTE_RE.test(location.hash);   // settings / media / server — the home skin is switched off here
}

function isHomePage() {
  if (location.hash.includes('/search')) return false;   // search view is not home — leave it fully untouched
  return !isExcludedPage();
}

function injectSkeleton() {
  if (!isHomePage() || skeletonEl) return;
  skeletonEl = document.createElement('div');
  skeletonEl.className = 'plex-loading-skeleton';
  const dirs = ['', 'plex-wave-rl', 'plex-wave-tb', 'plex-wave-bt'];
  const dir = dirs[Math.floor(Math.random() * dirs.length)];
  if (dir) skeletonEl.classList.add(dir);
  document.body.appendChild(skeletonEl);
  skeletonTimer = setTimeout(removeSkeleton, SKELETON_TIMEOUT_MS);
}

function removeSkeleton() {
  if (skeletonTimer) { clearTimeout(skeletonTimer); skeletonTimer = null; }
  if (!skeletonEl) return;
  skeletonEl.classList.add('plex-skeleton-done');
  const el = skeletonEl;
  skeletonEl = null;
  setTimeout(() => el.remove(), 550);
}

function getServerInfo() {
  const img = document.querySelector('img[src*="/photo/:/transcode"][src*="X-Plex-Token"]');
  if (!img) return null;
  try {
    const u = new URL(img.src);
    const token = u.searchParams.get('X-Plex-Token');
    const base  = `${u.protocol}//${u.host}`;
    return token && base ? { base, token } : null;
  } catch { return null; }
}

async function fetchMachineIdentifier({ base, token }) {
  const m = location.hash.match(/\/server\/([^/?#]+)/);
  if (m) return m[1];
  try {
    const res = await fetch(`${base}/identity?X-Plex-Token=${token}`, { headers: { Accept: 'application/json' } });
    if (res.ok) return (await res.json()).MediaContainer?.machineIdentifier || '';
  } catch {}
  return '';
}

async function fetchRecentItems({ base, token }) {
  const [sectionsRes, machineIdentifier] = await Promise.all([
    fetch(`${base}/library/sections?X-Plex-Token=${token}`, { headers: { Accept: 'application/json' } }),
    fetchMachineIdentifier({ base, token }),
  ]);
  if (!sectionsRes.ok) throw new Error(`HTTP ${sectionsRes.status}`);
  const wantShows  = CAROUSEL_CONTENT === 'shows'  || CAROUSEL_CONTENT === 'both';
  const wantMovies = CAROUSEL_CONTENT === 'movies' || CAROUSEL_CONTENT === 'both';
  const sectionKeys = ((await sectionsRes.json()).MediaContainer?.Directory || [])
    .filter(s => (wantShows && s.type === 'show') || (wantMovies && s.type === 'movie'))
    .map(s => s.key);
  if (!sectionKeys.length) throw new Error('No matching library sections');

  const fetches = await Promise.all(sectionKeys.map(key =>
    fetch(`${base}/library/sections/${key}/recentlyAdded?X-Plex-Token=${token}&limit=${RECENT_ITEMS_LIMIT}`, { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : {}).catch(() => ({}))
  ));

  const allItems = fetches.flatMap(j => (j.MediaContainer?.Metadata || []).filter(m => m.art));
  allItems.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  const seen = new Set();
  const unique = [];
  for (const item of allItems) {
    const showKey = item.grandparentKey || item.parentKey || item.key;
    if (seen.has(showKey)) continue;
    seen.add(showKey);
    unique.push(item);
    if (unique.length >= HERO_SLIDE_LIMIT) break;
  }

  await Promise.all(unique.map(async item => {
    if ((item.type === 'season' || (!item.grandparentTitle && !item.summary)) && item.parentRatingKey) {
      try {
        const r = await fetch(`${base}/library/metadata/${item.parentRatingKey}?X-Plex-Token=${token}`, { headers: { Accept: 'application/json' } });
        if (r.ok) item._parentSummary = (await r.json()).MediaContainer?.Metadata?.[0]?.summary || '';
      } catch {}
    }
  }));

  return { items: unique, machineIdentifier };
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function plexArtUrl({ base, token }, path, w = 1280, h = 720) {
  return `${base}/photo/:/transcode?width=${w}&height=${h}&minSize=1&url=${encodeURIComponent(path)}&X-Plex-Token=${token}`;
}

// Direct image URL (no transcode) — keeps the PNG alpha channel intact for clearLogo art,
// which the JPEG transcoder would otherwise flatten to a black box.
function plexImageUrl({ base, token }, path) {
  return `${base}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${token}`;
}

// ── Dynamic accent: pull one vivid dominant color out of the hero artwork ──────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h, s, l = (mx + mn) / 2;
  if (mx === mn) { h = s = 0; }
  else {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  const f = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = f(p, q, h + 1/3); g = f(p, q, h); b = f(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
// Bucket the saturated, mid-bright pixels by hue, take the heaviest bucket, force it vivid.
// Returns null when the image has no usable color (all grey/dark) so callers fall back to gold.
function extractVibrant(data) {
  const buckets = {};
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const v = mx / 255, sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (v < 0.2 || v > 0.95 || sat < 0.35) continue;   // skip too dark, blown-out, or greyish
    const hb = Math.round(rgbToHsl(r, g, b)[0] * 12) % 12;
    const w = sat * v;
    const bk = buckets[hb] || (buckets[hb] = { r: 0, g: 0, b: 0, w: 0 });
    bk.r += r * w; bk.g += g * w; bk.b += b * w; bk.w += w;
  }
  let best = null, bestW = -1;
  for (const k in buckets) if (buckets[k].w > bestW) { bestW = buckets[k].w; best = buckets[k]; }
  if (!best) return null;
  const [h, s, l] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
  return hslToRgb(h, Math.min(1, Math.max(0.62, s)), Math.min(0.62, Math.max(0.5, l)));
}
function setAccent(rgb) {
  document.documentElement.style.setProperty('--plex-accent', rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : '#E5A00D');
}

const PLEX_PROVIDER = 'https://metadata.provider.plex.tv';   // Plex's online metadata — serves direct mp4 trailer URLs

// Find a browser-playable trailer for an item: a local extra first, then Plex's online trailer. null if none.
async function fetchTrailer(info, item) {
  const key = item.grandparentRatingKey || item.parentRatingKey || item.ratingKey;
  if (!key) return null;
  try {
    const r = await fetch(`${info.base}/library/metadata/${key}?includeExtras=1&X-Plex-Token=${info.token}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const m0 = (await r.json()).MediaContainer?.Metadata?.[0];
    if (!m0) return null;

    // 1) Local trailer file on the server — direct play, no external dependency.
    const local = ((m0.Extras && m0.Extras.Metadata) || []).find(e => e.subtype === 'trailer');
    if (local) {
      const media = local.Media && local.Media[0];
      const part  = media && media.Part && media.Part[0];
      const cont   = (media && media.container  || '').toLowerCase();
      const vcodec = (media && media.videoCodec || '').toLowerCase();
      if (part && part.key && /^(mp4|m4v|mov|webm)$/.test(cont) && !/hevc|h265|mpeg4|vc1|wmv/.test(vcodec)) {
        return plexImageUrl(info, part.key);
      }
    }

    // 2) Online fallback — Plex's provider returns a direct-play mp4 trailer URL for most recognized titles.
    if (ENABLE_ONLINE_TRAILERS) {
      const plexId = (m0.guid || '').startsWith('plex://') ? m0.guid.split('/').pop() : null;
      if (plexId) {
        const pr = await fetch(`${PLEX_PROVIDER}/library/metadata/${plexId}/extras?X-Plex-Token=${info.token}&X-Plex-Product=Plex%20Web&X-Plex-Client-Identifier=plexcardsui`, { headers: { Accept: 'application/json' } });
        if (pr.ok) {
          const online = ((await pr.json()).MediaContainer?.Metadata || []).find(e => e.subtype === 'trailer');
          const url = online && online.Media && online.Media[0] && online.Media[0].url;
          if (url && /^https?:\/\//.test(url)) return url;   // direct mp4 from the trailer CDN
        }
      }
    }
    return null;
  } catch { return null; }
}

function buildHero(items, info, machineIdentifier) {
  const wrapper = document.createElement('div');
  wrapper.id = 'plex-hero';
  wrapper.className = 'plex-hero-wrapper';

  const ambient = document.createElement('div');
  ambient.className = 'plex-hero-ambient';
  ambient.style.backgroundImage = `url('${plexArtUrl(info, items[0].art)}')`;
  wrapper.appendChild(ambient);

  if (!globalAmbientEl) {
    globalAmbientEl = document.createElement('div');
    globalAmbientEl.id = 'plex-ambient-global';
    const plexEl = document.getElementById('plex');
    document.body.insertBefore(globalAmbientEl, plexEl || document.body.firstChild);
  }
  globalAmbientEl.style.backgroundImage = `url('${plexArtUrl(info, items[0].art)}')`;
  requestAnimationFrame(() => { if (globalAmbientEl) globalAmbientEl.style.opacity = AMBIENT_OPACITY; });

  const hero = document.createElement('div');
  hero.className = 'plex-hero';
  hero.style.height = `calc(100vh - ${HERO_VIEWPORT_RESERVE}px)`;
  const track = document.createElement('div');
  track.className = 'plex-hero-track';

  items.forEach((item, i) => {
    let showTitle, subtitle, meta;
    if (item.grandparentTitle) {
      showTitle = item.grandparentTitle;
      subtitle  = item.title;
      meta = (item.parentIndex && item.index)
        ? `S${String(item.parentIndex).padStart(2,'0')}: E${String(item.index).padStart(2,'0')}` : '';
    } else if (item.type === 'season' || (item.title || '').toLowerCase().startsWith('season')) {
      showTitle = item.parentTitle || item.title;
      subtitle  = item.title;
      meta = item.year ? String(item.year) : '';
    } else {
      showTitle = item.title;
      subtitle  = item.tagline || '';
      meta = item.year ? String(item.year) : '';
    }
    const rawSummary = item._parentSummary || item.summary || '';
    const summary = rawSummary
      ? esc(rawSummary.slice(0, SUMMARY_MAX_LENGTH) + (rawSummary.length > SUMMARY_MAX_LENGTH ? '…' : ''))
      : '';
    const bg = plexArtUrl(info, item.art);
    // Stylized show/movie logo art (Netflix/Disney+ billboard look); plain text title if none exists.
    const logoPath = Array.isArray(item.Image)
      ? (item.Image.find(im => im.type === 'clearLogo') || {}).url
      : null;
    const titleInner = logoPath
      ? `<img class="plex-hero-logo" src="${esc(plexImageUrl(info, logoPath))}" alt="${esc(showTitle)}">`
      : `<div class="plex-hero-show">${esc(showTitle)}</div>`;
    const slide = document.createElement('div');
    slide.className = `plex-hero-slide${i === 0 ? ' active' : ''}`;
    slide.dataset.i = i;
    slide.dataset.itemType = item.type || 'unknown';
    slide.innerHTML = `
      <div class="plex-hero-bg" style="background-image:url('${bg}')"></div>
      <div class="plex-hero-scrim"></div>
      <div class="plex-hero-title-block">${titleInner}</div>
      <div class="plex-hero-bottom-block">
        ${subtitle ? `<div class="plex-hero-ep">${esc(subtitle)}</div>` : ''}
        ${meta     ? `<div class="plex-hero-meta">${esc(meta)}</div>`     : ''}
        ${summary  ? `<div class="plex-hero-summary">${summary}</div>`    : ''}
      </div>`;
    slide.style.cursor = 'pointer';
    const logoImg = slide.querySelector('.plex-hero-logo');
    if (logoImg) {
      const reveal = () => logoImg.classList.add('plex-loaded');   // fade in once decoded — avoids the empty-then-pop
      if (logoImg.complete && logoImg.naturalWidth > 0) reveal();
      else logoImg.addEventListener('load', reveal, { once: true });
      logoImg.addEventListener('error', () => {                    // missing/broken logo → fall back to the text title
        const block = logoImg.closest('.plex-hero-title-block');
        if (!block) return;
        block.textContent = '';
        const t = document.createElement('div');
        t.className = 'plex-hero-show';
        t.textContent = showTitle || '';   // '' (not "undefined") when there is no title
        block.appendChild(t);
      }, { once: true });
    }
    slide.addEventListener('click', e => {
      if (e.target.closest('.plex-hero-btn, .plex-hero-dot')) return;
      const key = `/library/metadata/${item.ratingKey}`;
      if (machineIdentifier) location.hash = `#!/server/${machineIdentifier}/details?key=${encodeURIComponent(key)}`;
      else location.href = `${info.base}${key}?X-Plex-Token=${info.token}`;
    });
    track.appendChild(slide);
  });
  hero.appendChild(track);

  ['prev', 'next'].forEach(dir => {
    const btn = document.createElement('button');
    btn.className = `plex-hero-btn plex-hero-${dir}`;
    btn.textContent = dir === 'prev' ? '❮' : '❯';
    hero.appendChild(btn);
  });

  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'plex-hero-dots';
  items.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = `plex-hero-dot${i === 0 ? ' active' : ''}`;
    d.dataset.i = i;
    dotsWrap.appendChild(d);
  });
  hero.appendChild(dotsWrap);

  const prog = document.createElement('div');
  prog.className = 'plex-hero-progress';
  const bar = document.createElement('div');
  bar.className = 'plex-hero-bar';
  prog.appendChild(bar);
  hero.appendChild(prog);

  const total = items.length;
  heroSlide = 0;   // a fresh hero always opens on slide 0 (DOM marks i===0 active) — keep the shared index in sync

  // Recolor the UI accent to match the active slide's artwork (computed once per item, then cached).
  function applyAccent(item) {
    if (!ENABLE_DYNAMIC_ACCENT || !item || !item.art) return;
    if (item._accent !== undefined) { setAccent(item._accent); return; }   // already computed
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 64; c.height = 36;
        const cx = c.getContext('2d'); cx.drawImage(im, 0, 0, 64, 36);
        const col = extractVibrant(cx.getImageData(0, 0, 64, 36).data);
        item._accent = col;                              // success → cache (a color, or a deterministic null)
        if (items[heroSlide] === item) setAccent(col);   // apply only if still the active slide
      } catch {
        if (items[heroSlide] === item) setAccent(null);  // CORS/canvas error → gold, but don't cache (allow retry)
      }
    };
    im.onerror = () => { if (items[heroSlide] === item) setAccent(null); };   // load failed → gold, don't cache (retry later)
    im.src = plexArtUrl(info, item.art, 64, 36);       // tiny + CORS-clean (distinct URL from the bg)
  }

  // ── Muted autoplay trailer: fades in over the still after a short dwell, fades back when it ends/changes ──
  let heroVideo = null, trailerTimer = null, heroInView = true, hovering = false;

  function clearTrailer() {
    if (trailerTimer) { clearTimeout(trailerTimer); trailerTimer = null; }
    const v = heroVideo;
    heroVideo = null;
    if (v) {
      v.classList.remove('plex-show');                 // fade out
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}   // stop the download immediately
      setTimeout(() => { try { v.remove(); } catch {} }, 650);          // remove the element after the fade
    }
  }

  function startTrailer(slideEl, url) {
    const v = document.createElement('video');
    v.className = 'plex-hero-video';
    v.muted = true; v.defaultMuted = true; v.playsInline = true;
    v.setAttribute('playsinline', ''); v.preload = 'metadata'; v.src = url;   // don't over-buffer a clip shown for seconds
    const bg = slideEl.querySelector('.plex-hero-bg');
    slideEl.insertBefore(v, bg ? bg.nextSibling : slideEl.firstChild);   // above the still, below scrim + text
    heroVideo = v;
    v.addEventListener('playing', () => v.classList.add('plex-show'), { once: true });
    v.addEventListener('ended', clearTrailer, { once: true });
    v.addEventListener('error', clearTrailer, { once: true });
    const p = v.play();
    if (p && p.catch) p.catch(() => clearTrailer());   // autoplay blocked → stay on the still
  }

  function scheduleTrailer() {
    if (!ENABLE_HERO_TRAILERS) return;
    if (trailerTimer) { clearTimeout(trailerTimer); trailerTimer = null; }
    const idx = heroSlide, item = items[idx];
    if (!item) return;
    trailerTimer = setTimeout(async () => {
      trailerTimer = null;
      if (item._trailer === undefined) item._trailer = await fetchTrailer(info, item);   // resolve once, cache
      if (heroSlide !== idx || document.hidden || !heroInView || !hovering || !item._trailer) return;   // only while hovering this slide, in view
      const slideEl = hero.querySelectorAll('.plex-hero-slide')[idx];
      if (slideEl) startTrailer(slideEl, item._trailer);
    }, HERO_TRAILER_DELAY_MS);
  }

  function resetBar() {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = `width ${HERO_INTERVAL_MS / 1000}s linear`;
      bar.style.width = '100%';
    }));
  }

  function goTo(n) {
    heroSlide = ((n % total) + total) % total;
    hero.querySelectorAll('.plex-hero-slide').forEach((s, i) => s.classList.toggle('active', i === heroSlide));
    hero.querySelectorAll('.plex-hero-dot').forEach((d, i)   => d.classList.toggle('active', i === heroSlide));
    clearTrailer();
    ambient.style.opacity = '0';
    if (globalAmbientEl) globalAmbientEl.style.opacity = '0';
    setTimeout(() => {
      const artUrl = plexArtUrl(info, items[heroSlide].art);
      ambient.style.backgroundImage = `url('${artUrl}')`;
      ambient.style.opacity = HERO_AMBIENT_OPACITY;
      if (globalAmbientEl) {
        globalAmbientEl.style.backgroundImage = `url('${artUrl}')`;
        globalAmbientEl.style.opacity = AMBIENT_OPACITY;
      }
    }, 350);
    applyAccent(items[heroSlide]);
    if (hovering) scheduleTrailer();   // trailers play on hover, not during idle auto-advance
    resetBar();
  }

  function startAuto() {
    if (heroTimerId) clearInterval(heroTimerId);
    resetBar();
    heroTimerId = setInterval(() => goTo(heroSlide + 1), HERO_INTERVAL_MS);
  }
  function stopAuto() {
    if (heroTimerId) { clearInterval(heroTimerId); heroTimerId = null; }
    bar.style.transition = 'none';
  }

  hero.querySelector('.plex-hero-prev').addEventListener('click', () => { goTo(heroSlide - 1); startAuto(); });
  hero.querySelector('.plex-hero-next').addEventListener('click', () => { goTo(heroSlide + 1); startAuto(); });
  dotsWrap.querySelectorAll('.plex-hero-dot').forEach(d => {
    d.addEventListener('click', () => { goTo(+d.dataset.i); startAuto(); });
  });
  hero.addEventListener('mouseenter', () => { hovering = true;  stopAuto();  scheduleTrailer(); });
  hero.addEventListener('mouseleave', () => { hovering = false; startAuto(); clearTrailer();    });

  function onVisibility() { if (document.hidden) clearTrailer(); }   // stop a playing trailer when the tab is backgrounded
  document.addEventListener('visibilitychange', onVisibility);

  const io = new IntersectionObserver(entries => {
    heroInView = entries[0].isIntersecting;
    if (heroInView) { startAuto(); }
    else { stopAuto(); clearTrailer(); hovering = false; }
  }, { threshold: HERO_INTERSECTION_THRESHOLD });
  io.observe(hero);

  heroDispose = () => {                 // dispose this instance before a rebuild (no stale observers/timers/video)
    io.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    stopAuto();
    clearTrailer();
  };

  startAuto();
  applyAccent(items[heroSlide]);   // set the accent for the first slide
  wrapper.appendChild(hero);
  return wrapper;
}

function findFirstHub() {
  return document.querySelector('[class*="VirtualHubScroller-hub"]');
}

function heroOuterHeight() {
  if (!heroEl) return 560;
  const r  = heroEl.getBoundingClientRect();
  const cs = getComputedStyle(heroEl);
  return r.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
}

function shiftHub(hub, offset) {
  hub.dataset.plexHeroShifted = '1';
  hub.style.setProperty('transition', 'top 0.4s ease', 'important');
  hub.style.setProperty('top', `${parsePx(hub.getAttribute('style') || '', 'top') + offset}px`, 'important');
}

function pushHubsDown() {
  if (!heroEl || !heroEl.isConnected) return;
  const offset = heroOuterHeight();
  document.querySelectorAll('[class*="VirtualHubScroller-hub"]:not([data-plex-hero-shifted]):not([data-plex-hero-flow])').forEach(hub => {
    // Most Plex builds lay hubs out in normal document flow (position: static/relative),
    // so the relatively-positioned hero already displaces them — nothing to shift.
    // Only builds that absolutely-position hubs (inline `top`) need a manual offset.
    if (getComputedStyle(hub).position !== 'absolute') {
      hub.dataset.plexHeroFlow = '1';   // normal flow — skip permanently (cheap on later passes)
      return;
    }
    const t = parsePx(hub.getAttribute('style') || '', 'top');
    if (t !== null) {
      shiftHub(hub, offset);
    } else if (!hub.dataset.plexHeroWatching) {
      // top not set yet — watch for Plex to assign it, then push.
      // Guard against attaching duplicate observers on repeat pushHubsDown() calls.
      hub.dataset.plexHeroWatching = '1';
      new MutationObserver((_, obs) => {
        if (hub.dataset.plexHeroShifted) { obs.disconnect(); return; }
        const t2 = parsePx(hub.getAttribute('style') || '', 'top');
        if (t2 !== null) { obs.disconnect(); shiftHub(hub, offset); }
      }).observe(hub, { attributes: true, attributeFilter: ['style'] });
    }
  });
}

async function initCarousel() {
  if (heroInitInProgress || (heroEl && heroEl.isConnected)) return;
  const info = getServerInfo();
  if (!info) return;                    // auth not ready yet — let next mutation retry
  heroInitInProgress = true;
  let items, machineIdentifier;
  try {
    ({ items, machineIdentifier } = await fetchRecentItems(info));
  } catch {
    heroInitInProgress = false;
    return;                             // leave skeleton up; timeout will clear it
  }
  if (!items || items.length < 2) { heroInitInProgress = false; return; }
  if (!isHomePage())              { heroInitInProgress = false; return; }   // navigated to an excluded route mid-fetch
  if (heroEl && heroEl.isConnected)   { heroInitInProgress = false; return; }
  const firstHub = findFirstHub();
  if (!firstHub)                       { heroInitInProgress = false; return; }
  if (heroDispose) { heroDispose(); heroDispose = null; }   // tear down the previous hero before replacing it
  heroEl = buildHero(items, info, machineIdentifier);
  firstHub.parentElement.insertBefore(heroEl, firstHub);
  heroInitInProgress = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    pushHubsDown();
    setTimeout(removeSkeleton, 450);
  }));
}

function guardCarousel() {
  if (!isHomePage()) return;
  if (heroEl && heroEl.isConnected) { pushHubsDown(); removeSkeleton(); return; }
  if (!heroEl) return;
  const firstHub = findFirstHub();
  if (firstHub && !firstHub.parentElement.querySelector('#plex-hero')) {
    firstHub.parentElement.insertBefore(heroEl, firstHub);
    requestAnimationFrame(() => requestAnimationFrame(() => { pushHubsDown(); removeSkeleton(); }));
  }
}

function maybeInitCarousel() {
  if (heroDebounce) clearTimeout(heroDebounce);
  heroDebounce = setTimeout(() => {
    heroDebounce = null;
    if (!isHomePage()) return;
    guardCarousel();
    if (!heroInitInProgress && (!heroEl || !heroEl.isConnected)) initCarousel();
  }, HERO_DEBOUNCE_MS);
}

})();
