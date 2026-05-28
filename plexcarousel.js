// ==UserScript==
// @name         Plex carousel
// @author       g0ryus
// @namespace    https://app.plex.tv
// @version      1.0
// @description  16:9 backdrop cards + Recently Added hero carousel for Plex Web
// @match        https://app.plex.tv/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TARGET_RATIO    = 9 / 16;  // card aspect ratio target
const PORTRAIT_MIN    = 1.15;    // portrait aspect ratio lower bound (h/w)
const PORTRAIT_MAX    = 1.90;    // portrait aspect ratio upper bound (h/w)
const CARD_MAX_WIDTH  = 800;     // px — wider elements are treated as row containers

const HERO_VIEWPORT_RESERVE = 300; // px reserved at the bottom for the first hub row (header + cards)

const HERO_INTERVAL_MS            = 6000;  // ms between carousel auto-advances
const HERO_DEBOUNCE_MS            = 400;   // ms debounce before carousel init attempt
const HERO_SLIDE_LIMIT            = 10;    // max slides shown in carousel
const HERO_INTERSECTION_THRESHOLD = 0.1;  // carousel pauses when less than this fraction is visible
const HERO_AMBIENT_OPACITY        = 0.55; // in-carousel local ambient glow opacity
const AMBIENT_OPACITY             = 0.35; // full-page background blur opacity

const CAROUSEL_CONTENT    = 'shows'; // 'shows' | 'movies' | 'both'

const RECENT_ITEMS_LIMIT  = 50;   // items fetched per library section from the API
const SKELETON_TIMEOUT_MS = 6000; // ms before loading skeleton is force-removed
const SUMMARY_MAX_LENGTH  = 220;  // max characters shown in carousel item summary
// ── END CONFIG ───────────────────────────────────────────────────────────────

GM_addStyle(`
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
  filter: blur(70px) saturate(1.8); opacity: 0.55;
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
.plex-hero-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to right, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.55) 40%, rgba(0,0,0,0.1) 70%, transparent 100%),
              linear-gradient(to top, rgba(0,0,0,0.45) 0%, transparent 35%);
}
.plex-hero-title-block { position: absolute; top: 24px; left: 28px; right: 48%; }
.plex-hero-bottom-block { position: absolute; bottom: 24px; left: 28px; right: 48%; }
.plex-hero-show { font-size: 32px; font-weight: 900; color: #fff; line-height: 1.15; margin-bottom: 0; text-shadow: 0 2px 10px rgba(0,0,0,0.7); }
.plex-hero-ep { font-size: 17px; font-weight: 600; color: rgba(255,255,255,0.92); margin-bottom: 4px; text-shadow: 0 1px 5px rgba(0,0,0,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plex-hero-meta { font-size: 13px; font-weight: 700; color: #E5A00D; letter-spacing: 0.05em; margin-bottom: 10px; text-shadow: 0 1px 4px rgba(0,0,0,0.7); }
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
.plex-hero-dot.active { background: #E5A00D; transform: scale(1.3); }
.plex-hero-progress { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: rgba(255,255,255,0.12); z-index: 10; }
.plex-hero-bar { height: 100%; width: 0%; background: #E5A00D; }
#plex-ambient-global {
  position: fixed; inset: 0;
  background-size: cover; background-position: center 25%;
  filter: blur(120px) saturate(1.5);
  opacity: 0; pointer-events: none; z-index: 0;
  transition: opacity 0.7s ease;
}
html { background: #111 !important; }
body, #plex { background: transparent !important; }
.dark-scrollbar { background: transparent !important; }
[class*="FullPage-container"] { background: transparent !important; }
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
img[data-plex-fallback="1"]  { object-fit: cover !important; object-position: center top !important; }
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

function revertFixes(cardContainers, rowContainer) {
  for (const { el, origH } of cardContainers) {
    delete el.dataset.plexFixed;
    el.style.setProperty('height', `${origH}px`, 'important');
  }
  if (rowContainer) {
    delete rowContainer.el.dataset.plexFixed;
    rowContainer.el.style.setProperty('height', `${rowContainer.origH}px`, 'important');
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

const pendingImages = new Set();

function processImage(img) {
  if (!isHomePage()) return;
  if (img.dataset.plexProcessed || img.dataset.plexFallback) return;
  const src = img.src || img.getAttribute('data-src') || '';
  if (!isPlexTranscodeUrl(src)) return;
  const backdropSrc = buildBackdropUrl(src);
  if (!backdropSrc) return;
  img.dataset.plexProcessed = '1';
  img.dataset.origSrc = src;
  const cardContainers = collectPortraitContainers(img);
  if (cardContainers.length === 0) {
    pendingImages.add(img);
  } else {
    const cardOrigH = cardContainers[0].origH;
    const newCardH  = Math.round(cardContainers[0].origW * TARGET_RATIO);
    const rowContainer = findRowContainer(img, cardOrigH);
    applyFixes(cardContainers, rowContainer, newCardH);
    overlayCardText(img);
    img.addEventListener('error', () => {
      img.dataset.plexFallback = '1';
      delete img.dataset.plexProcessed;
      revertFixes(cardContainers, rowContainer);
      img.src = img.dataset.origSrc;
    }, { once: true });
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
    const cardOrigH = cardContainers[0].origH;
    const newCardH  = Math.round(cardContainers[0].origW * TARGET_RATIO);
    const rowContainer = findRowContainer(img, cardOrigH);
    applyFixes(cardContainers, rowContainer, newCardH);
    overlayCardText(img);
    img.addEventListener('error', () => {
      img.dataset.plexFallback = '1';
      delete img.dataset.plexProcessed;
      revertFixes(cardContainers, rowContainer);
      img.src = img.dataset.origSrc;
    }, { once: true });
  }
}

function scheduleRetry() {
  if (pendingImages.size === 0) return;
  requestAnimationFrame(() => { retryPending(); scheduleRetry(); });
}

function scanTree(root) {
  const imgs = root.tagName === 'IMG' ? [root] : root.querySelectorAll('img');
  let hadPending = false;
  imgs.forEach(img => { processImage(img); if (pendingImages.has(img)) hadPending = true; });
  if (hadPending) scheduleRetry();
  hideHomeBar();
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
  if (hadNew && pendingImages.size > 0) scheduleRetry();
  if (hadNew && heroEl) guardCarousel();
});

let heroTimerId        = null;
let heroSlide          = 0;
let heroDebounce       = null;
let heroEl             = null;
let heroInitInProgress = false;
let skeletonEl         = null;
let skeletonTimer      = null;
let globalAmbientEl    = null;

function hideHomeBar() {
  const bar = document.querySelector('[class*="PageHeader-pageHeader"]');
  if (!bar || bar.dataset.plexHidden) return;
  bar.style.setProperty('display', 'none', 'important');
  bar.dataset.plexHidden = '1';
  new MutationObserver(() => {
    if (bar.style.display !== 'none') bar.style.setProperty('display', 'none', 'important');
  }).observe(bar, { attributes: true, attributeFilter: ['style'] });
}

function init() {
  observer.observe(document.documentElement, OBSERVER_CONFIG);
  injectSkeleton();
  scanTree(document.documentElement);
  window.addEventListener('hashchange', () => {
    if (!isHomePage()) {
      removeSkeleton();
      if (globalAmbientEl) globalAmbientEl.style.opacity = '0';
      if (heroTimerId) { clearInterval(heroTimerId); heroTimerId = null; }
    } else {
      injectSkeleton();
      if (globalAmbientEl) globalAmbientEl.style.opacity = AMBIENT_OPACITY;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function isHomePage() {
  const h = location.hash;
  return !h.includes('/server/') && !h.includes('/media/');
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
    const slide = document.createElement('div');
    slide.className = `plex-hero-slide${i === 0 ? ' active' : ''}`;
    slide.dataset.i = i;
    slide.dataset.itemType = item.type || 'unknown';
    slide.innerHTML = `
      <div class="plex-hero-bg" style="background-image:url('${bg}')"></div>
      <div class="plex-hero-scrim"></div>
      <div class="plex-hero-title-block"><div class="plex-hero-show">${esc(showTitle)}</div></div>
      <div class="plex-hero-bottom-block">
        ${subtitle ? `<div class="plex-hero-ep">${esc(subtitle)}</div>` : ''}
        ${meta     ? `<div class="plex-hero-meta">${esc(meta)}</div>`     : ''}
        ${summary  ? `<div class="plex-hero-summary">${summary}</div>`    : ''}
      </div>`;
    slide.style.cursor = 'pointer';
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
  hero.addEventListener('mouseenter', stopAuto);
  hero.addEventListener('mouseleave', startAuto);

  new IntersectionObserver(entries => {
    entries[0].isIntersecting ? startAuto() : stopAuto();
  }, { threshold: HERO_INTERSECTION_THRESHOLD }).observe(hero);

  startAuto();
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
  document.querySelectorAll('[class*="VirtualHubScroller-hub"]:not([data-plex-hero-shifted])').forEach(hub => {
    const t = parsePx(hub.getAttribute('style') || '', 'top');
    if (t !== null) {
      shiftHub(hub, offset);
    } else {
      // top not set yet — watch for Plex to assign it, then push
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
  if (heroEl && heroEl.isConnected)   { heroInitInProgress = false; return; }
  const firstHub = findFirstHub();
  if (!firstHub)                       { heroInitInProgress = false; return; }
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
