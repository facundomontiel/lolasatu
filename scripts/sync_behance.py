#!/usr/bin/env python3
"""Sincroniza un perfil público de Behance a un JSON estático para el sitio.

Behance dejó de entregar API keys, así que el script lee las mismas fuentes
públicas que usa behance.net: el estado embebido en las páginas (perfil y
proyecto) y su endpoint GraphQL para paginar el listado completo. Solo usa la
biblioteca estándar, para correr igual en local y en GitHub Actions.

Uso:
    python3 scripts/sync_behance.py lolasatu data/behance.json
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any, ClassVar

Json = dict[str, Any]

BASE = "https://www.behance.net"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
STATE_RE = re.compile(
    r'<script type="application/json" id="beconfig-store_state"[^>]*>(.*?)</script>',
    re.DOTALL,
)
# Sin JS, Behance responde una página que setea esta cookie y se recarga sola.
CHALLENGE_RE = re.compile(r"js_challenge_value=([a-f0-9]+)")
IFRAME_SRC_RE = re.compile(r'<iframe[^>]+src="([^"]+)"')
# Solo se embeben reproductores conocidos; cualquier otro iframe se descarta.
ALLOWED_EMBED_PREFIXES = (
    "https://www-ccv.adobe.io/",
    "https://www.youtube.com/embed/",
    "https://player.vimeo.com/video/",
)
PROJECTS_QUERY = """
query GetProfileProjects($username: String, $after: String) {
  user(username: $username) {
    profileProjects(first: 24, after: $after) {
      pageInfo { endCursor hasNextPage }
      nodes { id url }
    }
  }
}"""
REQUEST_PAUSE_S = 0.4
COVER_MAX_WIDTH = 808
IMAGE_MAX_WIDTH = 1400

skipped_modules: Counter = Counter()


class BehanceClient:
    """HTTP mínimo que guarda las cookies que Behance exige entre pedidos."""

    def __init__(self) -> None:
        self.cookies: dict[str, str] = {}

    def _request(
        self, url: str, body: bytes | None = None, headers: dict | None = None
    ) -> str:
        all_headers = {"User-Agent": USER_AGENT, **(headers or {})}
        if self.cookies:
            all_headers["Cookie"] = "; ".join(
                f"{k}={v}" for k, v in self.cookies.items()
            )
        request = urllib.request.Request(url, data=body, headers=all_headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            # La página del desafío llega con 403: hay que leerla igual para sacar la cookie.
            page = error.read().decode("utf-8", errors="replace")
            if error.code == 403 and CHALLENGE_RE.search(page):
                return page
            raise

    def page_state(self, url: str) -> Json:
        page = self._request(url)
        challenge = CHALLENGE_RE.search(page)
        if challenge and not STATE_RE.search(page):
            self.cookies["js_challenge_value"] = challenge.group(1)
            page = self._request(url)
        match = STATE_RE.search(page)
        if not match:
            raise RuntimeError(
                f"{url}: falta beconfig-store_state; ¿cambió el HTML de Behance?"
            )
        return json.loads(match.group(1))

    def graphql(self, query: str, variables: Json) -> Json:
        # El endpoint valida que el header X-BCP coincida con la cookie bcp (anti-CSRF).
        token = self.cookies.setdefault("bcp", str(uuid.uuid4()))
        body = json.dumps({"query": query, "variables": variables}).encode()
        headers = {
            "Content-Type": "application/json",
            "X-BCP": token,
            "X-Requested-With": "XMLHttpRequest",
        }
        payload = json.loads(self._request(f"{BASE}/v3/graphql", body, headers))
        if payload.get("errors") or not (payload.get("data") or {}).get("user"):
            raise RuntimeError(
                f"GraphQL {variables}: respuesta inesperada {str(payload)[:300]}"
            )
        return payload["data"]


class TextCleaner(HTMLParser):
    """Rearma el texto de Behance con un allowlist: sin estilos inline ni scripts."""

    SPAN_CLASSES: ClassVar[dict[str, str]] = {
        "bold": "strong",
        "italic": "em",
        "underline": "u",
    }
    SIMPLE_TAGS: ClassVar[dict[str, str]] = {
        "b": "strong",
        "strong": "strong",
        "i": "em",
        "em": "em",
        "u": "u",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.span_stack: list[str | None] = []
        self.link_open = False
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attributes = dict(attrs)
        if tag in ("script", "style"):
            self.skip_depth += 1
        elif tag == "br":
            self.out.append("<br>")
        elif tag in self.SIMPLE_TAGS:
            self.out.append(f"<{self.SIMPLE_TAGS[tag]}>")
        elif tag == "span":
            classes = (attributes.get("class") or "").split()
            mapped = next(
                (self.SPAN_CLASSES[c] for c in classes if c in self.SPAN_CLASSES), None
            )
            self.span_stack.append(mapped)
            if mapped:
                self.out.append(f"<{mapped}>")
        elif tag == "a":
            self._open_link(attributes.get("href") or "")

    def _open_link(self, href: str) -> None:
        if not href.startswith(("http://", "https://", "mailto:")):
            return
        safe_href = html.escape(href, quote=True)
        self.out.append(f'<a href="{safe_href}" target="_blank" rel="noopener">')
        self.link_open = True

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self.skip_depth = max(0, self.skip_depth - 1)
        elif tag in ("div", "p", "li"):
            self.out.append("<br>")
        elif tag in self.SIMPLE_TAGS:
            self.out.append(f"</{self.SIMPLE_TAGS[tag]}>")
        elif tag == "span" and self.span_stack:
            mapped = self.span_stack.pop()
            if mapped:
                self.out.append(f"</{mapped}>")
        elif tag == "a" and self.link_open:
            self.out.append("</a>")
            self.link_open = False

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.out.append(html.escape(data))

    def result(self) -> str:
        joined = re.sub(r"(\s*<br>\s*){3,}", "<br><br>", "".join(self.out))
        return re.sub(r"^(\s*<br>)+|(<br>\s*)+$", "", joined).strip()


def clean_text_html(raw: str) -> str:
    cleaner = TextCleaner()
    cleaner.feed(raw)
    cleaner.close()
    return cleaner.result()


def pick_sizes(available: list, max_width: int) -> Json | None:
    """Elige la variante principal (<= max_width) y arma el srcset sin duplicados."""
    by_width: dict[int, str] = {}
    for size in sorted(available, key=lambda s: "_still/" in s["url"], reverse=True):
        if size.get("width") and size.get("type") != "WEBP":
            by_width[size["width"]] = size["url"]
    if not by_width:
        return None
    widths = sorted(by_width)
    main_width = max((w for w in widths if w <= max_width), default=widths[0])
    srcset = ", ".join(f"{by_width[w]} {w}w" for w in widths if w >= 300)
    return {"src": by_width[main_width], "srcset": srcset, "width": main_width}


def image_item(component: Json) -> Json | None:
    sizes = (component.get("imageSizes") or {}).get("allAvailable") or []
    chosen = pick_sizes(sizes, IMAGE_MAX_WIDTH)
    if not chosen:
        return None
    ratio_source = next((s for s in sizes if s.get("width") and s.get("height")), None)
    ratio = ratio_source["width"] / ratio_source["height"] if ratio_source else 1.5
    return {**chosen, "ratio": round(ratio, 4)}


def find_embed_src(module: Json) -> str | None:
    for value in module.values():
        match = IFRAME_SRC_RE.search(value) if isinstance(value, str) else None
        src = html.unescape(match.group(1)) if match else ""
        if src.startswith(ALLOWED_EMBED_PREFIXES):
            return src
    return None


def video_block(module: Json) -> Json | None:
    src = find_embed_src(module)
    if not src:
        skipped_modules[f"{module.get('__typename')} sin reproductor conocido"] += 1
        return None
    width, height = module.get("width") or 16, module.get("height") or 9
    return {"type": "video", "src": src, "ratio": round(width / height, 4)}


def normalize_module(module: Json) -> Json | None:
    kind = module.get("__typename")
    if kind == "TextModule":
        text = clean_text_html(module.get("text") or "")
        return {"type": "text", "html": text} if text else None
    if kind in ("VideoModule", "EmbedModule"):
        return video_block(module)
    if kind in ("ImageModule", "MediaCollectionModule"):
        components = module.get("components") or [module]
        items = [item for item in map(image_item, components) if item]
        return {"type": "images", "items": items} if items else None
    skipped_modules[str(kind)] += 1
    return None


def project_kinds(blocks: list) -> list:
    kinds = {
        "video" if b["type"] == "video" else "foto"
        for b in blocks
        if b["type"] != "text"
    }
    return sorted(kinds)


def normalize_project(raw: Json) -> Json:
    blocks = [
        block for block in map(normalize_module, raw.get("modules") or []) if block
    ]
    published = datetime.fromtimestamp(raw["publishedOn"], UTC)
    return {
        "id": raw["id"],
        "slug": raw["slug"].lower(),
        "title": raw["name"].strip(),
        "description": (raw.get("description") or "").strip(),
        "year": published.year,
        "tags": [tag["title"] for tag in raw.get("tags") or []],
        "kinds": project_kinds(blocks),
        "cover": pick_sizes(raw["covers"]["allAvailable"], COVER_MAX_WIDTH),
        "behanceUrl": raw["url"],
        "blocks": blocks,
    }


def fetch_profile(client: BehanceClient, username: str) -> Json:
    user = client.page_state(f"{BASE}/{username}")["profile"]["user"]
    avatar = max(user["images"]["allAvailable"], key=lambda image: image["width"])[
        "url"
    ]
    socials = user.get("socialReferences") or []
    instagram = next(
        (s["url"] for s in socials if s.get("socialService") == "Instagram"), ""
    )
    return {
        "name": user["displayName"],
        "username": username,
        "occupation": user.get("occupation") or "",
        "location": user.get("location") or "",
        "avatar": avatar,
        "banner": user.get("bannerImageUrl") or "",
        "instagram": instagram.replace("http://", "https://"),
        "behance": user["url"],
        "tools": [tool["title"] for tool in user.get("adobePro") or []],
    }


def list_project_urls(client: BehanceClient, username: str) -> list:
    """Respeta el orden que la artista eligió en su perfil, no el cronológico."""
    urls: list = []
    after = None
    while True:
        page = client.graphql(PROJECTS_QUERY, {"username": username, "after": after})
        listing = page["user"]["profileProjects"]
        urls += [node["url"] for node in listing["nodes"]]
        if not listing["pageInfo"]["hasNextPage"]:
            return urls
        after = listing["pageInfo"]["endCursor"]
        time.sleep(REQUEST_PAUSE_S)


def ensure_unique_slugs(projects: list) -> None:
    seen: set = set()
    for project in projects:
        if project["slug"] in seen:
            project["slug"] = f"{project['slug']}-{project['id']}"
        seen.add(project["slug"])


def write_json_atomically(path: str, content: Json) -> None:
    """Si algo falla a mitad de camino, el JSON publicado anterior queda intacto."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, delete=False
    ) as tmp:
        json.dump(content, tmp, ensure_ascii=False, indent=1)
    # NamedTemporaryFile crea con 0600; un servidor estático local no podría leerlo.
    os.chmod(tmp.name, 0o644)
    os.replace(tmp.name, path)


def main(argv: list) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    username, out_path = argv[1], argv[2]
    client = BehanceClient()
    profile = fetch_profile(client, username)
    projects = []
    for url in list_project_urls(client, username):
        time.sleep(REQUEST_PAUSE_S)
        projects.append(normalize_project(client.page_state(url)["project"]["project"]))
    ensure_unique_slugs(projects)
    # Sin timestamp a propósito: el JSON solo cambia si cambió Behance, así el
    # workflow commitea únicamente cuando Lola sube, edita o borra algo.
    write_json_atomically(out_path, {"profile": profile, "projects": projects})
    print(f"{len(projects)} proyectos sincronizados en {out_path}")
    for reason, count in skipped_modules.items():
        print(f"aviso: {count} módulo(s) ignorados: {reason}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
