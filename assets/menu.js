// Menú lateral. Se arma desde data/categorias.json: sumar o renombrar una categoría es editar
// ese archivo y nada más.

/** Nombre → slug para la URL. Ej.: slugify("Fotografía en Shows") === "fotografia-en-shows" */
export const slugify = (text) => text
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function menuLink(text, route, className) {
  const link = document.createElement("a");
  link.href = `#/${route}`;
  link.dataset.route = route;
  link.textContent = text;
  if (className) link.className = className;
  return link;
}

function groupElement(group) {
  const wrapper = document.createElement("div");
  wrapper.className = "menu-group";
  const list = document.createElement("ul");
  list.className = "menu-sub";
  for (const category of group.categories) {
    const item = document.createElement("li");
    item.append(menuLink(category, `${group.id}/${slugify(category)}`));
    list.append(item);
  }
  wrapper.append(menuLink(group.name, group.id, "menu-main"), list);
  return wrapper;
}

/**
 * Arma el menú: los grupos con su árbol de categorías y después las páginas sueltas.
 * Ej.: renderMenu(nav, categorias.groups, [{ name: "Contacto", route: "contacto" }])
 */
export function renderMenu(nav, groups, pages) {
  const pageLinks = pages.map((page) => menuLink(page.name, page.route, "menu-main"));
  nav.replaceChildren(...groups.map(groupElement), ...pageLinks);
}

/** Marca el link de la ruta actual. Ej.: markActiveRoute("fotografia/foto-fija") */
export function markActiveRoute(route) {
  document.querySelectorAll(".menu a[data-route]").forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

// En el celu el menú es un panel que abre el botón "Menú"; se cierra solo al navegar.
export function setupMenuToggle() {
  const sidebar = document.querySelector(".sidebar");
  const button = sidebar.querySelector(".menu-toggle");
  const setOpen = (open) => {
    sidebar.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Cerrar" : "Menú";
    document.documentElement.classList.toggle("menu-open", open);
  };
  button.addEventListener("click", () => setOpen(!sidebar.classList.contains("is-open")));
  window.addEventListener("hashchange", () => setOpen(false));
}
