"use strict";

import { createVideoTile, isAdobeVideo, openReelViewer, setupReelViewer } from "./reels.js";

// behance.json lo genera scripts/sync_behance.py; sitio.json son los textos que se editan a mano.
const EMBED_PREFIXES = [
  "https://www-ccv.adobe.io/",
  "https://www.youtube.com/embed/",
  "https://player.vimeo.com/video/",
];
const KIND_LABELS = { foto: "Foto", video: "Video" };
const COVER_SIZES = "(min-width: 1100px) 31vw, (min-width: 640px) 47vw, 100vw";
const GALLERY_SIZES = "(min-width: 640px) 45vw, 90vw";
const SITE_BG = "%230e0d0c";

const state = { behance: null, site: null, filter: "todo", homeScroll: 0, currentRoute: null };
const lightbox = { photos: [], index: 0, observer: null, pending: new WeakMap() };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const kindsLabel = (kinds) => kinds.map((kind) => KIND_LABELS[kind]).join(" + ") || "—";
const isReel = (block) => block.type === "video" && block.ratio < 1;

function cloneTemplate(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function setText(root, field, value) {
  $$(`[data-field="${field}"]`, root).forEach((element) => { element.textContent = value; });
}

function setLink(root, field, href) {
  $$(`a[data-field="${field}"]`, root).forEach((element) => { element.href = href; });
}

function setImage(img, image, sizes) {
  if (image.srcset) {
    img.srcset = image.srcset;
    img.sizes = sizes;
  }
  img.src = image.src;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/* ---------- Home ---------- */

function cardElement(project) {
  const view = cloneTemplate("tpl-card");
  $(".card", view).dataset.kinds = project.kinds.join(" ");
  $(".card-link", view).href = `#/trabajo/${project.slug}`;
  setImage($("img", view), project.cover, COVER_SIZES);
  $(".card-title", view).textContent = project.title;
  $(".card-meta", view).textContent = `${kindsLabel(project.kinds)} · ${project.year}`;
  $(".card-badge", view).hidden = !project.kinds.includes("video");
  return view;
}

function applyFilter(grid, kind) {
  state.filter = kind;
  $$("[data-filter]", grid.parentNode).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === kind));
  });
  $$(".card", grid).forEach((card) => {
    card.hidden = kind !== "todo" && !card.dataset.kinds.split(" ").includes(kind);
  });
}

function setupFilters(view) {
  const grid = $(".grid", view);
  $$("[data-filter]", view).forEach((button) => {
    button.addEventListener("click", () => applyFilter(grid, button.dataset.filter));
  });
  applyFilter(grid, state.filter);
}

function renderHome() {
  const view = cloneTemplate("tpl-home");
  const { profile, projects } = state.behance;
  setText(view, "occupation", profile.occupation);
  setText(view, "location", profile.location);
  setText(view, "headline", state.site.headline);
  $(".grid", view).append(...projects.map(cardElement));
  setupFilters(view);
  document.title = `${profile.name} — ${profile.occupation}`;
  return view;
}

/* ---------- Proyecto ---------- */

// Los reels verticales consecutivos van lado a lado en vez de uno abajo del otro.
function groupBlocks(blocks) {
  const groups = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (isReel(block) && last && last.type === "reels") last.items.push(block);
    else groups.push(isReel(block) ? { type: "reels", items: [block] } : block);
  }
  return groups;
}

function proseElement(html) {
  const prose = createElement("div", "prose");
  // Seguro solo porque sync_behance.py ya lo rearmó con un allowlist de etiquetas.
  prose.innerHTML = html;
  return prose;
}

function galleryElement(items, photos, title) {
  const gallery = createElement("div", "gallery");
  for (const item of items) {
    const index = photos.push(item) - 1;
    const button = createElement("button", "gallery-item");
    button.type = "button";
    button.style.setProperty("--r", item.ratio);
    button.setAttribute("aria-label", `Ampliar foto ${index + 1} — ${title}`);
    const img = createElement("img");
    Object.assign(img, { loading: "lazy", decoding: "async", alt: "" });
    setImage(img, item, GALLERY_SIZES);
    button.append(img);
    button.addEventListener("click", () => openLightbox(photos, index));
    gallery.append(button);
  }
  return gallery;
}

function videoElement(block, title) {
  if (!EMBED_PREFIXES.some((prefix) => block.src.startsWith(prefix))) {
    return document.createDocumentFragment();
  }
  const wrapper = createElement("div", "video");
  wrapper.style.aspectRatio = String(block.ratio);
  const iframe = createElement("iframe");
  Object.assign(iframe, {
    src: block.src.replace(/bgcolor=[^&]*/, `bgcolor=${SITE_BG}`),
    title: `Video — ${title}`,
    loading: "lazy",
    allow: "autoplay; fullscreen; picture-in-picture",
    allowFullscreen: true,
  });
  wrapper.append(iframe);
  return wrapper;
}

// Hasta 4 reels van en una sola fila; más que eso, filas de 4 solo si cierran justo, si no de 3.
function reelColumns(count) {
  if (count <= 4) return count;
  return count % 4 === 0 ? 4 : 3;
}

// Los videos de Adobe se muestran como portada y se ven en el visor; YouTube queda embebido.
function videoBlockElement(block, ctx) {
  if (!isAdobeVideo(block)) return videoElement(block, ctx.title);
  const index = ctx.videos.findIndex((item) => item.block === block);
  const tile = createVideoTile(block, {
    label: `Ver video ${index + 1} — ${ctx.title}`,
    onOpen: () => openReelViewer(ctx.videos, index),
    fallback: () => videoElement(block, ctx.title),
  });
  if (block.ratio >= 1) tile.classList.add("video-tile--wide");
  return tile;
}

function reelsElement(items, ctx) {
  const reels = createElement("div", "reels");
  reels.style.setProperty("--cols", reelColumns(items.length));
  reels.append(...items.map((item) => videoBlockElement(item, ctx)));
  return reels;
}

function blockElement(block, ctx) {
  if (block.type === "text") return proseElement(block.html);
  if (block.type === "images") return galleryElement(block.items, ctx.photos, ctx.title);
  if (block.type === "video") return videoBlockElement(block, ctx);
  return reelsElement(block.items, ctx);
}

const videoItems = (project, blocks) => blocks.map((block) => ({ block, title: project.title, slug: project.slug }));

function nextProjects(index, count) {
  const { projects } = state.behance;
  const total = Math.min(count, projects.length - 1);
  return Array.from({ length: total }, (_, offset) => projects[(index + 1 + offset) % projects.length]);
}

function renderNotFound() {
  const message = createElement("p", "loading", "No encontramos ese trabajo. ");
  const link = createElement("a", "", "Ver todos los trabajos");
  link.href = "#/";
  message.append(link);
  return message;
}

function renderProject(slug) {
  const index = state.behance.projects.findIndex((project) => project.slug === slug);
  if (index < 0) return renderNotFound();
  const project = state.behance.projects[index];
  const view = cloneTemplate("tpl-project");
  $(".project-title", view).textContent = project.title;
  setText(view, "year", project.year);
  setText(view, "kinds", kindsLabel(project.kinds));
  setText(view, "tags", project.tags.slice(0, 5).join(", "));
  $('[data-field="tags-row"]', view).hidden = !project.tags.length;
  $(".project-desc", view).textContent = project.description;
  const ctx = { photos: [], title: project.title, videos: videoItems(project, project.blocks.filter(isAdobeVideo)) };
  const blocks = groupBlocks(project.blocks).map((block) => blockElement(block, ctx));
  $(".project-body", view).append(...blocks);
  $(".grid--more", view).append(...nextProjects(index, 3).map(cardElement));
  document.title = `${project.title} — Lola Satu`;
  return view;
}

/* ---------- Reels ---------- */

function renderReels() {
  const view = cloneTemplate("tpl-reels");
  const reels = state.behance.projects.flatMap((project) =>
    videoItems(project, project.blocks.filter((block) => isAdobeVideo(block) && isReel(block))));
  setText(view, "reels-count", `${reels.length} videos verticales de sus proyectos`);
  const tiles = reels.map((item, index) => createVideoTile(item.block, {
    label: `Ver reel ${index + 1}: ${item.title}`,
    caption: item.title,
    onOpen: () => openReelViewer(reels, index),
    fallback: () => videoElement(item.block, item.title),
  }));
  $(".reel-grid", view).append(...tiles);
  document.title = "Reels — Lola Satu";
  return view;
}

/* ---------- Sobre mí y contacto ---------- */

function fillList(list, items) {
  list.append(...items.map((item) => createElement("li", "", item)));
}

function renderAbout() {
  const view = cloneTemplate("tpl-about");
  const { profile } = state.behance;
  $(".about-photo", view).src = profile.avatar;
  $(".about-bio", view).append(...state.site.about.map((text) => createElement("p", "", text)));
  fillList($('[data-field="services"]', view), state.site.services);
  const tools = profile.tools.filter((tool) => tool !== "Adobe Portfolio");
  fillList($('[data-field="tools"]', view), tools.map((tool) => tool.replace(/^Adobe /, "")));
  document.title = "Sobre mí — Lola Satu";
  return view;
}

function renderContact() {
  const view = cloneTemplate("tpl-contact");
  const { profile } = state.behance;
  const { email } = state.site;
  setLink(view, "instagram", profile.instagram);
  setText(view, "instagram-handle", `@${profile.instagram.split("/").filter(Boolean).pop()}`);
  setLink(view, "behance", profile.behance);
  setText(view, "behance-handle", `/${profile.username}`);
  const emailLink = $('a[data-field="email"]', view);
  if (email) emailLink.href = `mailto:${email}`;
  else emailLink.setAttribute("aria-disabled", "true");
  setText(view, "email-label", email || "a confirmar");
  document.title = "Contacto — Lola Satu";
  return view;
}

/* ---------- Lightbox ---------- */

// Carrusel horizontal con scroll-snap: en el celu la foto sigue al dedo, como en Instagram.
// Cada foto se pide recién cuando está a una pantalla de distancia.
function lightboxSlide(photo) {
  const slide = createElement("div", "lightbox-slide");
  const img = createElement("img");
  Object.assign(img, { alt: "", decoding: "async" });
  slide.append(img);
  lightbox.pending.set(slide, () => setImage(img, photo, "100vw"));
  return slide;
}

function updateLightboxPosition() {
  const track = $(".lightbox-track");
  const last = lightbox.photos.length - 1;
  lightbox.index = Math.min(last, Math.max(0, Math.round(track.scrollLeft / track.clientWidth)));
  $(".lightbox-count").textContent = `${lightbox.index + 1} / ${lightbox.photos.length}`;
  $(".lightbox-prev").hidden = lightbox.index === 0;
  $(".lightbox-next").hidden = lightbox.index === last;
}

function showPhoto(index) {
  const track = $(".lightbox-track");
  const target = Math.min(lightbox.photos.length - 1, Math.max(0, index));
  track.scrollTo({ left: target * track.clientWidth, behavior: "smooth" });
}

function openLightbox(photos, index) {
  lightbox.photos = photos;
  const track = $(".lightbox-track");
  const slides = photos.map(lightboxSlide);
  track.replaceChildren(...slides);
  $(".lightbox").showModal();
  // Primero se salta a la foto tocada y recién después se observa: si no, también carga las del principio.
  track.scrollTo({ left: index * track.clientWidth, behavior: "instant" });
  slides.forEach((slide) => lightbox.observer.observe(slide));
  updateLightboxPosition();
}

function observeLightboxSlides(track) {
  return new IntersectionObserver((entries) => {
    for (const entry of entries.filter((item) => item.isIntersecting)) {
      lightbox.observer.unobserve(entry.target);
      lightbox.pending.get(entry.target)?.();
    }
    // Media pantalla de margen alcanza a las vecinas; con una entera, las que tocan el borde
    // cuentan como visibles y se cargaban dos de cada lado.
  }, { root: track, rootMargin: "0px 50%" });
}

function setupLightbox() {
  const dialog = $(".lightbox");
  const track = $(".lightbox-track");
  lightbox.observer = observeLightboxSlides(track);
  let frame = 0;
  track.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateLightboxPosition);
  }, { passive: true });
  $(".lightbox-close").addEventListener("click", () => dialog.close());
  $(".lightbox-prev").addEventListener("click", () => showPhoto(lightbox.index - 1));
  $(".lightbox-next").addEventListener("click", () => showPhoto(lightbox.index + 1));
  // Tocar fuera de la foto (el fondo) cierra; tocar la foto no.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.classList.contains("lightbox-slide")) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    // Sin esto, si el carrusel tiene el foco, la flecha también lo scrollea nativo y se pisan.
    event.preventDefault();
    showPhoto(lightbox.index + step);
  });
  dialog.addEventListener("close", () => {
    lightbox.observer.disconnect();
    track.replaceChildren();
  });
  window.addEventListener("hashchange", () => { if (dialog.open) dialog.close(); });
}

/* ---------- Router ---------- */

const VIEWS = {
  "": renderHome,
  trabajo: renderProject,
  reels: renderReels,
  "sobre-mi": renderAbout,
  contacto: renderContact,
};
const NAV_FOR_VIEW = { "": "home", trabajo: "home", reels: "reels", "sobre-mi": "sobre-mi", contacto: "contacto" };

function route() {
  if (state.currentRoute === "") state.homeScroll = window.scrollY;
  const [section = "", slug = ""] = location.hash.replace(/^#\/?/, "").split("/");
  const key = section in VIEWS ? section : "";
  const isFirstRender = state.currentRoute === null;
  $("#main").replaceChildren(VIEWS[key](decodeURIComponent(slug)));
  state.currentRoute = key;
  $$(".nav a").forEach((link) => {
    if (link.dataset.route === NAV_FOR_VIEW[key]) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  window.scrollTo({ top: key === "" ? state.homeScroll : 0, behavior: "instant" });
  if (!isFirstRender) $("#main").focus({ preventScroll: true });
}

function fillFooter() {
  const { profile } = state.behance;
  const footer = $(".site-footer");
  setText(footer, "year", new Date().getFullYear());
  setLink(footer, "instagram", profile.instagram);
  setLink(footer, "behance", profile.behance);
}

async function boot() {
  try {
    [state.behance, state.site] = await Promise.all([loadJson("data/behance.json"), loadJson("data/sitio.json")]);
  } catch (error) {
    $("#main").textContent = "No se pudieron cargar los trabajos. Probá recargar la página.";
    console.error(error);
    return;
  }
  fillFooter();
  setupLightbox();
  setupReelViewer();
  window.addEventListener("hashchange", route);
  route();
}

boot();
