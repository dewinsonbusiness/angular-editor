import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, ask, message } from "@tauri-apps/plugin-dialog";
import { EditorState, Text, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { langFor } from "./lang";
import { LspManager, samePath, type Location } from "./lsp";
import { ServePanel } from "./serve";
import { TerminalPanel } from "./terminal";
import { setupPanel, isPanelOpen, showPanel, hidePanel } from "./panel";
import { IdeBridge } from "./ide";
import {
  settings, loadSettings, onSettingsChange, openSettings, setupSettingsUi, describeAutoSave,
} from "./settings";

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
interface DirNode {
  row: HTMLElement | null; // null = raíz del proyecto
  children: HTMLElement;
  childDepth: number;
  setOpen(open: boolean): Promise<void>;
  reload(): Promise<void>; // relee del disco si ya estaba cargada
}
const fileNodes = new Map<string, HTMLElement>();
const dirNodes = new Map<string, DirNode>();
const expandedDirs = new Set<string>();
const problems = new Map<string, string>(); // ruta → clase has-errors / has-warnings
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
    if (cls) problems.set(path.toLowerCase(), cls); else problems.delete(path.toLowerCase());
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
        if (u.docChanged) {
          refreshDirty();
          if (active) scheduleAutoSave(active);
        }
        if (u.selectionSet || u.docChanged) ideBridge.selectionChanged();
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
  saveSession();
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
    if (settings().autoSave === "onFocusChange") autoSaveTab(active);
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
  saveSession();
  ideBridge.selectionChanged();
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

async function saveTab(tab: Tab): Promise<boolean> {
  const state = stateOf(tab);
  try {
    // sliceDoc usa el separador de línea del estado (preserva CRLF).
    await invoke("write_file", { path: tab.path, contents: state.sliceDoc() });
    tab.saved = state.doc;
    tab.el.classList.remove("deleted", "conflict");
    refreshDirty();
    return true;
  } catch (e) {
    status(`Error al guardar ${baseName(tab.path)}: ${e}`);
    return false;
  }
}

async function save() {
  if (active && (await saveTab(active))) status(`Guardado ${baseName(active.path)}`);
}

async function saveAll() {
  const dirty = tabs.filter((t) => isDirty(t) || t.el.classList.contains("deleted"));
  if (!dirty.length) return status("No hay cambios sin guardar");
  const ok = (await Promise.all(dirty.map(saveTab))).filter(Boolean).length;
  status(`Guardados ${ok} de ${dirty.length} archivo(s)`);
}

// ---------- autoguardado ----------

const autoSaveTimers = new Map<Tab, number>();

/** No se autoguarda un archivo que cambió fuera del editor o que fue borrado: lo decide el usuario. */
const canAutoSave = (t: Tab) =>
  tabs.includes(t) && isDirty(t) && !t.el.classList.contains("conflict") && !t.el.classList.contains("deleted");

function autoSaveTab(t: Tab) {
  clearTimeout(autoSaveTimers.get(t));
  autoSaveTimers.delete(t);
  if (canAutoSave(t)) saveTab(t);
}

function autoSaveAll() {
  tabs.forEach(autoSaveTab);
}

function scheduleAutoSave(t: Tab) {
  if (settings().autoSave !== "afterDelay") return;
  clearTimeout(autoSaveTimers.get(t));
  autoSaveTimers.set(t, window.setTimeout(() => autoSaveTab(t), settings().autoSaveDelay));
}

// "Al cambiar de foco": salir del área de edición (paleta, búsqueda, árbol, otra app…).
view.contentDOM.addEventListener("blur", () => {
  if (settings().autoSave === "onFocusChange" && active) autoSaveTab(active);
});

// "Al cambiar de ventana" (y también "al cambiar de foco"): irse a otra aplicación.
window.addEventListener("blur", () => {
  const mode = settings().autoSave;
  if (mode === "onWindowChange" || mode === "onFocusChange") autoSaveAll();
});

function renderAutoSaveStatus() {
  const el = $("status-autosave");
  el.textContent = describeAutoSave(settings());
  el.classList.toggle("on", settings().autoSave !== "off");
}

onSettingsChange((s) => {
  renderAutoSaveStatus();
  if (s.autoSave === "afterDelay") tabs.filter(isDirty).forEach(scheduleAutoSave);
  else { autoSaveTimers.forEach((id) => clearTimeout(id)); autoSaveTimers.clear(); }
});

// ---------- sesión: pestañas abiertas por proyecto ----------

interface Session { tabs: { path: string; pos: number }[]; active: string | null }

const sessionKey = (r: string) => `editor-angular:session:${r.toLowerCase()}`;
let restoringSession = false;
let sessionTimer = 0;

function saveSession() {
  if (!root || restoringSession) return;
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(saveSessionNow, 300);
}

function saveSessionNow() {
  if (!root || restoringSession) return;
  const session: Session = {
    tabs: tabs.map((t) => ({ path: t.path, pos: stateOf(t).selection.main.head })),
    active: active?.path ?? null,
  };
  try { localStorage.setItem(sessionKey(root), JSON.stringify(session)); } catch {}
}

async function restoreSession(r: string) {
  let session: Session | null = null;
  try { session = JSON.parse(localStorage.getItem(sessionKey(r)) ?? "null"); } catch {}
  if (!session?.tabs.length) return;
  restoringSession = true;
  try {
    for (const { path, pos } of session.tabs) {
      if (root !== r) return; // el usuario abrió otro proyecto mientras tanto
      const exists = await invoke<string>("read_file", { path }).then(() => true, () => false);
      if (!exists) continue;
      await openFile(path);
      const p = Math.min(pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: p }, effects: EditorView.scrollIntoView(p, { y: "center" }) });
    }
    const last = session.active && findTab(session.active);
    if (last) activate(last);
  } finally {
    restoringSession = false;
  }
}

async function closeTab(tab: Tab, force = false) {
  // Con autoguardado activo, cerrar guarda en lugar de preguntar (como VS Code).
  if (!force && settings().autoSave !== "off" && canAutoSave(tab)) await saveTab(tab);
  if (!force && isDirty(tab)) {
    const discard = await ask(`${baseName(tab.path)} tiene cambios sin guardar. ¿Cerrar de todos modos?`, {
      title: "Cambios sin guardar", kind: "warning", okLabel: "Descartar", cancelLabel: "Cancelar",
    });
    if (!discard) return;
  }
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.el.remove();
  lspServers.release(tab.path);
  saveSession();
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

const parentOf = (p: string) => p.slice(0, p.lastIndexOf(sep));
const indent = (depth: number) => `${8 + depth * 12}px`;

/** Lista `path` en `container`. Las subcarpetas que estaban abiertas se vuelven a abrir. */
async function renderDir(container: HTMLElement, path: string, depth: number) {
  let entries: Entry[];
  try {
    entries = await invoke<Entry[]>("list_dir", { path });
  } catch (e) {
    status(`No se pudo leer ${path}: ${e}`);
    return;
  }
  // Olvidar los nodos descendientes anteriores; se recrean abajo.
  const prefix = path.toLowerCase() + sep;
  for (const m of [fileNodes, dirNodes] as Map<string, unknown>[]) {
    for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
  }

  const frag = document.createDocumentFragment();
  const reopen: DirNode[] = [];
  for (const e of entries) {
    const key = e.path.toLowerCase();
    const row = document.createElement("div");
    row.className = "node " + (e.is_dir ? "dir" : "file");
    row.style.paddingLeft = indent(depth);
    row.dataset.path = e.path;
    row.dataset.dir = e.is_dir ? "1" : "";
    row.textContent = e.name;
    row.setAttribute("role", "treeitem");
    frag.appendChild(row);

    if (e.is_dir) {
      const children = document.createElement("div");
      children.hidden = true;
      frag.appendChild(children);
      let loading: Promise<void> | null = null;
      const node: DirNode = {
        row, children, childDepth: depth + 1,
        setOpen: async (open) => {
          children.hidden = !open;
          row.classList.toggle("open", open);
          if (open) expandedDirs.add(key); else expandedDirs.delete(key);
          if (open) await (loading ??= renderDir(children, e.path, depth + 1));
        },
        reload: async () => { if (loading) await (loading = renderDir(children, e.path, depth + 1)); },
      };
      dirNodes.set(key, node);
      if (expandedDirs.has(key)) reopen.push(node);
    } else {
      fileNodes.set(key, row);
      const cls = problems.get(key);
      if (cls) row.classList.add(cls);
      if (active && samePath(active.path, e.path)) row.classList.add("active");
    }
  }
  container.replaceChildren(frag);
  await Promise.all(reopen.map((n) => n.setOpen(true)));
}

// Un solo listener para todo el árbol (los nodos se recrean al recargar).
$("tree").addEventListener("click", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>(".node[data-path]");
  if (!row) return;
  selectTreeRow(row);
  const path = row.dataset.path!;
  if (row.dataset.dir) {
    const node = dirNodes.get(path.toLowerCase());
    node?.setOpen(!row.classList.contains("open"));
  } else {
    openFile(path);
  }
});

function selectTreeRow(row: HTMLElement | null) {
  document.querySelector("#tree .node.selected")?.classList.remove("selected");
  row?.classList.add("selected");
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
      const node = dirNodes.get(dir.toLowerCase());
      if (!node) break;
      await node.setOpen(true);
    }
  }
  if (active?.path !== path) return; // el usuario ya cambió de pestaña
  const row = markTreeActive(path);
  selectTreeRow(row ?? null);
  row?.scrollIntoView({ block: "nearest" });
}

// ---------- menú contextual y operaciones de archivos ----------

interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  action?: () => void;
  submenu?: (MenuItem | "-")[];
}

function showMenu(x: number, y: number, items: (MenuItem | "-")[], level = 0) {
  // Al abrir un menú se cierran los de su nivel o más profundos.
  document.querySelectorAll<HTMLElement>(".ctxmenu").forEach((m) => { if (+m.dataset.level! >= level) m.remove(); });
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  menu.dataset.level = String(level);
  menu.setAttribute("role", "menu");
  for (const it of items) {
    if (it === "-") { menu.appendChild(document.createElement("hr")); continue; }
    const el = document.createElement("div");
    el.className = "menu-item" + (it.danger ? " danger" : "") + (it.submenu ? " has-submenu" : "");
    el.setAttribute("role", "menuitem");
    el.innerHTML = `<span></span><kbd></kbd>`;
    el.firstElementChild!.textContent = it.label;
    el.lastElementChild!.textContent = it.submenu ? "▸" : it.hint ?? "";
    el.addEventListener("mousedown", (e) => e.preventDefault());
    const openSub = () => {
      const r = el.getBoundingClientRect();
      showMenu(r.right - 2, r.top - 5, it.submenu!, level + 1);
    };
    if (it.submenu) {
      el.addEventListener("mouseenter", openSub);
      el.addEventListener("click", openSub);
    } else {
      el.addEventListener("mouseenter", () => {
        document.querySelectorAll<HTMLElement>(".ctxmenu").forEach((m) => { if (+m.dataset.level! > level) m.remove(); });
      });
      el.addEventListener("click", () => { closeMenu(); it.action?.(); });
    }
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // Mantenerlo dentro de la ventana (un submenú que no cabe se abre hacia la izquierda).
  const r = menu.getBoundingClientRect();
  const left = x + r.width > innerWidth - 4 && level > 0 ? x - r.width * 2 + 4 : Math.min(x, innerWidth - r.width - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

function closeMenu() {
  document.querySelectorAll(".ctxmenu").forEach((m) => m.remove());
}

window.addEventListener("mousedown", (e) => {
  if (!(e.target as HTMLElement).closest(".ctxmenu")) closeMenu();
});
window.addEventListener("blur", closeMenu);

$("tree").addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  if (!root) return;
  const row = (ev.target as HTMLElement).closest<HTMLElement>(".node[data-path]");
  selectTreeRow(row);
  const path = row?.dataset.path ?? root;
  const isDir = !row || !!row.dataset.dir;
  const isRoot = !row;
  const items: (MenuItem | "-")[] = [];
  if (isDir) {
    items.push(
      { label: "Nuevo archivo…", action: () => createEntry(path, "file") },
      { label: "Nueva carpeta…", action: () => createEntry(path, "dir") },
      {
        label: "Angular: generar",
        submenu: SCHEMATICS.map((s) => s === "-" ? s : { label: `${s.label}…`, action: () => ngGenerate(path, s) }),
      },
    );
  } else {
    items.push({ label: "Abrir", action: () => openFile(path) });
  }
  if (!isRoot) {
    items.push(
      "-",
      { label: "Renombrar…", hint: "F2", action: () => renameEntry(path, isDir) },
      { label: "Eliminar", hint: "Supr", danger: true, action: () => deleteEntry(path, isDir) },
    );
  }
  items.push(
    "-",
    { label: "Copiar ruta", action: () => copyText(path) },
    { label: "Copiar ruta relativa", action: () => copyText(isRoot ? "." : relOf(path)) },
    { label: "Mostrar en el Explorador", action: () => invoke("reveal_in_explorer", { path }) },
  );
  showMenu(ev.clientX, ev.clientY, items);
});

// F2 / Supr sobre el elemento seleccionado del árbol.
$("tree").addEventListener("keydown", (ev) => {
  const row = document.querySelector<HTMLElement>("#tree .node.selected");
  if (!row || (ev.target as HTMLElement).tagName === "INPUT") return;
  if (ev.key === "F2") { ev.preventDefault(); renameEntry(row.dataset.path!, !!row.dataset.dir); }
  else if (ev.key === "Delete") { ev.preventDefault(); deleteEntry(row.dataset.path!, !!row.dataset.dir); }
});

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(
    () => status(`Copiado: ${text}`),
    () => status("No se pudo copiar al portapapeles"),
  );
}

const INVALID_NAME = /[<>:"|?*\\/]|^\.{1,2}$|^\s|\s$/;
// Para `ng generate` se permite "carpeta/nombre", pero no espacios ni caracteres raros.
const INVALID_NG_NAME = /[<>:"|?*\\\s]|^\/|\/$|\.\./;

/** Campo de texto dentro del árbol (como en VS Code). Resuelve con el nombre o null si se cancela. */
function inlineInput(
  container: HTMLElement, before: Node | null, depth: number, initial = "", selectEnd?: number,
  opts: { placeholder?: string; invalid?: RegExp } = {},
) {
  const invalid = opts.invalid ?? INVALID_NAME;
  return new Promise<string | null>((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "node editing";
    wrap.style.paddingLeft = indent(depth);
    const input = document.createElement("input");
    input.value = initial;
    input.placeholder = opts.placeholder ?? "";
    input.spellcheck = false;
    wrap.appendChild(input);
    container.insertBefore(wrap, before);
    input.focus();
    input.setSelectionRange(0, selectEnd ?? initial.length);
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      wrap.remove();
      resolve(value);
    };
    input.addEventListener("input", () => {
      input.classList.toggle("invalid", invalid.test(input.value));
    });
    const commit = (keepOpenIfInvalid: boolean) => {
      const v = input.value.trim();
      if (!v || v === initial) return finish(null);
      if (invalid.test(v)) {
        status(`Nombre no válido: ${v}`);
        return keepOpenIfInvalid ? undefined : finish(null);
      }
      finish(v);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") finish(null);
      else if (e.key === "Enter") commit(true);
    });
    // Como en VS Code: hacer clic fuera acepta el nombre.
    input.addEventListener("blur", () => commit(false));
  });
}

async function createEntry(dirPath: string, kind: "file" | "dir") {
  const node = dirNodes.get(dirPath.toLowerCase());
  if (!node) return;
  await node.setOpen(true);
  const name = await inlineInput(node.children, node.children.firstChild, node.childDepth);
  if (!name) return;
  const path = dirPath + sep + name;
  try {
    await invoke(kind === "file" ? "create_file" : "create_dir", { path });
  } catch (e) {
    return status(`No se pudo crear ${name}: ${e}`);
  }
  await node.reload();
  if (kind === "file") {
    fileIndex.push(relOf(path));
    openFile(path);
  } else {
    dirNodes.get(path.toLowerCase())?.setOpen(true);
  }
}

async function renameEntry(path: string, isDir: boolean) {
  const row = (isDir ? dirNodes.get(path.toLowerCase())?.row : fileNodes.get(path.toLowerCase())) ?? null;
  if (!row) return;
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  row.hidden = true;
  const depth = (parseInt(row.style.paddingLeft) - 8) / 12;
  const newName = await inlineInput(row.parentElement!, row.nextSibling, depth, name, !isDir && dot > 0 ? dot : undefined);
  row.hidden = false;
  if (!newName) return;
  const newPath = parentOf(path) + sep + newName;
  try {
    await invoke("rename_path", { from: path, to: newPath });
  } catch (e) {
    return status(`No se pudo renombrar: ${e}`);
  }
  // Mover las pestañas afectadas (el archivo o todo lo que hay dentro de la carpeta).
  for (const t of [...tabs]) {
    if (samePath(t.path, path)) retargetTab(t, newPath);
    else if (isDir && t.path.toLowerCase().startsWith(path.toLowerCase() + sep)) {
      retargetTab(t, newPath + t.path.slice(path.length));
    }
  }
  if (isDir && expandedDirs.delete(path.toLowerCase())) expandedDirs.add(newPath.toLowerCase());
  await dirNodes.get(parentOf(path).toLowerCase())?.reload();
  if (active) revealInTree(active.path);
  status(`Renombrado a ${newName}`);
}

/** Cambia la ruta de una pestaña abierta conservando su contenido (y si tiene cambios sin guardar). */
function retargetTab(tab: Tab, newPath: string) {
  const current = stateOf(tab);
  const wasDirty = isDirty(tab);
  lspServers.release(tab.path);
  tab.path = newPath;
  const state = makeState(newPath, current.sliceDoc());
  tab.state = state;
  if (!wasDirty) tab.saved = state.doc;
  tab.el.title = newPath;
  tab.el.querySelector(".tab-name")!.textContent = baseName(newPath);
  if (tab === active) {
    view.setState(state);
    lspServers.afterActivate();
    $("status-lang").textContent = langFor(newPath).name;
  }
  refreshDirty();
}

async function deleteEntry(path: string, isDir: boolean) {
  const name = baseName(path);
  const ok = await ask(
    isDir ? `¿Mover la carpeta «${name}» y todo su contenido a la papelera?` : `¿Mover «${name}» a la papelera?`,
    { title: "Eliminar", kind: "warning", okLabel: "Mover a la papelera", cancelLabel: "Cancelar" },
  );
  if (!ok) return;
  try {
    await invoke("delete_path", { path });
  } catch (e) {
    return status(`No se pudo eliminar ${name}: ${e}`);
  }
  for (const t of [...tabs]) {
    if (samePath(t.path, path) || (isDir && t.path.toLowerCase().startsWith(path.toLowerCase() + sep))) {
      await closeTab(t, true);
    }
  }
  await dirNodes.get(parentOf(path).toLowerCase())?.reload();
  status(`${name} se movió a la papelera`);
}

// ---------- ng generate ----------

interface Schematic { id: string; label: string; example: string }

const SCHEMATICS: (Schematic | "-")[] = [
  { id: "component", label: "Componente", example: "user-card" },
  { id: "service", label: "Servicio", example: "user" },
  { id: "directive", label: "Directiva", example: "highlight" },
  { id: "pipe", label: "Pipe", example: "short-date" },
  "-",
  { id: "guard", label: "Guard", example: "auth" },
  { id: "interceptor", label: "Interceptor", example: "auth" },
  { id: "resolver", label: "Resolver", example: "user" },
  "-",
  { id: "interface", label: "Interface", example: "user" },
  { id: "enum", label: "Enum", example: "status" },
  { id: "class", label: "Clase", example: "user-model" },
];

let ngBusy = false;

async function ngGenerate(dir: string, s: Schematic) {
  if (ngBusy) return status("Ya hay un ng generate en curso…");
  const node = dirNodes.get(dir.toLowerCase());
  if (!node) return;
  await node.setOpen(true);
  const name = await inlineInput(node.children, node.children.firstChild, node.childDepth, "", undefined, {
    placeholder: `${s.label}, p. ej. ${s.example}`,
    invalid: INVALID_NG_NAME,
  });
  if (!name) return;

  ngBusy = true;
  const label = `Generando ${s.label.toLowerCase()} «${name}»`;
  const t0 = performance.now();
  status(`${label}…`);
  const timer = setInterval(() => status(`${label}… ${Math.round((performance.now() - t0) / 1000)} s`), 1000);
  try {
    const res = await invoke<{ workspace: string; tool: string; command: string; output: string }>(
      "ng_generate", { cwd: dir, schematic: s.id, name },
    );
    const created = [...res.output.matchAll(/^CREATE (\S+)/gm)]
      .map((m) => res.workspace + sep + m[1].split("/").join(sep));
    await node.reload();
    if (!created.length) {
      status(`${res.command}: no se creó ningún archivo`);
      message(`No se creó ningún archivo (puede que ya exista).\n\n$ ${res.command}\n${res.output.trim()}`, {
        title: s.label, kind: "info",
      });
      return;
    }
    const main = created.find((p) => p.endsWith(".ts") && !p.endsWith(".spec.ts")) ?? created[0];
    await openFile(main);
    status(`${s.label} «${name}» creado con ${res.tool} (${created.length} archivo${created.length === 1 ? "" : "s"})`);
  } catch (e) {
    const msg = String(e).trim();
    status(`${label} falló: ${msg.split("\n")[0]}`);
    message(msg, { title: `No se pudo generar: ${s.label}`, kind: "error" });
  } finally {
    clearInterval(timer);
    ngBusy = false;
  }
}

// ---------- cambios hechos fuera del editor ----------

interface FsChange { path: string; exists: boolean; is_dir: boolean }

function watchRoot(dir: string) {
  const channel = new Channel<FsChange[]>();
  channel.onmessage = (changes) => { if (root === dir) onFsChanges(changes); };
  invoke("watch_root", { root: dir, onChange: channel }).catch((e) => status(`No se pueden vigilar cambios: ${e}`));
}

async function onFsChanges(changes: FsChange[]) {
  const dirsToReload = new Map<string, string>();
  const forServers: { path: string; type: 1 | 2 | 3 }[] = [];
  const indexed = new Set(fileIndex.map((f) => f.toLowerCase()));

  for (const c of changes) {
    if (!inRoot(c.path)) continue;
    const parent = parentOf(c.path);
    dirsToReload.set(parent.toLowerCase(), parent);
    const rel = relOf(c.path);
    const relKey = rel.toLowerCase();
    const wasDir = dirNodes.has(c.path.toLowerCase());

    if (!c.exists) {
      // Archivo o carpeta eliminados: quitar del índice todo lo que colgaba de ahí.
      fileIndex = fileIndex.filter((f) => {
        const k = f.toLowerCase();
        return k !== relKey && !k.startsWith(relKey + "/");
      });
      forServers.push({ path: c.path, type: 3 });
      for (const t of tabs) {
        if (samePath(t.path, c.path) || (wasDir && t.path.toLowerCase().startsWith(c.path.toLowerCase() + sep))) {
          markDeleted(t);
        }
      }
    } else if (!c.is_dir) {
      const isNew = !indexed.has(relKey);
      if (isNew) { fileIndex.push(rel); indexed.add(relKey); }
      forServers.push({ path: c.path, type: isNew ? 1 : 2 });
      const tab = findTab(c.path);
      if (tab) syncTabFromDisk(tab);
    }
  }

  lspServers.notifyWatchedFiles(forServers);
  for (const dir of dirsToReload.values()) await dirNodes.get(dir.toLowerCase())?.reload();
}

function markDeleted(tab: Tab) {
  tab.el.classList.add("deleted");
  tab.el.title = `${tab.path} (eliminado del disco; Ctrl+S lo vuelve a crear)`;
}

/** Recarga una pestaña si su archivo cambió fuera del editor. */
async function syncTabFromDisk(tab: Tab) {
  let text: string;
  try {
    text = await invoke<string>("read_file", { path: tab.path });
  } catch {
    return;
  }
  tab.el.classList.remove("deleted");
  tab.el.title = tab.path;
  const disk = text.replace(/\r\n/g, "\n");
  if (disk === tab.saved.toString()) return; // es nuestro propio guardado
  if (isDirty(tab)) {
    tab.el.classList.add("conflict");
    status(`${baseName(tab.path)} cambió en disco y tienes cambios sin guardar (Ctrl+S sobrescribirá)`);
    return;
  }
  // Reemplazar solo el tramo distinto para no perder la posición del cursor.
  const state = stateOf(tab);
  const old = state.doc.toString();
  let a = 0;
  while (a < old.length && a < disk.length && old[a] === disk[a]) a++;
  let b = 0;
  while (b < old.length - a && b < disk.length - a && old[old.length - 1 - b] === disk[disk.length - 1 - b]) b++;
  const spec = {
    changes: { from: a, to: old.length - b, insert: Text.of(disk.slice(a, disk.length - b).split("\n")) },
    annotations: Transaction.addToHistory.of(true),
  };
  if (tab === active) view.dispatch(spec);
  else tab.state = tab.state.update(spec).state;
  tab.saved = stateOf(tab).doc;
  tab.el.classList.remove("conflict");
  refreshDirty();
  status(`${baseName(tab.path)} se recargó (cambió fuera del editor)`);
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
  saveSessionNow();
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
  expandedDirs.clear();
  problems.clear();
  const rootPath = root;
  dirNodes.set(rootPath.toLowerCase(), {
    row: null,
    children: $("tree"),
    childDepth: 0,
    setOpen: async () => {},
    reload: () => renderDir($("tree"), rootPath, 0),
  });
  await renderDir($("tree"), root, 0);
  watchRoot(root);
  servePanel.loadTargets(root);
  ideBridge.setWorkspace(root);
  await restoreSession(root);
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

// Acordes estilo VS Code: Ctrl+K y luego otra tecla.
let chordUntil = 0;

window.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (["control", "shift", "alt", "meta"].includes(k)) return;
  // Ctrl+Ñ (teclado español) o Ctrl+` : mostrar/ocultar la terminal, como en VS Code.
  const terminalKey = ctrl && !e.shiftKey && (k === "ñ" || e.code === "Backquote");
  // Dentro de la terminal, las teclas son de la shell (Ctrl+C, Ctrl+W, Ctrl+K…) salvo estas.
  if (terminalPanel.hasFocus() && !terminalKey && !(ctrl && !e.shiftKey && k === "j")) return;
  let handled = true;
  if (terminalKey) terminalPanel.toggle();
  else if (ctrl && e.altKey && !e.shiftKey && k === "k") ideBridge.atMention();
  else if (Date.now() < chordUntil) {
    chordUntil = 0;
    if (k === "s") saveAll();
    else status("");
  }
  else if (ctrl && !e.shiftKey && k === "k") {
    chordUntil = Date.now() + 2000;
    status("Ctrl+K pulsado… (S = guardar todo)");
  }
  else if (ctrl && !e.shiftKey && k === "s") save();
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
  else if (ctrl && !e.shiftKey && k === "j") { if (isPanelOpen()) hidePanel(); else showPanel(); }
  else if (ctrl && !e.shiftKey && k === ",") openSettings();
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, { capture: true });

$("open-folder").addEventListener("click", pickFolder);
$("open-settings").addEventListener("click", openSettings);
$("status-autosave").addEventListener("click", openSettings);
setupSettingsUi();

appWindow.onCloseRequested(async (e) => {
  saveSessionNow();
  if (settings().autoSave !== "off") await Promise.all(tabs.filter(canAutoSave).map(saveTab));
  const dirty = tabs.filter(isDirty);
  if (!dirty.length) return;
  const discard = await ask(
    `Hay ${dirty.length} archivo(s) sin guardar:\n${dirty.map((t) => baseName(t.path)).join("\n")}\n\n¿Salir de todos modos?`,
    { title: "Cambios sin guardar", kind: "warning", okLabel: "Salir", cancelLabel: "Cancelar" },
  );
  if (!discard) e.preventDefault();
});

window.addEventListener("beforeunload", () => {
  saveSessionNow();
  lspServers.stop();
});

// En la versión instalada no hay consola: los errores no capturados se muestran abajo.
window.addEventListener("error", (e) => status(`Error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  status(`Error: ${r?.message ?? r}`);
});

// ---------- arranque ----------

setupPanel();

const terminalPanel = new TerminalPanel({
  cwd: () => root,
  env: () => ideBridge.terminalEnv(),
  status,
});

const LANGUAGE_IDS: Record<string, string> = {
  ts: "typescript", mts: "typescript", js: "javascript", mjs: "javascript", html: "html",
  scss: "scss", sass: "sass", css: "css", json: "json", md: "markdown",
};

const ideBridge = new IdeBridge({
  view,
  root: () => root,
  activePath: () => active?.path ?? null,
  tabs: () => tabs.map((t) => ({
    path: t.path,
    state: stateOf(t),
    dirty: isDirty(t),
    active: t === active,
    languageId: LANGUAGE_IDS[t.path.slice(t.path.lastIndexOf(".") + 1).toLowerCase()] ?? "plaintext",
  })),
  openFile: async (path) => {
    await openFile(path);
    return !!active && samePath(active.path, path);
  },
  save: async (path) => {
    const t = findTab(path);
    return t ? saveTab(t) : false;
  },
  diagnostics: () => lspServers.allDiagnostics().map((d) => ({
    path: d.path,
    lines: d.doc.lines,
    items: d.items.map((i) => ({
      message: typeof i.message === "string" ? i.message : i.message.value,
      severity: i.severity,
      range: i.range,
      source: i.source,
      code: i.code,
    })),
  })),
  focusClaude: () => terminalPanel.openClaude(),
  onConnection: (connected) => {
    const el = $("status-claude");
    el.textContent = connected ? "✳ Claude conectado" : "✳ Claude";
    el.classList.toggle("on", connected);
    el.title = connected
      ? "Claude Code está conectado al editor (Ctrl+Alt+K envía la selección)"
      : "Abrir Claude Code en la terminal";
    status(connected ? "Claude Code se conectó al editor" : "Claude Code se desconectó");
  },
  status,
});
lspServers.onDiagnosticsChanged((path) => ideBridge.diagnosticsChanged(path));
$("status-claude").addEventListener("click", () => terminalPanel.openClaude());

const servePanel = new ServePanel({
  openFile: (path, line, col) => openFile(path, line, col),
  status,
});

showWelcome(true);
renderAutoSaveStatus();
loadSettings();
let lastRoot: string | null = null;
try { lastRoot = localStorage.getItem(LAST_ROOT_KEY); } catch {}
if (lastRoot) openFolder(lastRoot);
