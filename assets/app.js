"use strict";

import { createVideoTile, isAdobeVideo, openReelViewer, setupReelViewer } from "./reels.js";
import { markActiveRoute, renderMenu, setupMenuToggle, slugify } from "./menu.js";

// behance.json lo genera scripts/sync_behance.py; sitio.json y categorias.json se editan a mano.
const EMBED_PREFIXES = [
  "https://www-ccv.adobe.io/",
  "https://www.youtube.com/embed/",
  "https://player.vimeo.com/video/",
];
const KIND_LABELS = { foto: "Foto", video: "Video" };
const COVER_SIZES = "(min-width: 1100px) 31vw, (min-width: 640px) 47vw, 100vw";
const GALLERY_SIZES = "(min-width: 640px) 45vw, 90vw";
const SITE_BG = "%230e0d0c";

const PAGES = [{ name: "Sobre mí", route: "sobre-mi" }, { name: "Contacto", route: "contacto" }];

const state = { behance: null, site: null, categories: null, scroll: {}, restoreScroll: false, currentRoute: null };
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
  $(".card-link", view).href = `#/trabajo/${project.slug}`;
  setImage($("img", view), project.cover, COVER_SIZES);
  $(".card-title", view).textContent = project.title;
  $(".card-meta", view).textContent = kindsLabel(project.kinds);
  $(".card-overlay-title", view).textContent = project.title;
  return view;
}

function renderHome() {
  const view = cloneTemplate("tpl-home");
  const { profile, projects } = state.behance;
  $(".grid", view).append(...projects.map(cardElement));
  document.title = `${profile.name} — ${profile.occupation}`;
  return view;
}

/* ---------- Fotografía / Video y sus categorías ---------- */

// Un proyecto entra en una categoría si en Behance tiene un tag con su nombre, sin importar
// mayúsculas, tildes ni espacios: "Foto FIja", "fotofija" y "Foto Fija" valen lo mismo.
const tagKey = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "");

function projectsInCategory(category) {
  const key = tagKey(category);
  return state.behance.projects.filter((project) => project.tags.some((tag) => tagKey(tag) === key));
}

function renderSection(group, categorySlug) {
  const category = group.categories.find((name) => slugify(name) === categorySlug);
  if (categorySlug && !category) return renderNotFound();
  const projects = category
    ? projectsInCategory(category)
    : state.behance.projects.filter((project) => project.kinds.includes(group.kind));
  const view = cloneTemplate("tpl-section");
  setText(view, "section-kicker", category ? group.name : "");
  $(".page-title", view).textContent = category || group.name;
  $(".grid", view).append(...projects.map(cardElement));
  $(".empty", view).hidden = projects.length > 0;
  document.title = `${category || group.name} — Lola Satu`;
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
  // "Volver" regresa a la lista de la que vino (con su scroll); si entró directo por link, al inicio.
  if (state.currentRoute !== null) {
    $(".back", view).addEventListener("click", (event) => {
      event.preventDefault();
      history.back();
    });
  }
  $(".project-title", view).textContent = project.title;
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

// Bloque "Productora" de Sobre mí; sale de sitio.json y se oculta si no está cargado.
function fillProducer(view, producer) {
  const block = $('[data-field="producer"]', view);
  if (!producer) {
    block.hidden = true;
    return;
  }
  setText(block, "producer-intro", producer.intro);
  setText(block, "producer-name", producer.name);
  // El nombre es el link a la web; sin web queda como texto (un <a> sin href no es link).
  if (producer.website) $('[data-field="producer-name"]', block).href = producer.website;
  // El Instagram se agrega acá y no fijo en el HTML: si falta, no queda un "·" suelto.
  if (producer.instagram) {
    const link = createElement("a", "", `@${producer.instagram}`);
    Object.assign(link, { href: `https://instagram.com/${producer.instagram}`, target: "_blank", rel: "noopener" });
    $(".producer-links", block).append(" · ", link);
  }
}

function renderAbout() {
  const view = cloneTemplate("tpl-about");
  const { profile } = state.behance;
  $(".about-photo", view).src = profile.avatar;
  $(".about-bio", view).append(...state.site.about.map((text) => createElement("p", "", text)));
  fillProducer(view, state.site.producer);
  fillList($('[data-field="services"]', view), state.site.services);
  const tools = profile.tools.filter((tool) => tool !== "Adobe Portfolio");
  fillList($('[data-field="tools"]', view), tools.map((tool) => tool.replace(/^Adobe /, "")));
  document.title = "Sobre mí — Lola Satu";
  return view;
}

// YouTube y TikTok no vienen del perfil de Behance: se cargan a mano en sitio.json ("socials").
// Si falta alguna, su link no aparece (ni en el menú ni en Contacto).
const EXTRA_SOCIALS = ["youtube", "tiktok"];

// "https://www.tiktok.com/@lolasatu01" → "@lolasatu01"; "https://www.youtube.com/c/LolaSatu" → "/LolaSatu"
function socialHandle(url) {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
  return last.startsWith("@") ? last : `/${last}`;
}

function fillExtraSocials(root, withHandles) {
  const socials = state.site.socials || {};
  for (const key of EXTRA_SOCIALS) {
    const url = socials[key];
    $$(`a[data-field="${key}"]`, root).forEach((link) => {
      if (!url) {
        (link.closest("li") || link).remove();
        return;
      }
      link.href = url;
      if (withHandles) setText(link, `${key}-handle`, socialHandle(url));
    });
  }
}

function renderContact() {
  const view = cloneTemplate("tpl-contact");
  const { profile } = state.behance;
  const { email } = state.site;
  setLink(view, "instagram", profile.instagram);
  setText(view, "instagram-handle", `@${profile.instagram.split("/").filter(Boolean).pop()}`);
  setLink(view, "behance", profile.behance);
  setText(view, "behance-handle", `/${profile.username}`);
  fillExtraSocials(view, true);
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

// Reels no está en el menú, pero la página sigue andando en #/reels.
const VIEWS = {
  "": renderHome,
  trabajo: renderProject,
  reels: renderReels,
  "sobre-mi": renderAbout,
  contacto: renderContact,
};

const currentPath = () => location.hash.replace(/^#\/?/, "");

function viewFor(section) {
  const group = state.categories.groups.find((item) => item.id === section);
  if (group) return (slug) => renderSection(group, slug);
  return VIEWS[section] || renderHome;
}

// Sin hover (celu/tablet), el dedo hace de mouse: mientras está apoyado, quieto o deslizando, el
// proyecto que tiene debajo muestra su título; al levantarlo se va. Un toque corto entra como
// siempre. Probado antes: título automático en la tarjeta del centro (siempre tapaba una foto) y
// dos toques para entrar (incómodo).
const TOUCH_SCREEN = window.matchMedia("(hover: none)");
const TOUCH_HIDE_DELAY_MS = 350;

function setupTouchHover() {
  let current = null;
  let hideTimer = 0;
  const highlight = (card) => {
    if (card === current) return;
    current?.classList.remove("is-touched");
    current = card;
    current?.classList.add("is-touched");
  };
  // passive: no frena el scroll nativo; elementFromPoint sigue a la tarjeta que pasa bajo el dedo.
  const follow = (event) => {
    if (!TOUCH_SCREEN.matches) return;
    clearTimeout(hideTimer);
    const { clientX, clientY } = event.touches[0];
    highlight(document.elementFromPoint(clientX, clientY)?.closest(".card") || null);
  };
  const release = () => { hideTimer = setTimeout(() => highlight(null), TOUCH_HIDE_DELAY_MS); };
  document.addEventListener("touchstart", follow, { passive: true });
  document.addEventListener("touchmove", follow, { passive: true });
  document.addEventListener("touchend", release, { passive: true });
  document.addEventListener("touchcancel", release, { passive: true });
}

function route() {
  const previous = state.currentRoute;
  if (previous !== null) state.scroll[previous] = window.scrollY;
  const path = currentPath();
  const [section = "", slug = ""] = path.split("/");
  $("#main").replaceChildren(viewFor(section)(decodeURIComponent(slug)));
  state.currentRoute = path;
  markActiveRoute(path);
  // Volver con "atrás" deja la lista donde estaba; entrar a una página nueva arranca arriba.
  window.scrollTo({ top: state.restoreScroll ? state.scroll[path] || 0 : 0, behavior: "instant" });
  state.restoreScroll = false;
  if (previous !== null) $("#main").focus({ preventScroll: true });
}

function fillChrome() {
  const { profile } = state.behance;
  renderMenu($(".menu"), state.categories.groups, PAGES);
  setText($(".site-footer"), "year", new Date().getFullYear());
  setLink($(".sidebar"), "instagram", profile.instagram);
  setLink($(".sidebar"), "behance", profile.behance);
  fillExtraSocials($(".sidebar"), false);
}

async function boot() {
  try {
    [state.behance, state.site, state.categories] = await Promise.all(
      ["data/behance.json", "data/sitio.json", "data/categorias.json"].map(loadJson));
  } catch (error) {
    $("#main").textContent = "No se pudieron cargar los trabajos. Probá recargar la página.";
    console.error(error);
    return;
  }
  fillChrome();
  setupMenuToggle();
  setupTouchHover();
  setupLightbox();
  setupReelViewer();
  // popstate llega antes que hashchange: marca que este cambio de ruta es un "atrás/adelante".
  // Se ignora cuando la URL no cambia (el visor de reels también usa el historial).
  window.addEventListener("popstate", () => { if (currentPath() !== state.currentRoute) state.restoreScroll = true; });
  window.addEventListener("hashchange", route);
  route();
}

boot();
