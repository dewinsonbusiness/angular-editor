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
        <span class="diff-badge">✳ Claude</span>
        <span id="diff-title"></span>
        <span id="diff-queue"></span>
        <span class="spacer"></span>
        <button id="diff-reject" class="secondary">Rechazar</button>
        <button id="diff-accept" title="Ctrl+Enter">Aceptar</button>
      </div>
      <div class="diff-labels"><span>Actual</span><span>Propuesto (editable)</span></div>
      <div id="diff-body"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector("#diff-accept")!.addEventListener("click", () => finish(true));
  el.querySelector("#diff-reject")!.addEventListener("click", () => finish(false));
  el.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); finish(true); }
  });
  return el;
}

async function showNext() {
  const item = queue.shift();
  if (!item) return;
  const { MergeView } = await import("@codemirror/merge");
  const el = overlay();
  el.querySelector("#diff-title")!.textContent = item.title;
  el.querySelector("#diff-queue")!.textContent = queue.length ? `(+${queue.length} en cola)` : "";
  const body = el.querySelector("#diff-body") as HTMLElement;
  body.replaceChildren();

  const common: Extension = [
    lineNumbers(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    langFor(item.newPath).ext(),
    EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "13px" } }),
  ];
  const view = new MergeView({
    a: { doc: item.oldContents, extensions: [common, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
    b: { doc: item.newContents, extensions: common },
    parent: body,
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  showing = { item, view };
  el.hidden = false;
  (el.querySelector("#diff-accept") as HTMLElement).focus();
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
