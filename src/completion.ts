import { invoke } from "@tauri-apps/api/core";
import { StateField, StateEffect, Prec, type Extension } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from "@codemirror/view";

/**
 * Experimento: completar a demanda con Claude (Alt+/) usando el `claude` oficial y la
 * suscripción del usuario. La sugerencia aparece en gris en el cursor: Tab la acepta, Esc la descarta.
 */

interface Suggestion { pos: number; text: string }

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggestion)) return e.value;
    // Cualquier edición o movimiento del cursor la descarta (como el texto fantasma de Copilot).
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (s): DecorationSet =>
    s ? Decoration.set([Decoration.widget({ widget: new GhostText(s.text), side: 1 }).range(s.pos)]) : Decoration.none),
});

class GhostText extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostText) { return other.text === this.text; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-ghost";
    el.textContent = this.text;
    el.title = "Sugerencia de Claude · Tab para aceptar, Esc para descartar";
    return el;
  }
}

function accept(view: EditorView): boolean {
  const s = view.state.field(suggestionField, false);
  if (!s) return false;
  view.dispatch({
    changes: { from: s.pos, insert: s.text },
    selection: { anchor: s.pos + s.text.length },
    effects: setSuggestion.of(null),
    userEvent: "input.complete",
  });
  return true;
}

function dismiss(view: EditorView): boolean {
  if (!view.state.field(suggestionField, false)) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

/** Extensión para cada documento. Prec.highest: Tab acepta antes que la indentación. */
export const claudeCompletion: Extension = [
  suggestionField,
  Prec.highest(keymap.of([
    { key: "Tab", run: accept },
    { key: "Escape", run: dismiss },
  ])),
];

/** Quita vallas de markdown si el modelo las pone pese a las instrucciones. */
function clean(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n");
  const fenced = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (fenced) t = fenced[1];
  return t.replace(/\s+$/, "");
}

export interface CompletionHost {
  view: EditorView;
  root(): string | null;
  activePath(): string | null;
  relPath(path: string): string;
  language(path: string): string;
  status(msg: string): void;
}

export class ClaudeCompleter {
  private pending = false;
  private seq = 0;

  constructor(private host: CompletionHost) {
    // Esc mientras piensa: cancelar la petición.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.pending) this.cancel();
    }, { capture: true });
  }

  async trigger() {
    const view = this.host.view;
    const path = this.host.activePath();
    const root = this.host.root();
    if (!path || !root) return;
    if (view.state.readOnly) return this.host.status("Este archivo es de solo lectura");

    const state = view.state;
    const pos = state.selection.main.head;
    // Contexto: lo anterior y lo posterior al cursor (recortado para que sea rápido).
    const before = state.sliceDoc(Math.max(0, pos - 6000), pos);
    const after = state.sliceDoc(pos, Math.min(state.doc.length, pos + 2000));
    const prompt = `File: ${this.host.relPath(path)} (${this.host.language(path)})\n\n${before}<CURSOR>${after}`;

    const seq = ++this.seq;
    this.pending = true;
    const t0 = performance.now();
    this.host.status("✳ Claude está pensando… (Esc para cancelar)");
    try {
      const raw = await invoke<string>("claude_complete", { cwd: root, prompt, model: "haiku" });
      if (seq !== this.seq) return;
      // Si mientras tanto se editó o se movió el cursor, la sugerencia ya no encaja.
      if (!view.state.doc.eq(state.doc) || view.state.selection.main.head !== pos || this.host.activePath() !== path) {
        return this.host.status("Sugerencia descartada: el archivo cambió mientras Claude pensaba");
      }
      const text = clean(raw);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (!text) return this.host.status(`Claude no sugirió nada (${secs} s)`);
      view.dispatch({ effects: setSuggestion.of({ pos, text }) });
      this.host.status(`Sugerencia de Claude (${secs} s) · Tab para aceptar, Esc para descartar`);
    } catch (e) {
      if (seq === this.seq) this.host.status(`No se pudo completar con Claude: ${String(e).split("\n")[0]}`);
    } finally {
      if (seq === this.seq) this.pending = false;
    }
  }

  cancel() {
    this.seq++;
    this.pending = false;
    invoke("claude_complete_cancel").catch(() => {});
    this.host.status("Sugerencia cancelada");
  }
}
