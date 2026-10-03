import { invoke, Channel } from "@tauri-apps/api/core";

/** Lo que el panel necesita del editor. */
export interface ServeHost {
  openFile(path: string, line?: number, col?: number): void;
  status(msg: string): void;
}

type State = "starting" | "building" | "ready" | "error" | "stopped";
type ServeEvent = { kind: "line"; err: boolean; text: string } | { kind: "exit"; code: number | null };

interface Session {
  id: string;
  project: string;
  state: State;
  url: string | null;
  out: HTMLElement;
  chip: HTMLElement;
  failedThisBuild: boolean;
}

const STATE_LABEL: Record<State, string> = {
  starting: "iniciando…",
  building: "compilando…",
  ready: "listo",
  error: "con errores",
  stopped: "detenido",
};

const MAX_LINES = 4000;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const LOCATION = /((?:[A-Za-z]:[\\/])?(?:[\w@.()-]+[\\/])*[\w@.()-]+\.(?:ts|mts|html|scss|sass|less|css|js|mjs|json)):(\d+)(?::(\d+))?(:?)/g;

export class ServePanel {
  private sessions: Session[] = [];
  private selected: Session | null = null;
  private workspace: string | null = null;
  private sep = "\\";
  private root: string | null = null;
  private tool = "nx";

  constructor(private host: ServeHost) {
    // Sesiones de una carga anterior de la interfaz (sus eventos ya no llegan aquí).
    invoke("serve_stop_all");

    $("serve-start").addEventListener("click", () => this.start());
    $("serve-stop").addEventListener("click", () => this.selected && this.stop(this.selected));
    $("serve-open").addEventListener("click", () => this.openInBrowser());
    $("serve-clear").addEventListener("click", () => this.selected?.out.replaceChildren());
    $("panel-close").addEventListener("click", () => this.toggle(false));
    $("status-serve").addEventListener("click", () => this.toggle());
    $("serve-project").addEventListener("change", () => {
      try { localStorage.setItem(this.projectKey(), $<HTMLSelectElement>("serve-project").value); } catch {}
    });
    $("serve-output").addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>(".loc");
      if (link) this.openLocation(link.dataset.file!, +link.dataset.line!, +link.dataset.col!);
    });
    this.setupResizer();
    this.render();
  }

  get isOpen() { return !$("panel").hidden; }

  toggle(open = !this.isOpen) {
    $("panel").hidden = !open;
  }

  /** Al abrir un proyecto: lista rápida desde project.json / angular.json y luego la de Nx. */
  async loadTargets(root: string) {
    this.root = root;
    this.sep = root.includes("\\") ? "\\" : "/";
    const select = $<HTMLSelectElement>("serve-project");
    select.replaceChildren(new Option("buscando apps…", ""));
    let tool = "";
    try {
      const t = await invoke<{ workspace: string; tool: string; projects: string[] }>("serve_targets", { root });
      if (this.root !== root) return;
      this.workspace = t.workspace;
      tool = t.tool;
      this.tool = t.tool;
      this.fillProjects(t.projects);
    } catch {
      this.workspace = null;
      select.replaceChildren(new Option("sin workspace Angular/Nx", ""));
      this.render();
      return;
    }
    if (tool === "nx") {
      invoke<string[]>("serve_targets_nx", { root }).then((all) => {
        if (this.root === root && all.length) this.fillProjects(all);
      }, () => {});
    }
  }

  private projectKey() { return `editor-angular:serve-project:${this.root}`; }

  private fillProjects(projects: string[]) {
    const select = $<HTMLSelectElement>("serve-project");
    const previous = select.value || (() => { try { return localStorage.getItem(this.projectKey()); } catch { return null; } })();
    select.replaceChildren(...projects.map((p) => new Option(p, p)));
    if (!projects.length) select.replaceChildren(new Option("ninguna app con serve", ""));
    if (previous && projects.includes(previous)) select.value = previous;
    this.render();
  }

  async start(project = $<HTMLSelectElement>("serve-project").value) {
    if (!project || !this.workspace) return;
    const running = this.sessions.find((s) => s.project === project && s.state !== "stopped");
    if (running) return this.select(running);
    const portText = $<HTMLInputElement>("serve-port").value.trim();
    const port = portText ? Number(portText) : null;
    if (portText && !(port! > 0 && port! < 65536)) return this.host.status(`Puerto no válido: ${portText}`);

    // Reutilizar la sesión detenida de ese proyecto (y su salida) si existe.
    let s = this.sessions.find((x) => x.project === project);
    if (!s) {
      const out = document.createElement("div");
      out.className = "serve-log";
      $("serve-output").appendChild(out);
      const chip = document.createElement("button");
      chip.className = "serve-chip";
      $("serve-sessions").appendChild(chip);
      s = { id: "", project, state: "starting", url: null, out, chip, failedThisBuild: false };
      const session = s;
      chip.addEventListener("click", () => this.select(session));
      this.sessions.push(s);
    }
    const session = s;
    session.id = `${project}-${Date.now()}`;
    session.state = "starting";
    session.url = null;
    session.failedThisBuild = false;
    this.append(session, `$ ${this.tool} serve ${project}${port ? ` --port=${port}` : ""}`, "cmd");

    const channel = new Channel<ServeEvent>();
    const id = session.id;
    channel.onmessage = (ev) => {
      if (session.id !== id) return; // evento de una ejecución anterior
      if (ev.kind === "line") this.onLine(session, ev.text, ev.err);
      else {
        this.append(session, `— proceso terminado${ev.code != null ? ` (código ${ev.code})` : ""} —`, "cmd");
        session.state = "stopped";
        this.render();
      }
    };
    this.toggle(true);
    this.select(session);
    try {
      await invoke("serve_start", { id, root: this.workspace, project, port, onEvent: channel });
    } catch (e) {
      this.append(session, String(e), "error");
      session.state = "stopped";
      this.render();
    }
  }

  stop(s: Session) {
    if (s.state === "stopped") return;
    invoke("serve_stop", { id: s.id });
    this.append(s, "— detenido —", "cmd");
    s.state = "stopped";
    this.render();
  }

  private select(s: Session) {
    this.selected = s;
    for (const x of this.sessions) x.out.hidden = x !== s;
    $<HTMLSelectElement>("serve-project").value = s.project;
    this.render();
    this.scrollToEnd(s);
  }

  // ---------- salida ----------

  private onLine(s: Session, raw: string, isErr: boolean) {
    const text = raw.replace(ANSI, "");
    let cls = "";
    if (/Changes detected|Rebuilding|Building\.\.\.|Generating browser application bundles/i.test(text)) {
      s.state = "building";
      s.failedThisBuild = false;
    }
    if (/bundle generation failed|Failed to compile|✘ \[ERROR\]|\bERROR\b|error TS\d+|is already in use/i.test(text)) {
      s.state = "error";
      s.failedThisBuild = true;
      cls = "error";
    } else if (/WARNING|▲ \[WARNING\]/.test(text)) {
      cls = "warning";
    }
    if (/bundle generation complete|compiled successfully/i.test(text) && !s.failedThisBuild) {
      s.state = "ready";
      cls = "ok";
    }
    const local = /Local:\s+(https?:\/\/\S+)/.exec(text) ?? /listening on:?\s+(https?:\/\/\S+)/i.exec(text);
    if (local) {
      s.url = local[1];
      if (!s.failedThisBuild) s.state = "ready";
      cls = "ok";
    }
    if (/is already in use/i.test(text)) {
      this.host.status(`${s.project}: el puerto está ocupado. Escribe otro en el campo "puerto" y vuelve a iniciar.`);
    }
    this.append(s, text, cls || (isErr ? "stderr" : ""));
    this.render();
  }

  private append(s: Session, text: string, cls = "") {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    // Enlazar ubicaciones de archivo (ruta:línea:columna).
    let last = 0;
    for (const m of text.matchAll(LOCATION)) {
      line.append(text.slice(last, m.index));
      const a = document.createElement("span");
      a.className = "loc";
      a.textContent = m[0];
      a.dataset.file = m[1];
      a.dataset.line = m[2];
      // esbuild ("ruta:15:6:") usa columnas desde 0; el formato de tsc desde 1.
      a.dataset.col = String(m[3] ? Math.max(0, +m[3] - (m[4] ? 0 : 1)) : 0);
      line.appendChild(a);
      last = m.index! + m[0].length;
    }
    line.append(text.slice(last));

    const atBottom = this.isAtBottom();
    s.out.appendChild(line);
    if (s.out.childElementCount > MAX_LINES) {
      for (let i = 0; i < 500; i++) s.out.firstElementChild?.remove();
    }
    if (atBottom && s === this.selected) this.scrollToEnd(s);
  }

  private isAtBottom() {
    const o = $("serve-output");
    return o.scrollHeight - o.scrollTop - o.clientHeight < 40;
  }

  private scrollToEnd(_s: Session) {
    const o = $("serve-output");
    o.scrollTop = o.scrollHeight;
  }

  private openLocation(file: string, line: number, col: number) {
    if (!this.workspace) return;
    const abs = /^[A-Za-z]:[\\/]|^\//.test(file) ? file : this.workspace + this.sep + file.split(/[\\/]/).join(this.sep);
    this.host.openFile(abs, line, col);
  }

  private openInBrowser() {
    const url = this.selected?.url;
    if (url) invoke("open_url", { url }).catch((e) => this.host.status(`No se pudo abrir el navegador: ${e}`));
  }

  // ---------- estado visual ----------

  private render() {
    for (const s of this.sessions) {
      s.chip.className = `serve-chip ${s.state}` + (s === this.selected ? " selected" : "");
      s.chip.textContent = s.project;
      s.chip.title = `${s.project}: ${STATE_LABEL[s.state]}${s.url ? ` — ${s.url}` : ""}`;
    }
    const sel = this.selected;
    const running = !!sel && sel.state !== "stopped";
    $<HTMLButtonElement>("serve-stop").disabled = !running;
    $<HTMLButtonElement>("serve-open").disabled = !sel?.url || !running;
    $<HTMLButtonElement>("serve-start").disabled = !this.workspace || !$<HTMLSelectElement>("serve-project").value;
    $("serve-url").textContent = running && sel?.url ? sel.url : "";

    // Barra de estado: la sesión seleccionada (o la primera activa) y cuántas más hay.
    const active = this.sessions.filter((s) => s.state !== "stopped");
    const shown = sel && sel.state !== "stopped" ? sel : active[0];
    const el = $("status-serve");
    if (!shown) {
      el.textContent = "▶ serve";
      el.className = "";
    } else {
      el.textContent = `● ${shown.project}: ${STATE_LABEL[shown.state]}${active.length > 1 ? ` (+${active.length - 1})` : ""}`;
      el.className = shown.state;
    }
  }

  private setupResizer() {
    const panel = $("panel");
    try {
      const h = localStorage.getItem("editor-angular:panel-height");
      if (h) panel.style.height = h;
    } catch {}
    $("panel-resizer").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = panel.getBoundingClientRect().height;
      const move = (ev: MouseEvent) => {
        const h = Math.min(window.innerHeight * 0.8, Math.max(80, startH + startY - ev.clientY));
        panel.style.height = `${h}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        try { localStorage.setItem("editor-angular:panel-height", panel.style.height); } catch {}
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }
}
