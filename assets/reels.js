// Visor de videos tipo reels.
//
// Los videos de Behance viven en el reproductor de Adobe (CCV). Su página de embed responde con
// CORS para el origen del sitio y trae la portada y los links directos. Esos links vienen
// firmados y vencen a las 72 h, por eso se resuelven acá, en el navegador, y no se guardan en
// behance.json. Si algo de esto falla, ese video vuelve a mostrarse con el reproductor de Adobe.
//
// Se usa el MP4 (576p) y no el HLS (hasta 1080p) a propósito: el HLS autoriza sus sublistas con
// una cookie del CDN de Adobe, que desde este dominio es de terceros y Safari la bloquea (las
// sublistas dan 403). El MP4 lleva la firma en el propio link y anda en cualquier navegador.

const ADOBE_PLAYER_PREFIX = "https://www-ccv.adobe.io/";
const CDN_URL_RE = /https:\/\/cdn-prod-ccv\.adobe\.com\/[^"'\s<>]+/g;

const sourcesCache = new Map();
const pendingTiles = new WeakMap();
const viewer = { dialog: null, feed: null, muted: true, current: null, observers: [] };

export const isAdobeVideo = (block) => block.type === "video" && block.src.startsWith(ADOBE_PLAYER_PREFIX);

const cloneTemplate = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

/* ---------- Links directos desde el embed de Adobe ---------- */

function pickSources(html, embedUrl) {
  const urls = (html.match(CDN_URL_RE) || []).map((url) => url.replaceAll("&amp;", "&"));
  const find = (pattern) => urls.find((url) => pattern.test(url));
  const poster = find(/_poster\.jpg\?/);
  const src = find(/\.mp4\?/);
  if (!poster || !src) throw new Error(`${embedUrl}: sin portada o video entre ${urls.length} links`);
  return { poster, src };
}

export function resolveVideo(block) {
  if (!sourcesCache.has(block.src)) {
    const request = fetch(block.src)
      .then((response) => {
        if (!response.ok) throw new Error(`${block.src}: HTTP ${response.status}`);
        return response.text();
      })
      .then((html) => pickSources(html, block.src));
    sourcesCache.set(block.src, request);
  }
  return sourcesCache.get(block.src);
}

function adobeEmbed(block) {
  const iframe = document.createElement("iframe");
  Object.assign(iframe, { src: block.src, title: "Video", allow: "autoplay; fullscreen", allowFullscreen: true });
  return iframe;
}

/* ---------- Portadas (grilla) ---------- */

// Las portadas se piden recién cuando la tarjeta está por entrar en pantalla.
const tileObserver = new IntersectionObserver((entries) => {
  for (const entry of entries.filter((item) => item.isIntersecting)) {
    tileObserver.unobserve(entry.target);
    pendingTiles.get(entry.target)?.();
  }
}, { rootMargin: "400px 0px" });

function loadPoster(tile, block, fallback) {
  const img = tile.querySelector("img");
  resolveVideo(block)
    .then(({ poster }) => {
      img.addEventListener("load", () => tile.classList.add("is-ready"), { once: true });
      img.src = poster;
    })
    .catch((error) => {
      console.warn(error);
      tile.replaceWith(fallback());
    });
}

/**
 * Tarjeta con la portada de un video de Adobe que abre el visor al tocarla.
 * Ej.: createVideoTile(block, { label: "Ver video", onOpen: () => openReelViewer(items, 0), fallback })
 */
export function createVideoTile(block, { label, caption = "", onOpen, fallback }) {
  const tile = cloneTemplate("tpl-video-tile");
  tile.style.setProperty("--r", block.ratio);
  tile.setAttribute("aria-label", label);
  tile.querySelector(".tile-caption").textContent = caption;
  tile.addEventListener("click", onOpen);
  pendingTiles.set(tile, () => loadPoster(tile, block, fallback));
  tileObserver.observe(tile);
  return tile;
}

/* ---------- Visor ---------- */

function updateSoundButton() {
  const button = viewer.dialog.querySelector(".viewer-sound");
  button.setAttribute("aria-pressed", String(!viewer.muted));
  button.setAttribute("aria-label", viewer.muted ? "Activar sonido" : "Silenciar");
}

function playCurrent() {
  const video = viewer.current?.querySelector("video");
  if (!video || !video.src) return;
  video.muted = viewer.muted;
  video.play().catch(() => {
    if (video.muted) {
      viewer.current?.classList.add("is-paused");
      return;
    }
    // iOS puede bloquear el autoplay con sonido fuera de un toque: seguimos en silencio.
    viewer.muted = true;
    updateSoundButton();
    video.muted = true;
    video.play().catch(() => viewer.current?.classList.add("is-paused"));
  });
}

function toggleSound() {
  viewer.muted = !viewer.muted;
  updateSoundButton();
  const video = viewer.current?.querySelector("video");
  if (!video) return;
  video.muted = viewer.muted;
  if (video.paused) playCurrent();
}

function activate(slide) {
  if (viewer.current === slide) return;
  viewer.current?.querySelector("video")?.pause();
  viewer.current = slide;
  playCurrent();
}

function loadSlide(slide, item) {
  if (slide.dataset.loaded) return;
  slide.dataset.loaded = "true";
  const video = slide.querySelector("video");
  resolveVideo(item.block)
    .then(({ poster, src }) => {
      video.poster = poster;
      video.src = src;
      if (viewer.current === slide) playCurrent();
    })
    .catch((error) => {
      console.warn(error);
      video.replaceWith(adobeEmbed(item.block));
    });
}

function bindVideo(slide) {
  const video = slide.querySelector("video");
  const bar = slide.querySelector(".viewer-progress span");
  video.addEventListener("click", () => (video.paused ? playCurrent() : video.pause()));
  video.addEventListener("play", () => slide.classList.remove("is-paused"));
  video.addEventListener("pause", () => slide.classList.add("is-paused"));
  video.addEventListener("timeupdate", () => {
    bar.style.transform = `scaleX(${video.duration ? video.currentTime / video.duration : 0})`;
  });
}

function slideElement(item, index, total) {
  const slide = cloneTemplate("tpl-viewer-slide");
  slide.dataset.index = index;
  slide.querySelector(".viewer-frame").style.setProperty("--r", item.block.ratio);
  const title = slide.querySelector(".viewer-title");
  title.textContent = item.title;
  title.href = `#/trabajo/${item.slug}`;
  slide.querySelector(".viewer-count").textContent = `${index + 1} / ${total}`;
  bindVideo(slide);
  return slide;
}

function observeSlides(slides, options, onEnter) {
  const observer = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => onEnter(entry.target));
  }, { root: viewer.feed, ...options });
  slides.forEach((slide) => observer.observe(slide));
  return observer;
}

function step(direction) {
  viewer.feed.scrollBy({ top: direction * viewer.feed.clientHeight, behavior: "smooth" });
}

function teardown() {
  viewer.observers.forEach((observer) => observer.disconnect());
  viewer.observers = [];
  viewer.feed.querySelectorAll("video").forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load(); // corta la descarga en curso
  });
  viewer.feed.replaceChildren();
  viewer.current = null;
  document.documentElement.classList.remove("is-locked");
  if (viewer.dialog.open) viewer.dialog.close();
}

// El visor suma una entrada al historial: así el "atrás" del celular lo cierra en vez de salir.
function requestClose() {
  if (history.state?.reelViewer) history.back();
  else teardown();
}

/**
 * Abre el visor a pantalla completa en el video `startIndex`.
 * Ej.: openReelViewer([{ block, title: "Fotos Show BHAVI", slug: "fotos-show-bhavi" }], 0)
 */
export function openReelViewer(items, startIndex) {
  const slides = items.map((item, index) => slideElement(item, index, items.length));
  viewer.feed.replaceChildren(...slides);
  viewer.observers = [
    observeSlides(slides, { rootMargin: "100% 0px" }, (slide) => loadSlide(slide, items[slide.dataset.index])),
    observeSlides(slides, { threshold: 0.6 }, activate),
  ];
  document.documentElement.classList.add("is-locked");
  viewer.dialog.showModal();
  history.pushState({ reelViewer: true }, "");
  slides[startIndex].scrollIntoView({ block: "start", behavior: "instant" });
  updateSoundButton();
}

function handleViewerKeys(event) {
  const actions = { ArrowDown: () => step(1), ArrowUp: () => step(-1), m: toggleSound, M: toggleSound };
  if (!actions[event.key]) return;
  event.preventDefault();
  actions[event.key]();
}

export function setupReelViewer() {
  viewer.dialog = document.querySelector(".viewer");
  viewer.feed = viewer.dialog.querySelector(".viewer-feed");
  const onClick = (selector, handler) => viewer.dialog.querySelector(selector).addEventListener("click", handler);
  onClick(".viewer-close", requestClose);
  onClick(".viewer-sound", toggleSound);
  onClick(".viewer-prev", () => step(-1));
  onClick(".viewer-next", () => step(1));
  viewer.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestClose();
  });
  viewer.dialog.addEventListener("keydown", handleViewerKeys);
  window.addEventListener("popstate", () => { if (viewer.dialog.open) teardown(); });
  window.addEventListener("hashchange", () => { if (viewer.dialog.open) teardown(); });
}
