// Pruebas del sitio en Chrome headless vía DevTools Protocol, sin dependencias: funcionamiento + diseño.
//
// Uso (con el sitio servido en local: python3 -m http.server 8765):
//   node tests/site-check.mjs                                   # todo, contra http://127.0.0.1:8765/
//   SITE_URL=https://lolasatu.github.io/ node tests/site-check.mjs
//   SUITE=smoke|layout node tests/site-check.mjs                # solo una parte
// Capturas en $SHOTS_DIR (por defecto, una carpeta temporal del sistema).
//
// Las cantidades (proyectos, videos, categorías) salen de los datos y no van escritas a mano:
// Lola agrega, saca y etiqueta proyectos en Behance y la sync diaria los trae.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.SITE_URL || "http://127.0.0.1:8765/";
const SUITE = process.env.SUITE || "all";
const WORK_DIR = mkdtempSync(join(tmpdir(), "lolasatu-tests-"));
const SHOTS = process.env.SHOTS_DIR || join(WORK_DIR, "shots");
// Puerto al azar: un Chrome huérfano de otra corrida no debe atender esta prueba con caché vieja.
const PORT = 9400 + Math.floor(Math.random() * 500);
const VIDEO_PROJECT = "contenido-audiovisual-para-el-club-de-la-mortal";
const FONT = "Jost";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) throw new Error(`puerto ${PORT} ocupado`);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(WORK_DIR, "chrome")}`,
  "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" });

let ws, id = 0;
const pending = new Map();
const errors = [];
const results = [];
let failAdobeFetches = false;
let projectTotal = 0;
let videoRatios = [];

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve) => pending.set(msgId, resolve));
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(`eval falló: ${expression}\n${JSON.stringify(res.result.exceptionDetails).slice(0, 400)}`);
  return res.result.result.value;
}
async function waitFor(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  throw new Error(`timeout esperando: ${expression}`);
}
async function key(keyName, code, keyCode) {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: keyName, code, windowsVirtualKeyCode: keyCode });
}
async function screenshot(name) {
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(result.data, "base64"));
}
async function go(hash) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(150);
}
async function emulate(width, height, mobile) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}
const data = (expr) => evaluate(`fetch('data/behance.json').then(r => r.json()).then(d => ${expr})`);
function check(name, ok, detail = "") { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); }

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome no levantó");
}

function onMessage(event) {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || "excepción");
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Fetch.requestPaused") {
    const { requestId, resourceType } = msg.params;
    // Chrome reporta los fetch() como "XHR"; los iframes de respaldo ("Document") tienen que pasar.
    if (failAdobeFetches && resourceType !== "Document") send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    else send("Fetch.continueRequest", { requestId });
  }
}

const LIGHTBOX = {
  count: "document.querySelector('.lightbox-count').textContent",
  scrollIndex: "(() => { const t = document.querySelector('.lightbox-track'); return t.scrollLeft / t.clientWidth; })()",
  loaded: "[...document.querySelectorAll('.lightbox-slide img')].filter(i => i.getAttribute('src')).length",
};
const VIEWER = {
  open: "document.querySelector('.viewer').open",
  currentIndex: `(() => { const f = document.querySelector('.viewer-feed'); return Math.round(f.scrollTop / f.clientHeight); })()`,
  playing: (i) => `(() => { const v = document.querySelectorAll('.viewer-slide')[${i}]?.querySelector('video'); return !!v && !v.paused && v.currentTime > 0.3; })()`,
  video: (i) => `document.querySelectorAll('.viewer-slide')[${i}].querySelector('video')`,
};

/* ---------- Inicio, menú y favicon ---------- */

async function testCardHover() {
  const overlay = "getComputedStyle(document.querySelector('.card .card-overlay')).opacity";
  check("tarjeta: sin hover no se ve el título", (await evaluate(overlay)) === "0"
    && (await evaluate("Math.round(document.querySelector('.card .card-title').getBoundingClientRect().width)")) <= 1);
  const box = await evaluate("(() => { const r = document.querySelector('.card .card-media').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0], y: box[1] });
  // El recuadro aparece con una transición de .35s: se espera a que termine (una espera fija fallaba a veces).
  await waitFor(`${overlay} === "1"`, 2000).catch(() => {});
  const first = await evaluate("({ title: document.querySelector('.card .card-overlay-title').textContent, overlayText: document.querySelector('.card .card-overlay').textContent })");
  const op = await evaluate(overlay);
  const atMouse = await evaluate(`document.elementFromPoint(${box[0]}, ${box[1]})?.className`);
  check("tarjeta: el hover muestra solo el título (sin año)", op === "1" && first.title.length > 0 && first.overlayText === first.title,
    `opacidad ${op}, mouse en ${box.map(Math.round)} sobre "${atMouse}", texto "${first.overlayText}"`);
  await screenshot("desk-card-hover");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
}

async function testHome() {
  await waitFor("document.querySelectorAll('#main .card').length > 0");
  projectTotal = await data("d.projects.length");
  const total = await evaluate("document.querySelectorAll('#main .card').length");
  check("inicio: todas las tarjetas", total === projectTotal, `${total} de ${projectTotal}`);
  const icons = await evaluate("Promise.all([...document.querySelectorAll('link[rel=icon], link[rel=apple-touch-icon]')].map(l => fetch(l.href).then(r => `${l.getAttribute('href')} ${r.status} ${r.headers.get('content-type')}`)))");
  check("favicon: SVG, PNG 32 y apple-touch accesibles", icons.length === 3 && icons.every((i) => / 200 image\//.test(i)), icons.join(" | "));
  check("inicio: sin cuadritos, filtros ni texto de presentación", (await evaluate("document.querySelectorAll('.card-badge, .card-badges, [data-filter], .intro').length")) === 0
    && (await evaluate("document.querySelector('#main .grid').getBoundingClientRect().top")) < 80);
  check("marca 'LOLA SATU' (mayúsculas por CSS)", (await evaluate("document.querySelector('.brand').textContent")) === "Lola Satu"
    && (await evaluate("getComputedStyle(document.querySelector('.brand')).textTransform")) === "uppercase");
  const main = await evaluate("[...document.querySelectorAll('.menu > a.menu-main, .menu-group > a.menu-main')].map(a => a.textContent).join('|')");
  check("menú: 4 items principales en orden", main === "Fotografía|Video|Sobre mí|Contacto", main);
  const tree = await evaluate("fetch('data/categorias.json').then(r => r.json()).then(c => JSON.stringify(c.groups.map(g => g.categories)) === JSON.stringify([...document.querySelectorAll('.menu-group')].map(g => [...g.querySelectorAll('.menu-sub a')].map(a => a.textContent))))");
  check("menú: árbol de categorías igual al de categorias.json", tree);
  const socials = await evaluate("[...document.querySelectorAll('.sidebar-social a')].map(a => [a.getAttribute('aria-label'), !!a.querySelector('svg'), a.textContent.trim()])");
  check("menú: redes como logos (Instagram, Behance, YouTube, TikTok)", JSON.stringify(socials) === JSON.stringify(
    [["Instagram", true, ""], ["Behance", true, ""], ["YouTube", true, ""], ["TikTok", true, ""]]), JSON.stringify(socials));
  const link = await evaluate("(() => { const r = document.querySelector('.menu-sub a').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: link[0], y: link[1] });
  await sleep(350);
  check("menú: hover en blanco", (await evaluate("getComputedStyle(document.querySelector('.menu-sub a')).color")) === "rgb(241, 237, 230)");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 400 });
  const colors = await evaluate("[getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color, getComputedStyle(document.querySelector('.sidebar')).backgroundColor]");
  check("contenido blanco con letra negra, menú negro", JSON.stringify(colors) === '["rgb(255, 255, 255)","rgb(17, 17, 17)","rgb(14, 13, 12)"]', JSON.stringify(colors));
  await testCardHover();
  await evaluate("window.scrollTo(0, 1500)");
  await sleep(300);
}

async function faviconColor(scheme) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  const rgb = await evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 64, 64); resolve([...ctx.getImageData(6, 30, 1, 1).data]); }; img.src = 'assets/icons/favicon.svg?${scheme}'; })`);
  await send("Emulation.setEmulatedMedia", { features: [] });
  return rgb;
}

async function testFavicon() {
  const light = await faviconColor("light");
  const dark = await faviconColor("dark");
  check("favicon: LS negro en modo claro y blanco en modo oscuro", light.slice(0, 3).every((v) => v < 40) && dark.slice(0, 3).every((v) => v > 215),
    `claro ${JSON.stringify(light)} · oscuro ${JSON.stringify(dark)}`);
}

/* ---------- Fotografía / Video y categorías ---------- */

// Esperado calculado de otra forma que el sitio (localeCompare sin tildes ni mayúsculas),
// para no probar el código contra sí mismo.
async function testAllCategories() {
  const expected = await evaluate(`Promise.all([fetch('data/behance.json').then(r => r.json()), fetch('data/categorias.json').then(r => r.json())]).then(([d, c]) => {
    const same = (a, b) => a.replace(/\\s+/g, '').localeCompare(b.replace(/\\s+/g, ''), 'es', { sensitivity: 'base' }) === 0;
    return c.groups.flatMap(g => g.categories.map(cat => ({ route: g.id + '/' + cat.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), cat,
      titles: d.projects.filter(p => p.tags.some(t => same(t, cat))).map(p => p.title) })));
  })`);
  const summary = [];
  let allOk = expected.length > 0;
  for (const item of expected) {
    await go(`#/${item.route}`);
    const shown = await evaluate("[...document.querySelectorAll('#main .grid .card-title')].map(t => t.textContent)");
    const emptyVisible = !(await evaluate("document.querySelector('.empty').hidden"));
    const ok = JSON.stringify(shown) === JSON.stringify(item.titles) && emptyVisible === (item.titles.length === 0);
    allOk &&= ok;
    summary.push(`${item.cat}: ${shown.length}${ok ? "" : ` (esperaba ${item.titles.length})`}`);
  }
  check(`las ${expected.length} categorías muestran sus proyectos por tag (y 'vacía' solo si no hay)`, allOk, summary.join(" · "));
}

async function testSections() {
  const expected = await data("[d.projects.filter(p => p.kinds.includes('foto')).length, d.projects.filter(p => p.kinds.includes('video')).length]");
  await evaluate("document.querySelector('.menu a[data-route=fotografia]').click()");
  await waitFor("document.querySelector('.page-title')?.textContent === 'Fotografía'");
  check("Fotografía lista los proyectos con fotos", (await evaluate("document.querySelectorAll('#main .grid .card').length")) === expected[0], `${expected[0]}`);
  check("menú marca Fotografía", (await evaluate("document.querySelector('.menu a[aria-current]').dataset.route")) === "fotografia");
  check("al entrar a una sección arranca arriba", (await evaluate("window.scrollY")) === 0);
  await go("#/video");
  check("Video lista los proyectos con video", (await evaluate("document.querySelectorAll('#main .grid .card').length")) === expected[1], `${expected[1]}`);
  await evaluate("document.querySelector('.menu a[data-route=\"fotografia/fotografia-en-shows\"]').click()");
  await waitFor("document.querySelector('.page-title')?.textContent === 'Fotografía en Shows'");
  check("categoría: título y grupo arriba", (await evaluate("document.querySelector('.kicker').textContent")) === "Fotografía");
  check("menú marca la categoría", (await evaluate("document.querySelector('.menu a[aria-current]').dataset.route")) === "fotografia/fotografia-en-shows");
  const ACTIVE = "(() => { const s = getComputedStyle(document.querySelector('.menu a[aria-current]')); return [s.color, s.textDecorationColor]; })()";
  // El color del menú tiene transición de .2s: se mide cuando terminó.
  await sleep(350);
  const settled = await evaluate(ACTIVE);
  check("subrayado de la activa en blanco, no rojo", settled[0] === "rgb(241, 237, 230)" && settled[1] === settled[0], JSON.stringify(settled));
  await go("#/fotografia/no-existe");
  check("categoría inexistente", (await evaluate("document.querySelector('#main').textContent")).includes("No encontramos"));
  await testAllCategories();
  await go("#/");
  await evaluate("window.scrollTo(0, 1500)");
  await sleep(300);
}

/* ---------- Fotos ---------- */

async function testPhotos() {
  await go("#/trabajo/fotos-show-bhavi");
  await waitFor("document.querySelectorAll('.gallery-item').length > 5");
  check("detalle sin año, formato ni tags", (await evaluate("document.querySelectorAll('.project-meta, .project dt, [data-field=tags]').length")) === 0
    && !/Formato|Tags/.test(await evaluate("document.querySelector('.project-head').textContent")));
  const photos = await evaluate("document.querySelectorAll('.gallery-item').length");
  await evaluate("document.querySelectorAll('.gallery-item')[2].click()");
  check("visor de fotos abre", await evaluate("document.querySelector('.lightbox').open"));
  const lb = await evaluate("[getComputedStyle(document.querySelector('.lightbox')).backgroundColor, getComputedStyle(document.querySelector('.lightbox-close')).color]");
  check("visor de fotos: fondo blanco y controles oscuros", lb[0] === "rgb(255, 255, 255)" && lb[1] !== "rgb(255, 255, 255)", JSON.stringify(lb));
  check("arranca en la foto tocada", (await evaluate(LIGHTBOX.count)) === `3 / ${photos}` && Math.abs((await evaluate(LIGHTBOX.scrollIndex)) - 2) < 0.01);
  check("carga solo la actual y las vecinas", (await evaluate(LIGHTBOX.loaded)) <= 3, `${await evaluate(LIGHTBOX.loaded)} cargadas`);
  await key("ArrowRight", "ArrowRight", 39);
  await waitFor(`${LIGHTBOX.count} === '4 / ${photos}'`);
  // El scroll es suave: el contador cambia a mitad de camino, hay que esperar a que asiente.
  await waitFor(`Math.abs(${LIGHTBOX.scrollIndex} - 3) < 0.02`, 3000).catch(() => {});
  check("flecha derecha pasa a la siguiente", Math.abs((await evaluate(LIGHTBOX.scrollIndex)) - 3) < 0.02);
  // Se repite el salto en cada chequeo: si la animación de la flecha anterior todavía corre, pisa
  // un salto único y la prueba fallaba de vez en cuando.
  await waitFor(`(() => { const t = document.querySelector('.lightbox-track'); t.scrollTo({ left: ${photos - 1} * t.clientWidth, behavior: 'instant' }); return ${LIGHTBOX.count} === '${photos} / ${photos}'; })()`);
  check("en la última se oculta 'siguiente' (no da la vuelta)", await evaluate("document.querySelector('.lightbox-next').hidden"));
  await key("Escape", "Escape", 27);
  await sleep(100);
  check("Escape cierra el visor de fotos y lo vacía", !(await evaluate("document.querySelector('.lightbox').open"))
    && (await evaluate("document.querySelectorAll('.lightbox-slide').length")) === 0);
  await evaluate("history.back()");
  await waitFor(`document.querySelectorAll('#main .card').length === ${projectTotal}`);
  await sleep(200);
  check("'atrás' restaura el scroll del inicio", Math.abs((await evaluate("window.scrollY")) - 1500) < 5);
  await go("#/fotografia");
  await evaluate("window.scrollTo(0, 900)");
  await sleep(200);
  await evaluate("document.querySelectorAll('#main .grid .card-link')[4].click()");
  await waitFor("document.querySelector('.project-title') !== null");
  await evaluate("document.querySelector('.back').click()");
  await waitFor("document.querySelector('.page-title')?.textContent === 'Fotografía'");
  await sleep(200);
  check("'← Volver' vuelve a la sección con su scroll", Math.abs((await evaluate("window.scrollY")) - 900) < 5, `${await evaluate("window.scrollY")}`);
}

/* ---------- Videos ---------- */

async function testProjectViewer() {
  await go(`#/trabajo/${VIDEO_PROJECT}`);
  videoRatios = await data(`d.projects.find(p => p.slug === '${VIDEO_PROJECT}').blocks.filter(b => b.type === 'video' && b.src.startsWith('https://www-ccv.adobe.io/')).map(b => b.ratio)`);
  const n = videoRatios.length;
  await waitFor(`document.querySelectorAll('.video-tile').length === ${n}`);
  check("proyecto de video: portadas en vez de reproductores", (await evaluate("document.querySelectorAll('.project-body iframe').length")) === 0);
  await waitFor("document.querySelectorAll('.video-tile.is-ready').length >= 3");
  await evaluate("document.querySelectorAll('.video-tile')[2].click()");
  check(`visor de videos abre con los ${n}`, (await evaluate(VIEWER.open)) && (await evaluate("document.querySelectorAll('.viewer-slide').length")) === n);
  await waitFor(VIEWER.playing(2));
  check("arranca en el video tocado y reproduce", (await evaluate(VIEWER.currentIndex)) === 2);
  check("usa el MP4 directo de Adobe", /^https:\/\/cdn-prod-ccv\.adobe\.com\/.+\.mp4\?/.test(await evaluate(`${VIEWER.video(2)}.src`)));
  check("arranca en silencio", await evaluate(`${VIEWER.video(2)}.muted`));
  check(`contador 3 / ${n}`, (await evaluate("document.querySelectorAll('.viewer-slide')[2].querySelector('.viewer-count').textContent")) === `3 / ${n}`);
  const fd = await evaluate("(() => { const f = document.querySelectorAll('.viewer-slide')[2].querySelector('.viewer-frame').getBoundingClientRect(); return { w: Math.round(f.width), h: Math.round(f.height), vh: innerHeight, bg: getComputedStyle(document.querySelector('.viewer')).backgroundColor }; })()");
  check("visor de videos: fondo blanco y marco del tamaño del video", fd.bg === "rgb(255, 255, 255)" && fd.h === fd.vh && Math.abs(fd.w - Math.round(fd.vh * videoRatios[2])) <= 2, JSON.stringify(fd));
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor(VIEWER.playing(3));
  check("flecha abajo pasa al siguiente y pausa el anterior", (await evaluate(VIEWER.currentIndex)) === 3 && (await evaluate(`${VIEWER.video(2)}.paused`)));
  await evaluate("document.querySelector('.viewer-sound').click()");
  check("botón activa el sonido", (await evaluate("document.querySelector('.viewer-sound').getAttribute('aria-pressed')")) === "true" && !(await evaluate(`${VIEWER.video(3)}.muted`)));
  await evaluate(`${VIEWER.video(3)}.click()`);
  await sleep(200);
  check("tocar el video lo pausa y muestra el ícono", await evaluate("document.querySelectorAll('.viewer-slide')[3].classList.contains('is-paused')"));
  await key("Escape", "Escape", 27);
  await sleep(300);
  check("Escape cierra el visor de videos y limpia", !(await evaluate(VIEWER.open)) && (await evaluate("document.querySelectorAll('.viewer-feed video').length")) === 0
    && !(await evaluate("document.documentElement.classList.contains('is-locked')")) && (await evaluate("location.hash")) === `#/trabajo/${VIDEO_PROJECT}`);
  await evaluate("document.querySelectorAll('.video-tile')[0].click()");
  await sleep(200);
  await evaluate("history.back()");
  await sleep(400);
  check("'atrás' del navegador cierra el visor de videos", !(await evaluate(VIEWER.open)) && (await evaluate("location.hash")) === `#/trabajo/${VIDEO_PROJECT}`);
}

async function testReelsPage() {
  const expected = await data("d.projects.flatMap(p => p.blocks).filter(b => b.type === 'video' && b.src.startsWith('https://www-ccv.adobe.io/') && b.ratio < 1).length");
  await go("#/reels");
  await waitFor("document.querySelectorAll('.reel-grid .video-tile').length > 0");
  const count = await evaluate("document.querySelectorAll('.reel-grid .video-tile').length");
  check("página Reels (fuera del menú) junta todos los verticales", count === expected, `${count} de ${expected}`);
  await evaluate("document.querySelectorAll('.reel-grid .video-tile')[10].click()");
  await waitFor(VIEWER.playing(10));
  check("visor de Reels recorre todos", (await evaluate("document.querySelectorAll('.viewer-slide')[10].querySelector('.viewer-count').textContent")) === `11 / ${expected}`);
  const target = await evaluate("document.querySelectorAll('.viewer-slide')[10].querySelector('.viewer-title').getAttribute('href')");
  await evaluate("document.querySelectorAll('.viewer-slide')[10].querySelector('.viewer-title').click()");
  await sleep(400);
  check("título del video lleva a su proyecto y cierra el visor", (await evaluate("location.hash")) === target && !(await evaluate(VIEWER.open)), target);
}

/* ---------- Sobre mí y contacto ---------- */

async function testAbout() {
  await go("#/sobre-mi");
  const site = await evaluate("fetch('data/sitio.json').then(r => r.json())");
  const avatar = await data("d.profile.avatar");
  const loaded = await waitFor("(() => { const i = document.querySelector('.about-photo'); return i.complete && i.naturalWidth > 0; })()", 10000).catch(() => false);
  check("sobre mí: la foto de perfil de Behance carga", loaded && (await evaluate("document.querySelector('.about-photo').src")) === avatar);
  const bio = await evaluate("[...document.querySelectorAll('.about-bio p')].map(p => p.textContent)");
  check("sobre mí: la bio es la de sitio.json, párrafo por párrafo", JSON.stringify(bio) === JSON.stringify(site.about), `${bio.length} párrafos`);
  check("sobre mí: bio nueva de Lola", bio[0] === "Soy Lola Satulovsky, estudiante de Diseño de Imagen y Sonido en la FADU (Universidad de Buenos Aires).", bio[0]);
  const producer = await evaluate("(() => { const b = document.querySelector('.about-producer'); return [b.hidden, b.querySelector('p').textContent.replace(/\\s+/g, ' ').trim(), [...b.querySelectorAll('a')].map(a => [a.textContent, a.href, a.target])]; })()");
  check("sobre mí: Productora con Calambre (link a su web) y su Instagram", JSON.stringify(producer) === JSON.stringify([false, "Calambre · @calambreprod",
    [["Calambre", "https://calambre.cargo.site/", "_blank"], ["@calambreprod", "https://instagram.com/calambreprod", "_blank"]]]), JSON.stringify(producer));
  const weights = await evaluate("[...document.querySelectorAll('.about-producer a')].map(a => getComputedStyle(a).fontWeight)");
  check("sobre mí: 'Calambre' sin negrita, igual que @calambreprod", weights.length === 2 && weights[0] === weights[1] && Number(weights[0]) < 600, JSON.stringify(weights));
  const order = await evaluate("[...document.querySelectorAll('.about-text .section-label')].map(h => h.textContent).join(' > ')");
  check("sobre mí: Productora > Qué hago > Herramientas", order === "Productora > Qué hago > Herramientas", order);
  check("sobre mí: herramientas y habilidades sin bordes", (await evaluate("document.querySelectorAll('[data-field=tools] li').length")) === 3
    && (await evaluate("getComputedStyle(document.querySelector('.tag-list li')).borderTopWidth")) === "0px");
  // Con la bio larga el botón queda debajo del borde de la pantalla, y el mouse no puede ir ahí.
  await evaluate("document.querySelector('.cta').scrollIntoView({ block: 'center', behavior: 'instant' })");
  const cta = await evaluate("(() => { const r = document.querySelector('.cta').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, innerHeight]; })()");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cta[0], y: cta[1] });
  await sleep(350);
  const ctaStyle = await evaluate("(() => { const s = getComputedStyle(document.querySelector('.cta')); return [s.backgroundColor, s.color]; })()");
  check("sobre mí: hover del botón blanco con letra negra", JSON.stringify(ctaStyle) === '["rgb(255, 255, 255)","rgb(17, 17, 17)"]', `${JSON.stringify(ctaStyle)}, botón en y=${Math.round(cta[1])} de ${cta[2]} de alto`);
  await screenshot("desk-about");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
}

async function testContact() {
  await go("#/contacto");
  check("contacto: sin '¿Hacemos algo juntos?'", !(await evaluate("document.querySelector('#main').textContent")).includes("Hacemos"));
  const rows = await evaluate("[...document.querySelectorAll('.contact-list a')].map(a => [...a.querySelectorAll('span')].map(s => s.textContent).concat(a.getAttribute('href')))");
  check("contacto: Instagram, Behance y Email (YouTube y TikTok solo en el menú)", JSON.stringify(rows) === JSON.stringify([
    ["Instagram", "@lolasatu01", "https://instagram.com/lolasatu01"], ["Behance", "/lolasatu", "https://www.behance.net/lolasatu"],
    ["Email", "lolasatu@gmail.com", "mailto:lolasatu@gmail.com"]]), JSON.stringify(rows));
  const row = await evaluate("(() => { const r = document.querySelector('.contact-list a').getBoundingClientRect(); return [r.x + r.width - 40, r.y + r.height / 2]; })()");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: row[0], y: row[1] });
  await sleep(300);
  const hover = await evaluate("(() => { const s = getComputedStyle(document.querySelector('.contact-list a span:last-child')); return [s.color, s.textDecorationLine]; })()");
  check("contacto: hover negro y subrayado (no rojo)", JSON.stringify(hover) === '["rgb(17, 17, 17)","underline"]', JSON.stringify(hover));
  await screenshot("desk-contact");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
}

const RED = "rgb(255, 65, 48)";
async function testNoRed() {
  const css = await evaluate("fetch('assets/styles.css').then(r => r.text())");
  const reds = [];
  for (const hash of ["#/", "#/fotografia/foto-fija", "#/trabajo/fotos-show-bhavi", "#/sobre-mi", "#/contacto"]) {
    await go(hash);
    await sleep(300);
    const found = await evaluate(`[...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e);
      return [s.color, s.backgroundColor, s.borderTopColor, s.outlineColor, s.textDecorationColor].includes('${RED}'); }).map(e => e.className || e.tagName).slice(0, 3)`);
    if (found.length) reds.push(`${hash}: ${found.join(", ")}`);
  }
  check("sin rojo en ningún lado (ni en el CSS ni en lo que se ve)", !/ff4130|--accent/i.test(css) && reds.length === 0, reds.join(" | "));
}

async function testOtherPages() {
  const yt = await data("d.projects.find(p => p.blocks.some(b => b.type === 'video' && b.src.includes('youtube')))?.slug");
  await go(`#/trabajo/${yt}`);
  await waitFor("document.querySelector('.project-title') !== null");
  check("YouTube sigue embebido", await evaluate("[...document.querySelectorAll('.video iframe')].some(f => f.src.includes('youtube.com/embed'))"), yt);
  await testAbout();
  await testContact();
  await testNoRed();
  await go("#/trabajo/no-existe");
  check("proyecto inexistente", (await evaluate("document.querySelector('#main').textContent")).includes("No encontramos"));
}

async function testAdobeFallback() {
  failAdobeFetches = true;
  // Sin esto los embeds salen del caché HTTP de la sesión y la intercepción nunca los ve.
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*www-ccv.adobe.io*" }] });
  await evaluate("location.hash = '#/'; location.reload()");
  await waitFor("document.querySelectorAll('#main .card').length > 0");
  await go(`#/trabajo/${VIDEO_PROJECT}`);
  await waitFor("document.querySelectorAll('.project-body .video iframe').length >= 1");
  // Las portadas son lazy: hay que bajar para que el resto intente cargar y caiga al respaldo.
  for (let i = 0; i < 10; i++) { await evaluate("window.scrollBy(0, 500)"); await sleep(250); }
  await waitFor(`document.querySelectorAll('.project-body .video iframe').length === ${videoRatios.length}`);
  check("si Adobe falla, vuelve al reproductor de Adobe", (await evaluate("document.querySelectorAll('.video-tile').length")) === 0);
  failAdobeFetches = false;
  await send("Fetch.disable");
  await send("Network.setCacheDisabled", { cacheDisabled: false });
}

/* ---------- Celular ---------- */

async function testTouchTitles() {
  const TOUCHED = `[...document.querySelectorAll('#main .card')].map((c, i) => [i, c.classList.contains('is-touched'), getComputedStyle(c.querySelector('.card-overlay')).opacity]).filter(([, on, op]) => on || op !== '0')`;
  const cardPoint = (i) => evaluate(`(() => { const r = document.querySelectorAll('#main .card')[${i}].querySelector('.card-media').getBoundingClientRect(); return [r.x + r.width / 2, Math.min(r.y + r.height / 2, innerHeight - 40)]; })()`);
  const touch = (type, point) => send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point[0], y: point[1] }] : [] });
  await evaluate("document.querySelectorAll('#main .card')[2].scrollIntoView({ block: 'start', behavior: 'instant' })");
  await sleep(600);
  check("celu: sin el dedo encima no aparece ningún título", JSON.stringify(await evaluate(TOUCHED)) === "[]", JSON.stringify(await evaluate(TOUCHED)));
  check("celu: sin texto debajo de las fotos", (await evaluate("Math.round(document.querySelector('.card .card-title').getBoundingClientRect().width)")) <= 1);
  const p2 = await cardPoint(2);
  const p3 = await cardPoint(3);
  await touch("touchStart", p2);
  await sleep(450);
  check("celu: con el dedo apoyado sobre la foto aparece su título", JSON.stringify(await evaluate(TOUCHED)) === '[[2,true,"1"]]', JSON.stringify(await evaluate(TOUCHED)));
  await screenshot("mob-card-touched");
  // Al deslizar, la página scrollea con el dedo: bajo el dedo sigue la misma foto, y el título con ella.
  const y0 = await evaluate("scrollY");
  for (let k = 1; k <= 5; k++) await touch("touchMove", [p2[0], p2[1] + (p3[1] - p2[1]) * k / 5]);
  await sleep(450);
  const under = await evaluate(`[...document.querySelectorAll('#main .card')].indexOf(document.elementFromPoint(${p2[0]}, ${p3[1]})?.closest('.card'))`);
  const lit = await evaluate(TOUCHED);
  check("celu: deslizando, el título sigue a la foto bajo el dedo", (await evaluate("scrollY")) !== y0 && lit.length === 1 && lit[0][0] === under, `bajo el dedo ${under}, con título ${JSON.stringify(lit)}`);
  await touch("touchEnd");
  await sleep(150);
  check("celu: al levantar el dedo el título no se va de golpe", (await evaluate(TOUCHED)).length === 1);
  await sleep(700);
  check("celu: y después se va", JSON.stringify(await evaluate(TOUCHED)) === "[]", JSON.stringify(await evaluate(TOUCHED)));
  const tapAt = await cardPoint(2);
  const target = await evaluate("document.querySelectorAll('#main .card')[2].querySelector('a').getAttribute('href')");
  await send("Input.synthesizeTapGesture", { x: tapAt[0], y: tapAt[1], gestureSourceType: "touch" });
  await sleep(500);
  check("celu: un toque corto entra al proyecto directo", (await evaluate("location.hash")) === target, `${await evaluate("location.hash")} (esperaba ${target})`);
  await go("#/");
  await evaluate("window.scrollTo(0, 0)");
}

async function testMobileMenu() {
  const TOGGLE = "(() => { const b = document.querySelector('.menu-toggle'); const s = getComputedStyle(b); return [b.textContent, s.textTransform, s.borderTopWidth, Math.round(b.getBoundingClientRect().height)]; })()";
  const closed = await evaluate(TOGGLE);
  check("celu: 'MENÚ' en mayúsculas, sin borde, cómodo de tocar", closed[0] === "Menú" && closed[1] === "uppercase" && closed[2] === "0px" && closed[3] >= 40, JSON.stringify(closed));
  const panel = "getComputedStyle(document.querySelector('.sidebar-panel')).display";
  check("celu: menú cerrado de entrada", (await evaluate(panel)) === "none");
  await evaluate("document.querySelector('.menu-toggle').click()");
  await sleep(200);
  check("celu: 'MENÚ' abre el panel a pantalla completa", (await evaluate(panel)) !== "none"
    && (await evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().height)")) === 844);
  check("celu: 'CERRAR' igual, en mayúsculas y sin borde", (await evaluate(TOGGLE))[0] === "Cerrar");
  await screenshot("mob-menu-open");
  await evaluate("document.querySelector('.menu a[data-route=\"video/cortometrajes\"]').click()");
  await sleep(300);
  check("celu: elegir una categoría navega y cierra el menú", (await evaluate("location.hash")) === "#/video/cortometrajes"
    && (await evaluate(panel)) === "none" && !(await evaluate("document.documentElement.classList.contains('menu-open')")));
}

async function testMobileViewers() {
  await go("#/trabajo/fotos-show-bhavi");
  await waitFor("document.querySelectorAll('.gallery-item').length > 5");
  const total = await evaluate("document.querySelectorAll('.gallery-item').length");
  await evaluate("document.querySelectorAll('.gallery-item')[0].click()");
  await sleep(400);
  await send("Input.synthesizeScrollGesture", { x: 300, y: 420, xDistance: -260, yDistance: 0, gestureSourceType: "touch", speed: 1200 });
  await waitFor(`${LIGHTBOX.count} === '2 / ${total}'`, 5000).catch(() => {});
  await sleep(600);
  check("celu: swipe de costado pasa a la foto siguiente", (await evaluate(LIGHTBOX.count)) === `2 / ${total}`, await evaluate(LIGHTBOX.count));
  check("celu: flechas de fotos ocultas (se desliza)", (await evaluate("getComputedStyle(document.querySelector('.lightbox-next')).display")) === "none");
  await key("Escape", "Escape", 27);
  await go(`#/trabajo/${VIDEO_PROJECT}`);
  await waitFor("document.querySelectorAll('.video-tile.is-ready').length >= 3");
  await evaluate("document.querySelectorAll('.video-tile')[0].click()");
  await waitFor(VIEWER.playing(0));
  const fm = await evaluate("(() => { const f = document.querySelectorAll('.viewer-slide')[0].querySelector('.viewer-frame').getBoundingClientRect(); const c = document.querySelectorAll('.viewer-slide')[0].querySelector('.viewer-caption').getBoundingClientRect(); return { w: Math.round(f.width), h: Math.round(f.height), top: Math.round(f.top), bottom: Math.round(f.bottom), capBottom: Math.round(c.bottom), vw: innerWidth, vh: innerHeight }; })()");
  check("celu: video del ancho de la pantalla, sin recortar y centrado", fm.w === fm.vw && Math.abs(fm.h - Math.round(fm.vw / videoRatios[0])) <= 2 && Math.abs(fm.top - (fm.vh - fm.h) / 2) <= 2, JSON.stringify(fm));
  check("celu: título y progreso sobre el video", fm.capBottom === fm.bottom);
  await key("Escape", "Escape", 27);
}

async function testMobile() {
  await emulate(390, 844, true);
  await evaluate("location.hash = '#/'; location.reload()");
  await waitFor("document.querySelectorAll('#main .card').length > 0");
  await testTouchTitles();
  await testMobileMenu();
  await testMobileViewers();
  await emulate(1440, 900, false);
}

/* ---------- Diseño ---------- */

const LAYOUT = `(() => {
  const vw = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1 && !e.closest('dialog'); })
    .slice(0, 3).map(e => e.className || e.tagName);
  const side = document.querySelector('.sidebar').getBoundingClientRect();
  return {
    fontOk: document.fonts.check('700 16px "${FONT}"'),
    font: getComputedStyle(document.querySelector('.brand')).fontFamily.split(',')[0].replaceAll('"', ''),
    vw, docOverflow: document.documentElement.scrollWidth > vw, over,
    sidebar: [Math.round(side.width), Math.round(side.height), getComputedStyle(document.querySelector('.sidebar')).position],
    mainLeft: Math.round(document.querySelector('main').getBoundingClientRect().left),
  };
})()`;
// Escritorio: barra fija de 280px a la izquierda y el contenido a su derecha.
// Celu/tablet: barra arriba de todo el ancho, baja (<90px), y el contenido debajo.
const layoutOk = (r, width) => width >= 900
  ? r.sidebar[0] === 280 && r.sidebar[2] === "fixed" && r.mainLeft >= 280
  : r.sidebar[0] === r.vw && r.sidebar[1] < 90 && r.mainLeft === 0;

async function testLayout() {
  await go("#/");
  await waitFor("document.querySelectorAll('#main .card').length > 0");
  const longest = await data("d.projects.reduce((a, p) => p.title.length > a.title.length ? p : a).slug");
  for (const width of [390, 360, 320, 768, 1024, 1440]) {
    await emulate(width, width > 500 ? 900 : 800, width < 500);
    for (const hash of ["#/", "#/fotografia", "#/video/contenido-redes-sociales", `#/trabajo/${longest}`, "#/sobre-mi", "#/contacto"]) {
      await go(hash);
      await sleep(250);
      await evaluate("document.fonts.ready");
      const r = await evaluate(LAYOUT);
      const ok = r.fontOk && r.font === FONT && !r.docOverflow && r.over.length === 0 && layoutOk(r, width);
      const { fontOk, font, over, ...detail } = r;
      check(`diseño ${width}px ${hash.slice(0, 26)}`, ok, JSON.stringify(ok ? detail : r));
    }
  }
}

async function main() {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", onMessage);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: BASE });
  if (SUITE !== "layout") {
    await testHome();
    await testFavicon();
    await testSections();
    await testPhotos();
    await testProjectViewer();
    await testReelsPage();
    await testOtherPages();
    check("sin errores de JS en consola", errors.length === 0, errors.join(" | "));
    await testAdobeFallback();
    await testMobile();
  }
  if (SUITE !== "smoke") await testLayout();
}

try { await main(); } catch (error) { results.push(`FAIL  ${error.message}`); }
finally {
  console.log(results.join("\n"));
  console.log(`\nCapturas en ${SHOTS}`);
  chrome.kill();
  process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
}
