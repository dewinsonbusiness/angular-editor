import { invoke } from "@tauri-apps/api/core";
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/**
 * "Git blame" en línea, como en VS Code: al final de la línea del cursor se muestra
 * quién la cambió por última vez, hace cuánto y el mensaje del commit.
 * Solo se dibuja una anotación (la de la línea actual), así que no pesa.
 */

interface BlameCommit { hash: string; author: string; email: string; time: number; summary: string }
interface BlameData { commits: BlameCommit[]; lines: number[] }

export interface BlameHost {
  view: EditorView;
  activePath(): string | null;
  /** Raíz del repositorio y ruta relativa (con "/"), o null si el archivo no está en Git. */
  gitLocation(path: string): { root: string; rel: string } | null;
  enabled(): boolean;
}

const setBlame = StateEffect.define<BlameData | null>();

const blameField = StateField.define<BlameData | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    // Al editar, los números de línea dejan de coincidir: se oculta hasta recalcular.
    return tr.docChanged ? null : value;
  },
});

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60],
];

function ago(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "ahora mismo";
}

const isUncommitted = (c: BlameCommit) => /^0+$/.test(c.hash);

class BlameWidget extends WidgetType {
  constructor(readonly commit: BlameCommit) { super(); }
  eq(other: BlameWidget) { return other.commit.hash === this.commit.hash; }
  toDOM() {
    const c = this.commit;
    const el = document.createElement("span");
    el.className = "cm-blame";
    if (isUncommitted(c)) {
      el.textContent = "Tú · sin commit";
      el.title = "Esta línea tiene cambios que todavía no están en ningún commit";
      return el;
    }
    const summary = c.summary.length > 72 ? c.summary.slice(0, 71) + "…" : c.summary;
    el.textContent = `${c.author}, ${ago(c.time)} • ${summary}`;
    const date = new Date(c.time * 1000).toLocaleString("es", { dateStyle: "long", timeStyle: "short" });
    el.title = `${c.summary}\n\n${c.author} <${c.email}>\n${date}\nCommit ${c.hash.slice(0, 10)}`;
    return el;
  }
  ignoreEvent() { return false; }
}

const blameLine = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.startState.field(blameField) !== u.state.field(blameField)) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const data = view.state.field(blameField);
      if (!data) return Decoration.none;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const idx = data.lines[line.number - 1];
      const commit = idx === undefined ? undefined : data.commits[idx];
      if (!commit) return Decoration.none;
      return Decoration.set([Decoration.widget({ widget: new BlameWidget(commit), side: 1 }).range(line.to)]);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Extensión para cada documento. */
export const gitBlame: Extension = [blameField, blameLine];

export class BlameManager {
  private timer = 0;
  private seq = 0;

  constructor(private host: BlameHost) {}

  /** Recalcular (al abrir/cambiar de pestaña, tras un commit, o al dejar de escribir). */
  schedule(delay = 800) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    const view = this.host.view;
    const path = this.host.activePath();
    const loc = path && this.host.enabled() ? this.host.gitLocation(path) : null;
    const seq = ++this.seq;
    if (!loc) {
      if (view.state.field(blameField, false)) view.dispatch({ effects: setBlame.of(null) });
      return;
    }
    const doc = view.state.doc;
    let data: BlameData | null = null;
    try {
      // sliceDoc respeta los finales de línea del archivo (CRLF/LF), igual que en disco.
      data = await invoke<BlameData>("git_blame", { root: loc.root, path: loc.rel, contents: view.state.sliceDoc() });
    } catch {
      data = null; // archivo sin seguimiento, binario, etc.
    }
    // Descartar si mientras tanto se cambió de pestaña o se editó el documento.
    if (seq !== this.seq || this.host.activePath() !== path || !view.state.doc.eq(doc)) return;
    view.dispatch({ effects: setBlame.of(data) });
  }
}
