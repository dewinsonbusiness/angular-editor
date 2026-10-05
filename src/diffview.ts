import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { langFor } from "./lang";

/** Cambio propuesto por Claude Code (herramienta openDiff del protocolo del IDE). */
export interface DiffRequest {
  oldPath: string;
  newPath: string;
  oldContents: string;
  newContents: string;
  tabName: string;
  title: string;
}

export interface DiffResult {
  accepted: boolean;
  /** Contenido final (con lo que el usuario haya editado a la derecha). */
  contents: string;
}

interface Pending extends DiffRequest {
  resolve(r: DiffResult): void;
}

const queue: Pending[] = [];
let showing: { item: Pending; view: { b: EditorView; destroy(): void } } | null = null;

/** Muestra el cambio (o lo pone en cola) y espera a que el usuario acepte o rechace. */
export function reviewDiff(req: DiffRequest): Promise<DiffResult> {
  return new Promise((resolve) => {
    queue.push({ ...req, resolve });
    if (!showing) showNext();
  });
}

/** Cierra (rechazando) los cambios pendientes; con `tabName`, solo ese. Devuelve cuántos cerró. */
export function closeDiffs(tabName?: string): number {
  let n = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (tabName === undefined || queue[i].tabName === tabName) {
      queue[i].resolve({ accepted: false, contents: "" });
      queue.splice(i, 1);
      n++;
    }
  }
  if (showing && (tabName === undefined || showing.item.tabName === tabName)) {
    finish(false);
    n++;
  }
  return n;
}

function overlay(): HTMLElement {
  let el = document.getElementById("diff-review");
  if (el) return el;
  el = document.createElement("div");
  el.id = "diff-review";
  el.className = "overlay";
  el.hidden = true;
  el.innerHTML = `
    <div class="diff-box" role="dialog" aria-labelledby="diff-title">
      <div class="diff-header">
        <span class="diff-badge" id="diff-badge">✳ Claude</span>
        <span id="diff-title"></span>
        <span id="diff-queue"></span>
        <span class="spacer"></span>
        <button id="diff-reject" class="secondary">Rechazar</button>
        <button id="diff-accept" title="Ctrl+Enter">Aceptar</button>
        <button id="diff-open" class="secondary">Abrir archivo</button>
        <button id="diff-close" title="Esc">Cerrar</button>
      </div>
      <div class="diff-labels"><span id="diff-label-a">Actual</span><span id="diff-label-b">Propuesto (editable)</span></div>
      <div id="diff-body"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector("#diff-accept")!.addEventListener("click", () => finish(true));
  el.querySelector("#diff-reject")!.addEventListener("click", () => finish(false));
  el.querySelector("#diff-close")!.addEventListener("click", () => closeViewer());
  el.querySelector("#diff-open")!.addEventListener("click", () => { const open = viewer?.onOpen; closeViewer(); open?.(); });
  el.addEventListener("keydown", (e) => {
    if (viewer) { if (e.key === "Escape") { e.preventDefault(); closeViewer(); } return; }
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); finish(true); }
  });
  return el;
}

async function showNext() {
  const item = queue.shift();
  if (!item) return;
  if (viewer) closeViewer();
  const el = overlay();
  setMode(el, "review", item.title, "Actual", "Propuesto (editable)");
  el.querySelector("#diff-queue")!.textContent = queue.length ? `(+${queue.length} en cola)` : "";
  const view = await buildMerge(el, item.newPath, item.oldContents, item.newContents, true);
  showing = { item, view };
  el.hidden = false;
  (el.querySelector("#diff-accept") as HTMLElement).focus();
}

function setMode(el: HTMLElement, mode: "review" | "view", title: string, labelA: string, labelB: string) {
  const review = mode === "review";
  el.querySelector("#diff-badge")!.textContent = review ? "✳ Claude" : "Git";
  el.querySelector("#diff-badge")!.classList.toggle("git", !review);
  el.querySelector("#diff-title")!.textContent = title;
  el.querySelector("#diff-queue")!.textContent = "";
  el.querySelector("#diff-label-a")!.textContent = labelA;
  el.querySelector("#diff-label-b")!.textContent = labelB;
  for (const id of ["#diff-accept", "#diff-reject"]) (el.querySelector(id) as HTMLElement).hidden = !review;
  for (const id of ["#diff-open", "#diff-close"]) (el.querySelector(id) as HTMLElement).hidden = review;
}

async function buildMerge(el: HTMLElement, path: string, a: string, b: string, editableB: boolean) {
  const { MergeView } = await import("@codemirror/merge");
  const body = el.querySelector("#diff-body") as HTMLElement;
  body.replaceChildren();
  const common: Extension = [
    lineNumbers(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    langFor(path).ext(),
    EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "13px" } }),
  ];
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  return new MergeView({
    a: { doc: a, extensions: [common, readOnly] },
    b: { doc: b, extensions: editableB ? common : [common, readOnly] },
    parent: body,
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
}

// ---------- visor de solo lectura (diferencias de Git) ----------

let viewer: { view: { destroy(): void }; onOpen?: () => void } | null = null;

export async function viewDiff(opts: {
  title: string; path: string; left: string; right: string; leftLabel: string; rightLabel: string; onOpen?: () => void;
}) {
  if (showing) return; // hay un cambio de Claude esperando respuesta: tiene prioridad
  if (viewer) closeViewer();
  const el = overlay();
  setMode(el, "view", opts.title, opts.leftLabel, opts.rightLabel);
  // Normalizar finales de línea para que CRLF/LF no aparezcan como cambios.
  const view = await buildMerge(el, opts.path, opts.left.replace(/\r\n/g, "\n"), opts.right.replace(/\r\n/g, "\n"), false);
  viewer = { view, onOpen: opts.onOpen };
  el.hidden = false;
  (el.querySelector("#diff-close") as HTMLElement).focus();
}

function closeViewer() {
  if (!viewer) return;
  viewer.view.destroy();
  viewer = null;
  overlay().hidden = true;
}

function finish(accepted: boolean) {
  if (!showing) return;
  const { item, view } = showing;
  // Respetar los finales de línea que trae la propuesta (CRLF en Windows).
  const eol = item.newContents.includes("\r\n") ? "\r\n" : "\n";
  const doc = view.b.state.doc;
  const contents = doc.sliceString(0, doc.length, eol);
  view.destroy();
  showing = null;
  overlay().hidden = true;
  item.resolve({ accepted, contents });
  if (queue.length) showNext();
}
