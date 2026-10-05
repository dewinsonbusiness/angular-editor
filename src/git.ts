import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { StateField, StateEffect, RangeSet, Text, type Extension, type Range } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { viewDiff } from "./diffview";
import "./git.css";

interface FileStatus { path: string; index: string; worktree: string; orig: string | null }
interface RepoStatus { root: string; branch: string | null; upstream: string | null; ahead: number; behind: number; files: FileStatus[] }

export interface QuickPickItem { label: string; detail?: string; pick: () => void }

export interface GitHost {
  view: EditorView;
  root(): string | null;
  activePath(): string | null;
  openFile(path: string): void;
  /** Vuelve a pintar los colores de Git en el árbol. */
  decorateTree(): void;
  quickPick(placeholder: string, items: QuickPickItem[], create?: (text: string) => QuickPickItem | null): void;
  /** Mover a la papelera (para descartar archivos sin seguimiento). */
  trash(path: string): Promise<void>;
  status(msg: string): void;
}

interface Decoration { letter: string; cls: string; label: string }

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function describe(f: FileStatus): Decoration {
  const conflict = f.index === "U" || f.worktree === "U" || (f.index === "A" && f.worktree === "A") || (f.index === "D" && f.worktree === "D");
  if (conflict) return { letter: "!", cls: "git-conflict", label: "Conflicto" };
  if (f.index === "?") return { letter: "U", cls: "git-untracked", label: "Sin seguimiento" };
  const c = f.worktree !== "." ? f.worktree : f.index;
  switch (c) {
    case "A": return { letter: "A", cls: "git-added", label: "Añadido" };
    case "D": return { letter: "D", cls: "git-deleted", label: "Eliminado" };
    case "R": return { letter: "R", cls: "git-renamed", label: "Renombrado" };
    case "C": return { letter: "C", cls: "git-added", label: "Copiado" };
    default: return { letter: "M", cls: "git-modified", label: "Modificado" };
  }
}

// ---------- marcas en el margen del editor ----------

class Mark extends GutterMarker {
  constructor(readonly kind: "add" | "mod" | "del") { super(); }
  eq(other: GutterMarker) { return other instanceof Mark && other.kind === this.kind; }
  toDOM() {
    const d = document.createElement("div");
    d.className = `git-mark git-mark-${this.kind}`;
    d.title = this.kind === "add" ? "Líneas añadidas" : this.kind === "mod" ? "Líneas modificadas" : "Líneas eliminadas";
    return d;
  }
}
const MARKS = { add: new Mark("add"), mod: new Mark("mod"), del: new Mark("del") };
const setMarks = StateEffect.define<RangeSet<GutterMarker>>();
const marksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return value.map(tr.changes);
  },
});

/** Extensión para cada documento: el margen con las marcas de Git. */
export const gitGutter: Extension = [
  marksField,
  gutter({ class: "cm-git-gutter", markers: (v) => v.state.field(marksField) }),
];

async function computeMarks(original: Text, doc: Text): Promise<RangeSet<GutterMarker>> {
  const { Chunk } = await import("@codemirror/merge");
  const ranges: Range<GutterMarker>[] = [];
  for (const c of Chunk.build(original, doc)) {
    if (c.fromB === c.toB) {
      ranges.push(MARKS.del.range(doc.lineAt(Math.min(c.fromB, doc.length)).from));
      continue;
    }
    const kind = c.fromA === c.toA ? MARKS.add : MARKS.mod;
    for (let pos = c.fromB; pos <= Math.min(c.endB, doc.length); ) {
      const line = doc.lineAt(pos);
      ranges.push(kind.range(line.from));
      pos = line.to + 1;
    }
  }
  return RangeSet.of(ranges, true);
}

// ---------- gestor ----------

export class GitManager {
  private repo: RepoStatus | null = null;
  private byPath = new Map<string, FileStatus>();
  private changedDirs = new Set<string>();
  private originals = new Map<string, Promise<Text | null>>();
  private refreshTimer = 0;
  private gutterTimer = 0;
  private refreshing: Promise<void> | null = null;
  private busy = false;

  constructor(private host: GitHost) {
    $("status-git").addEventListener("click", () => this.pickBranch());
    $("scm-commit").addEventListener("click", () => this.commit());
    $("scm-push").addEventListener("click", () => this.push());
    $("scm-pull").addEventListener("click", () => this.pull());
    $("scm-refresh").addEventListener("click", () => this.refresh());
    $("scm-message").addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); this.commit(); }
    });
  }

  private abs(rel: string) {
    return this.repo!.root + "\\" + rel.split("/").join("\\");
  }

  private rel(path: string): string | null {
    const root = this.repo?.root;
    if (!root || !path.toLowerCase().startsWith(root.toLowerCase() + "\\")) return null;
    return path.slice(root.length + 1).split("\\").join("/");
  }

  decorationFor(path: string): Decoration | null {
    const f = this.byPath.get(path.toLowerCase());
    return f ? describe(f) : null;
  }

  dirChanged(path: string) {
    return this.changedDirs.has(path.toLowerCase());
  }

  scheduleRefresh(delay = 400) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    // Si ya hay una lectura en curso, se espera a ella y se hace otra al terminar.
    if (this.refreshing) { await this.refreshing; return this.scheduleRefresh(50); }
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh() {
    const root = this.host.root();
    let st: RepoStatus | null = null;
    if (root) {
      try { st = await invoke<RepoStatus | null>("git_status", { cwd: root }); } catch (e) { console.error("[git]", e); }
    }
    if (root !== this.host.root()) return; // cambió el proyecto mientras tanto
    this.repo = st;
    this.byPath.clear();
    this.changedDirs.clear();
    this.originals.clear();
    for (const f of st?.files ?? []) {
      const abs = this.abs(f.path);
      this.byPath.set(abs.toLowerCase(), f);
      for (let d = abs.slice(0, abs.lastIndexOf("\\")); d.length > st!.root.length; d = d.slice(0, d.lastIndexOf("\\"))) {
        this.changedDirs.add(d.toLowerCase());
      }
    }
    this.renderStatusBar();
    this.renderScm();
    this.host.decorateTree();
    this.updateGutter();
  }

  // ---------- barra de estado y ramas ----------

  private renderStatusBar() {
    const el = $("status-git");
    const r = this.repo;
    el.hidden = !r;
    if (!r) return;
    const sync = [r.behind ? `↓${r.behind}` : "", r.ahead ? `↑${r.ahead}` : ""].filter(Boolean).join(" ");
    el.textContent = `⎇ ${r.branch ?? "(sin rama)"}${sync ? " " + sync : ""}`;
    el.title = `Rama ${r.branch ?? "desconectada"}${r.upstream ? ` → ${r.upstream}` : " (sin rama remota)"}. Clic para cambiar de rama.`;
    const n = r.files.length;
    $("git-count").textContent = n ? String(n) : "";
  }

  private async pickBranch() {
    const r = this.repo;
    if (!r) return;
    let branches: string[] = [];
    try { branches = await invoke<string[]>("git_branches", { root: r.root }); } catch (e) { return this.host.status(`git: ${e}`); }
    const items = branches.filter((b) => b !== r.branch).map((b) => ({
      label: b, detail: "cambiar a esta rama", pick: () => this.run(["switch", b], `Cambiado a ${b}`),
    }));
    this.host.quickPick(`Rama actual: ${r.branch ?? "-"} · escribe para filtrar o para crear una nueva`, items, (text) => {
      const name = text.trim();
      if (!name || branches.includes(name) || /[\s~^:?*[\\]|\.\.|^-/.test(name)) return null;
      return { label: `+ Crear rama "${name}"`, detail: `desde ${r.branch ?? "HEAD"}`, pick: () => this.run(["switch", "-c", name], `Rama ${name} creada`) };
    });
  }

  // ---------- operaciones ----------

  private async run(args: string[], done?: string): Promise<boolean> {
    const r = this.repo;
    if (!r || this.busy) return false;
    this.busy = true;
    this.host.status(`git ${args[0]}…`);
    try {
      const out = await invoke<string>("git_run", { root: r.root, args });
      this.host.status(done ?? (out.split("\n").filter(Boolean).pop() || `git ${args[0]}: listo`));
      return true;
    } catch (e) {
      const msg = String(e);
      this.host.status(`git ${args[0]} falló: ${msg.split("\n")[0]}`);
      message(msg, { title: `git ${args[0]}`, kind: "error" });
      return false;
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private stage(f: FileStatus) {
    return this.run(["add", "-A", "--", f.path, ...(f.orig ? [f.orig] : [])], `Preparado: ${f.path}`);
  }

  private unstage(f: FileStatus) {
    return this.run(["restore", "--staged", "--", f.path, ...(f.orig ? [f.orig] : [])], `Quitado de preparados: ${f.path}`);
  }

  private async discard(f: FileStatus) {
    const untracked = f.index === "?";
    const ok = await ask(
      untracked
        ? `¿Mover «${f.path}» a la papelera? Es un archivo nuevo sin seguimiento.`
        : `¿Descartar los cambios sin preparar de «${f.path}»? Se perderán.`,
      { title: "Descartar cambios", kind: "warning", okLabel: "Descartar", cancelLabel: "Cancelar" },
    );
    if (!ok) return;
    if (untracked) {
      await this.host.trash(this.abs(f.path));
      this.refresh();
    } else {
      await this.run(["restore", "--", f.path], `Cambios descartados: ${f.path}`);
    }
  }

  async commit() {
    const r = this.repo;
    if (!r || this.busy) return;
    const box = $("scm-message") as HTMLTextAreaElement;
    const msg = box.value.trim();
    if (!msg) { box.focus(); return this.host.status("Escribe el mensaje del commit"); }
    const staged = r.files.filter((f) => f.index !== "." && f.index !== "?");
    if (!staged.length) {
      if (!r.files.length) return this.host.status("No hay cambios para hacer commit");
      const all = await ask("No hay cambios preparados. ¿Preparar todos los cambios y hacer commit?", {
        title: "Commit", kind: "info", okLabel: "Preparar todo y commit", cancelLabel: "Cancelar",
      });
      if (!all || !(await this.run(["add", "-A"]))) return;
    }
    this.busy = true;
    try {
      const out = await invoke<string>("git_commit", { root: this.repo!.root, message: msg, amend: false });
      box.value = "";
      this.host.status(`Commit hecho: ${out.split("\n")[0]}`);
    } catch (e) {
      message(String(e), { title: "git commit", kind: "error" });
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  async push() {
    const r = this.repo;
    if (!r?.branch) return;
    await this.run(r.upstream ? ["push"] : ["push", "-u", "origin", r.branch], `Push hecho (${r.branch})`);
  }

  async pull() {
    if (this.repo) await this.run(["pull"], "Pull hecho");
  }

  // ---------- diferencias ----------

  private async show(rev: "HEAD" | "", rel: string): Promise<string> {
    return (await invoke<string | null>("git_show", { root: this.repo!.root, path: rel, rev })) ?? "";
  }

  private async openDiff(f: FileStatus, staged: boolean) {
    const abs = this.abs(f.path);
    const name = f.path.split("/").pop()!;
    let left: string, right: string, leftLabel: string, rightLabel: string;
    if (staged) {
      left = f.index === "A" ? "" : await this.show("HEAD", f.orig ?? f.path);
      right = f.index === "D" ? "" : await this.show("", f.path);
      leftLabel = "Último commit"; rightLabel = "Preparado";
    } else {
      left = f.index === "?" ? "" : await this.show("", f.path);
      right = f.worktree === "D" ? "" : await invoke<string>("read_file", { path: abs }).catch(() => "");
      leftLabel = f.index === "?" ? "(archivo nuevo)" : "Original"; rightLabel = "Tus cambios";
    }
    viewDiff({
      title: `${name} — ${f.path}`, path: abs, left, right, leftLabel, rightLabel,
      onOpen: f.worktree === "D" ? undefined : () => this.host.openFile(abs),
    });
  }

  // ---------- vista de cambios (barra lateral) ----------

  private renderScm() {
    const lists = $("scm-lists");
    const r = this.repo;
    if (!r) {
      lists.innerHTML = `<p class="scm-empty">Esta carpeta no es un repositorio Git.</p>`;
      return;
    }
    const conflicts = r.files.filter((f) => describe(f).cls === "git-conflict");
    const staged = r.files.filter((f) => !conflicts.includes(f) && f.index !== "." && f.index !== "?");
    const changes = r.files.filter((f) => !conflicts.includes(f) && f.worktree !== ".");
    lists.replaceChildren();
    if (!r.files.length) {
      lists.innerHTML = `<p class="scm-empty">No hay cambios. Todo está en el último commit.</p>`;
      return;
    }
    if (conflicts.length) lists.appendChild(this.section("Conflictos", conflicts, "conflict"));
    if (staged.length) lists.appendChild(this.section("Preparados", staged, "staged"));
    if (changes.length) lists.appendChild(this.section("Cambios", changes, "changes"));
  }

  private section(title: string, files: FileStatus[], kind: "conflict" | "staged" | "changes") {
    const sec = document.createElement("section");
    sec.className = "scm-section";
    const head = document.createElement("div");
    head.className = "scm-section-head";
    head.innerHTML = `<span></span><span class="scm-acts"></span>`;
    head.firstElementChild!.textContent = `${title} (${files.length})`;
    const headActs = head.lastElementChild!;
    if (kind === "staged") headActs.appendChild(this.btn("−", "Quitar todo de preparados", () => this.run(["restore", "--staged", "."], "Nada preparado")));
    if (kind === "changes") headActs.appendChild(this.btn("+", "Preparar todos los cambios", () => this.run(["add", "-A"], "Todos los cambios preparados")));
    sec.appendChild(head);

    for (const f of files) {
      const d = describe(kind === "staged" ? { ...f, worktree: "." } : f);
      const row = document.createElement("div");
      row.className = "scm-row";
      row.title = `${f.path} — ${d.label}${f.orig ? ` (antes ${f.orig})` : ""}`;
      const slash = f.path.lastIndexOf("/");
      row.innerHTML = `<span class="scm-name"></span><span class="scm-dir"></span><span class="scm-acts"></span><span class="scm-letter"></span>`;
      row.querySelector(".scm-name")!.textContent = f.path.slice(slash + 1);
      row.querySelector(".scm-dir")!.textContent = slash > 0 ? f.path.slice(0, slash) : "";
      const letter = row.querySelector(".scm-letter")!;
      letter.textContent = d.letter;
      letter.className = `scm-letter ${d.cls}`;
      const acts = row.querySelector(".scm-acts")!;
      const open = () => this.host.openFile(this.abs(f.path));
      if (f.worktree !== "D") acts.appendChild(this.btn("↗", "Abrir archivo", open));
      if (kind === "changes") {
        acts.appendChild(this.btn("↶", "Descartar cambios", () => this.discard(f)));
        acts.appendChild(this.btn("+", "Preparar", () => this.stage(f)));
      } else if (kind === "staged") {
        acts.appendChild(this.btn("−", "Quitar de preparados", () => this.unstage(f)));
      } else {
        acts.appendChild(this.btn("+", "Marcar como resuelto (preparar)", () => this.stage(f)));
      }
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        if (kind === "conflict") open(); else this.openDiff(f, kind === "staged");
      });
      sec.appendChild(row);
    }
    return sec;
  }

  private btn(text: string, title: string, action: () => void) {
    const b = document.createElement("button");
    b.className = "scm-btn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); action(); });
    return b;
  }

  // ---------- margen del editor ----------

  scheduleGutter() {
    clearTimeout(this.gutterTimer);
    this.gutterTimer = window.setTimeout(() => this.updateGutter(), 250);
  }

  async updateGutter() {
    const view = this.host.view;
    const path = this.host.activePath();
    const rel = path ? this.rel(path) : null;
    const f = path ? this.byPath.get(path.toLowerCase()) : undefined;
    let marks: RangeSet<GutterMarker> = RangeSet.empty;
    // Sin cambios según git, o archivo nuevo: no hay nada que marcar.
    if (rel && f && f.index !== "?" && f.index !== "A") {
      const key = rel.toLowerCase();
      if (!this.originals.has(key)) {
        this.originals.set(key, this.show("HEAD", rel).then((t) => Text.of(t.split(/\r?\n/))).catch(() => null));
      }
      const original = await this.originals.get(key)!;
      if (this.host.activePath() !== path) return; // cambió de pestaña mientras tanto
      if (original) marks = await computeMarks(original, view.state.doc);
    } else if (rel && path && this.repo && !f) {
      // El archivo coincide con git, pero puede haberse editado sin guardar.
      const key = rel.toLowerCase();
      if (!this.originals.has(key)) {
        this.originals.set(key, this.show("HEAD", rel).then((t) => t ? Text.of(t.split(/\r?\n/)) : null).catch(() => null));
      }
      const original = await this.originals.get(key)!;
      if (this.host.activePath() !== path) return;
      if (original && !original.eq(view.state.doc)) marks = await computeMarks(original, view.state.doc);
    }
    if (this.host.activePath() === path) view.dispatch({ effects: setMarks.of(marks) });
  }
}
