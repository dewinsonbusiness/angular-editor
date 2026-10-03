import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { langFor } from "./lang";
import { LspManager, samePath, type Location } from "./lsp";

interface Entry { name: string; path: string; is_dir: boolean }
interface Hit { path: string; line: number; col: number; text: string }
interface Tab { path: string; state: EditorState; saved: Text; el: HTMLElement }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const appWindow = getCurrentWindow();
const LAST_ROOT_KEY = "editor-angular:last-root";

let root: string | null = null;
let sep = "\\";
let fileIndex: string[] = [];
// Nodos del árbol ya renderizados, por ruta en minúsculas (Windows no distingue mayúsculas).
const fileNodes = new Map<string, HTMLElement>();
const dirNodes = new Map<string, (open: boolean) => Promise<void>>();
const tabs: Tab[] = [];
let active: Tab | null = null;

// ---------- utilidades de rutas ----------

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const absOf = (rel: string) => root + sep + rel.split("/").join(sep);
const inRoot = (p: string) => !!root && p.toLowerCase().startsWith(root.toLowerCase() + sep);
const relOf = (p: string) => (inRoot(p) ? p.slice(root!.length + 1).split(sep).join("/") : p);

function status(msg: string) {
  $("status-msg").textContent = msg;
}

// ---------- editor ----------

const view = new EditorView({ parent: $("editor") });

const findTab = (path: string) => tabs.find((t) => samePath(t.path, path));

const lspServers = new LspManager({
  view,
  activePath: () => active?.path ?? null,
  openPath: (path) => openFile(path),
  tabState: (path) => { const t = findTab(path); return t ? stateOf(t) : null; },
  setTabState: (path, state) => {
    const t = findTab(path);
    if (!t) return;
    if (t === active) view.setState(state); else t.state = state;
    refreshDirty();
  },
  markProblems: (path, errors, warnings) => {
    const cls = errors ? "has-errors" : warnings ? "has-warnings" : "";
    const t = findTab(path);
    if (t) {
      t.el.classList.remove("has-errors", "has-warnings");
      if (cls) t.el.classList.add(cls);
    }
    const node = fileNodes.get(path.toLowerCase());
    node?.classList.remove("has-errors", "has-warnings");
    if (cls) node?.classList.add(cls);
  },
  showLocations: (title, items) => showLocations(title, items),
  status,
});

function makeState(path: string, doc: string): EditorState {
  // Se conserva el final de línea original (CRLF en muchos proyectos de Windows).
  const eol = doc.includes("\r\n") ? "\r\n" : "\n";
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      EditorState.tabSize.of(2),
      EditorState.lineSeparator.of(eol),
      oneDark,
      langFor(path).ext(),
      lspServers.extensionFor(path),
      // Ctrl+clic = ir a definición / abrir ruta; los cursores múltiples van con Alt+clic.
      EditorView.clickAddsSelectionRange.of((e) => e.altKey),
      EditorView.domEventHandlers({
        mousedown: (e, v) => {
          if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          e.preventDefault();
          v.dispatch({ selection: { anchor: pos } });
          goToDefinition(pos);
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) refreshDirty();
        if (u.docChanged || u.selectionSet) updatePos();
      }),
    ],
  });
}

const stateOf = (t: Tab) => (t === active ? view.state : t.state);
const isDirty = (t: Tab) => !stateOf(t).doc.eq(t.saved);

function updatePos() {
  if (!active) return void ($("status-pos").textContent = "");
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  $("status-pos").textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}

function refreshDirty() {
  for (const t of tabs) t.el.classList.toggle("dirty", isDirty(t));
  updateTitle();
}

function updateTitle() {
  const project = root ? baseName(root) : "";
  const file = active ? baseName(active.path) + (isDirty(active) ? " ●" : "") : "";
  appWindow.setTitle([file, project, "Editor Angular"].filter(Boolean).join(" — "));
}

function showWelcome(show: boolean) {
  $("welcome").hidden = !show;
  $("editor").hidden = show;
}

function activate(tab: Tab) {
  if (active && active !== tab) {
    lspServers.syncAll();
    active.state = view.state;
  }
  active = tab;
  view.setState(tab.state);
  lspServers.afterActivate();
  for (const t of tabs) t.el.classList.toggle("active", t === tab);
  tab.el.scrollIntoView({ block: "nearest", inline: "nearest" });
  showWelcome(false);
  $("status-lang").textContent = langFor(tab.path).name;
  revealInTree(tab.path);
  updatePos();
  updateTitle();
  view.focus();
}

async function openFile(path: string, line?: number, col = 0) {
  let tab = findTab(path);
  if (!tab) {
    let text: string;
    try {
      text = await invoke<string>("read_file", { path });
    } catch (e) {
      status(`No se pudo abrir ${baseName(path)}: ${e}`);
      return;
    }
    const state = makeState(path, text);
    const el = document.createElement("div");
    el.className = "tab";
    el.title = path;
    el.innerHTML = `<span class="tab-name"></span><span class="tab-close" title="Cerrar (Ctrl+W)">×</span>`;
    el.querySelector(".tab-name")!.textContent = baseName(path);
    const t: Tab = { path, state, saved: state.doc, el };
    el.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) { ev.preventDefault(); closeTab(t); }
    });
    el.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).classList.contains("tab-close")) closeTab(t);
      else activate(t);
    });
    $("tabs").appendChild(el);
    tabs.push(t);
    tab = t;
  }
  activate(tab);
  if (line) {
    const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
    const pos = Math.min(l.from + col, l.to);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }
}

async function save() {
  if (!active) return;
  const tab = active;
  const doc = view.state.doc;
  try {
    // sliceDoc usa el separador de línea del estado (preserva CRLF).
    await invoke("write_file", { path: tab.path, contents: view.state.sliceDoc() });
    tab.saved = doc;
    refreshDirty();
    status(`Guardado ${baseName(tab.path)}`);
  } catch (e) {
    status(`Error al guardar: ${e}`);
  }
}

async function closeTab(tab: Tab) {
  if (isDirty(tab)) {
    const discard = await ask(`${baseName(tab.path)} tiene cambios sin guardar. ¿Cerrar de todos modos?`, {
      title: "Cambios sin guardar", kind: "warning", okLabel: "Descartar", cancelLabel: "Cancelar",
    });
    if (!discard) return;
  }
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.el.remove();
  lspServers.release(tab.path);
  if (tab !== active) return refreshDirty();
  active = null;
  const next = tabs[i] ?? tabs[i - 1];
  if (next) activate(next);
  else {
    view.setState(EditorState.create());
    showWelcome(true);
    $("status-lang").textContent = "";
    markTreeActive(null);
    updatePos();
    updateTitle();
  }
}

// ---------- árbol de archivos ----------

async function renderDir(container: HTMLElement, path: string, depth: number) {
  let entries: Entry[];
  try {
    entries = await invoke<Entry[]>("list_dir", { path });
  } catch (e) {
    status(`No se pudo leer ${path}: ${e}`);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "node " + (e.is_dir ? "dir" : "file");
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.dataset.path = e.path;
    row.textContent = e.name;
    row.setAttribute("role", "treeitem");
    frag.appendChild(row);

    if (e.is_dir) {
      const children = document.createElement("div");
      children.hidden = true;
      frag.appendChild(children);
      let loading: Promise<void> | null = null;
      const setOpen = async (open: boolean) => {
        children.hidden = !open;
        row.classList.toggle("open", open);
        if (open) await (loading ??= renderDir(children, e.path, depth + 1));
      };
      dirNodes.set(e.path.toLowerCase(), setOpen);
      row.addEventListener("click", () => setOpen(!row.classList.contains("open")));
    } else {
      fileNodes.set(e.path.toLowerCase(), row);
      row.addEventListener("click", () => openFile(e.path));
    }
  }
  container.replaceChildren(frag);
}

function markTreeActive(path: string | null) {
  document.querySelector("#tree .node.active")?.classList.remove("active");
  const node = path ? fileNodes.get(path.toLowerCase()) : null;
  node?.classList.add("active");
  return node;
}

/** Como en VS Code: expande las carpetas hasta el archivo, lo marca y lo hace visible. */
async function revealInTree(path: string) {
  if (inRoot(path)) {
    const parts = path.slice(root!.length + 1).split(sep);
    let dir = root!;
    for (const part of parts.slice(0, -1)) {
      dir += sep + part;
      const setOpen = dirNodes.get(dir.toLowerCase());
      if (!setOpen) break;
      await setOpen(true);
    }
  }
  if (active?.path !== path) return; // el usuario ya cambió de pestaña
  markTreeActive(path)?.scrollIntoView({ block: "nearest" });
}

// ---------- Ctrl+clic / F12 ----------

/** Si `pos` está dentro de una cadena con una ruta relativa ('./x.html', '../a.service'), la devuelve. */
function pathStringAt(pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  const re = /(['"`])(\.{1,2}\/[^'"`\s]*)\1/g;
  for (let m; (m = re.exec(line.text)); ) {
    if (col > m.index && col < m.index + m[0].length) return m[2];
  }
  return null;
}

async function resolveRelative(spec: string): Promise<string | null> {
  if (!active || !root) return null;
  const parts = relOf(active.path).split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const base = parts.join("/");
  if (!fileIndex.length) await refreshIndex();
  const known = new Set(fileIndex.map((f) => f.toLowerCase()));
  const hit = [base, `${base}.ts`, `${base}/index.ts`, `${base}.js`].find((c) => known.has(c.toLowerCase()));
  return hit ? absOf(fileIndex.find((f) => f.toLowerCase() === hit.toLowerCase())!) : null;
}

async function goToDefinition(pos = view.state.selection.main.head) {
  const spec = pathStringAt(pos);
  if (spec) {
    const target = await resolveRelative(spec);
    if (target) return openFile(target);
  }
  if (!(await lspServers.goToDefinition(view, pos))) {
    status(spec ? `No se encontró el archivo ${spec}` : "No se encontró la definición");
  }
}

async function refreshIndex() {
  if (!root) return;
  fileIndex = await invoke<string[]>("list_files", { root });
}

async function closeAllTabs(): Promise<boolean> {
  const dirty = tabs.filter(isDirty);
  if (dirty.length) {
    const discard = await ask(
      `Hay ${dirty.length} archivo(s) sin guardar. ¿Descartar los cambios y abrir otro proyecto?`,
      { title: "Cambios sin guardar", kind: "warning", okLabel: "Descartar", cancelLabel: "Cancelar" },
    );
    if (!discard) return false;
  }
  for (const t of tabs) t.el.remove();
  tabs.length = 0;
  active = null;
  view.setState(EditorState.create());
  showWelcome(true);
  return true;
}

async function openFolder(path: string) {
  if (!(await closeAllTabs())) return;
  root = path.replace(/[\\/]+$/, "");
  sep = root.includes("\\") ? "\\" : "/";
  try { localStorage.setItem(LAST_ROOT_KEY, root); } catch {}
  $("project-name").textContent = baseName(root);
  $("project-name").title = root;
  fileIndex = [];
  status("Iniciando servidores de lenguaje…");
  lspServers.start(root);
  fileNodes.clear();
  dirNodes.clear();
  await renderDir($("tree"), root, 0);
  updateTitle();
  refreshIndex().then(() => status(`${fileIndex.length} archivos indexados`));
}

async function pickFolder() {
  const dir = await open({ directory: true, title: "Abrir proyecto Angular" });
  if (typeof dir === "string") await openFolder(dir);
}

// ---------- listas con teclado (paleta y búsqueda) ----------

interface Item { label: string; detail?: string; pick: () => void }

class Picker {
  private items: Item[] = [];
  private sel = 0;

  constructor(private overlay: HTMLElement, readonly input: HTMLInputElement, private list: HTMLElement) {
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); this.close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); this.choose(this.sel); }
    });
  }

  get isOpen() { return !this.overlay.hidden; }

  show() {
    this.overlay.hidden = false;
    this.input.select();
    this.input.focus();
  }

  close() {
    this.overlay.hidden = true;
    if (active) view.focus();
  }

  setItems(items: Item[]) {
    this.items = items;
    this.sel = 0;
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = it.label;
      li.appendChild(label);
      if (it.detail) {
        const d = document.createElement("span");
        d.className = "detail";
        d.textContent = it.detail;
        li.appendChild(d);
      }
      li.addEventListener("mousedown", (e) => { e.preventDefault(); this.choose(i); });
      frag.appendChild(li);
    });
    this.list.replaceChildren(frag);
    this.highlight();
  }

  private move(d: number) {
    if (!this.items.length) return;
    this.sel = (this.sel + d + this.items.length) % this.items.length;
    this.highlight();
  }

  private highlight() {
    [...this.list.children].forEach((li, i) => li.classList.toggle("selected", i === this.sel));
    this.list.children[this.sel]?.scrollIntoView({ block: "nearest" });
  }

  private choose(i: number) {
    const it = this.items[i];
    if (!it) return;
    this.close();
    it.pick();
  }
}

// ---------- Ctrl+P: ir a archivo ----------

function fuzzyScore(q: string, s: string): number {
  const sl = s.toLowerCase();
  const base = sl.lastIndexOf("/") + 1;
  let qi = 0, score = 0, last = -2;
  for (let i = 0; i < sl.length && qi < q.length; i++) {
    if (sl[i] !== q[qi]) continue;
    score += 1;
    if (i === last + 1) score += 5;
    if (i >= base) score += 2;
    if (i === 0 || "/.-_".includes(sl[i - 1])) score += 3;
    last = i;
    qi++;
  }
  return qi === q.length ? score - s.length * 0.01 : -1;
}

const palette = new Picker($("palette"), $<HTMLInputElement>("palette-input"), $("palette-list"));

function renderPalette() {
  const q = palette.input.value.toLowerCase().replace(/\s+/g, "");
  const ranked = q
    ? fileIndex
        .map((f) => [f, fuzzyScore(q, f)] as const)
        .filter(([, s]) => s >= 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 60)
        .map(([f]) => f)
    : fileIndex.slice(0, 60);
  palette.setItems(ranked.map((f) => ({
    label: baseName(f),
    detail: f,
    pick: () => openFile(absOf(f)),
  })));
}

palette.input.addEventListener("input", renderPalette);

function showPalette() {
  if (!root) return void pickFolder();
  palette.input.value = "";
  renderPalette();
  palette.show();
  // El índice se refresca en cada apertura para ver archivos creados por `ng generate`.
  refreshIndex().then(() => { if (palette.isOpen) renderPalette(); });
}

// ---------- Ctrl+Shift+F: buscar en el proyecto ----------

const searchPicker = new Picker($("search"), $<HTMLInputElement>("search-input"), $("search-list"));
const searchCase = $<HTMLInputElement>("search-case");
let searchTimer = 0;
let searchSeq = 0;

async function runSearch() {
  const query = searchPicker.input.value;
  const seq = ++searchSeq;
  if (!root || !query) {
    $("search-summary").textContent = "";
    return searchPicker.setItems([]);
  }
  $("search-summary").textContent = "Buscando…";
  const hits = await invoke<Hit[]>("search", { root, query, caseSensitive: searchCase.checked });
  if (seq !== searchSeq) return; // llegó una búsqueda más reciente
  const files = new Set(hits.map((h) => h.path)).size;
  $("search-summary").textContent = hits.length >= 2000
    ? `Más de 2000 resultados en ${files} archivos (mostrando los primeros)`
    : `${hits.length} resultados en ${files} archivos`;
  searchPicker.setItems(hits.map((h) => ({
    label: h.text,
    detail: `${h.path}:${h.line}`,
    pick: () => openFile(absOf(h.path), h.line, h.col),
  })));
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 200);
}

searchPicker.input.addEventListener("input", scheduleSearch);
searchCase.addEventListener("change", scheduleSearch);

function showSearch() {
  if (!root) return void pickFolder();
  const sel = view.state.selection.main;
  if (active && !sel.empty && sel.to - sel.from < 200) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (!text.includes("\n")) { searchPicker.input.value = text; runSearch(); }
  }
  searchPicker.show();
}

// Resultados de "buscar referencias" (Shift+F12), en el mismo panel de búsqueda.
function showLocations(title: string, items: Location[]) {
  searchPicker.input.value = "";
  $("search-summary").textContent = title;
  searchPicker.setItems(items.map((h) => ({
    label: h.text,
    detail: `${relOf(h.path)}:${h.line}`,
    pick: () => openFile(h.path, h.line, h.col),
  })));
  searchPicker.show();
}

// ---------- Alt+O: alternar archivos del componente ----------

const COMPANION_EXTS = [".ts", ".html", ".scss", ".css", ".sass", ".less"];

async function cycleCompanion() {
  if (!active || !root) return;
  const rel = relOf(active.path);
  const dot = rel.lastIndexOf(".");
  const stem = rel.slice(0, dot);
  const cur = rel.slice(dot);
  if (!fileIndex.length) await refreshIndex();
  const known = new Set(fileIndex);
  const siblings = COMPANION_EXTS.filter((e) => e === cur || known.has(stem + e));
  if (siblings.length < 2) return status("Sin archivos hermanos .ts/.html/.scss");
  const next = siblings[(siblings.indexOf(cur) + 1) % siblings.length];
  openFile(absOf(stem + next));
}

// ---------- atajos globales ----------

window.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let handled = true;
  if (ctrl && !e.shiftKey && k === "s") save();
  else if (ctrl && !e.shiftKey && k === "p") showPalette();
  else if (ctrl && e.shiftKey && k === "f") showSearch();
  else if (ctrl && !e.shiftKey && k === "o") pickFolder();
  else if (ctrl && !e.shiftKey && k === "w") { if (active) closeTab(active); }
  else if (ctrl && k === "tab" && tabs.length > 1 && active) {
    const i = tabs.indexOf(active);
    activate(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
  }
  else if (e.altKey && !ctrl && k === "o") cycleCompanion();
  else if (k === "f12" && !e.shiftKey && !ctrl && active) goToDefinition();
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, { capture: true });

$("open-folder").addEventListener("click", pickFolder);

appWindow.onCloseRequested(async (e) => {
  const dirty = tabs.filter(isDirty);
  if (!dirty.length) return;
  const discard = await ask(
    `Hay ${dirty.length} archivo(s) sin guardar:\n${dirty.map((t) => baseName(t.path)).join("\n")}\n\n¿Salir de todos modos?`,
    { title: "Cambios sin guardar", kind: "warning", okLabel: "Salir", cancelLabel: "Cancelar" },
  );
  if (!discard) e.preventDefault();
});

window.addEventListener("beforeunload", () => lspServers.stop());

// ---------- arranque ----------

showWelcome(true);
let lastRoot: string | null = null;
try { lastRoot = localStorage.getItem(LAST_ROOT_KEY); } catch {}
if (lastRoot) openFolder(lastRoot);
