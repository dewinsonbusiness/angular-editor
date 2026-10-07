import { invoke, Channel } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { showPanel, onPanelView, isPanelOpen, currentView } from "./panel";

/** Lo que la terminal necesita del editor. */
export interface TerminalHost {
  /** Carpeta en la que se abren las terminales (raíz del proyecto). */
  cwd(): string | null;
  /** Variables de entorno extra (p. ej. las que usa Claude Code para conectarse al editor). */
  env(): Record<string, string>;
  status(msg: string): void;
}

type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

interface Session {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  chip: HTMLElement;
  exited: boolean;
  writes: Promise<unknown>;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Rutas con espacios entre comillas, para que la shell y Claude las lean enteras. */
const quotePath = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

// xterm.js (~300 KB) solo se descarga la primera vez que se abre una terminal.
let xtermModules: Promise<{
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
}> | null = null;

function loadXterm() {
  return (xtermModules ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([x, f, w]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon, WebLinksAddon: w.WebLinksAddon })));
}

// Paleta One Dark, la misma del editor.
const THEME = {
  background: "#21252b",
  foreground: "#abb2bf",
  cursor: "#528bff",
  selectionBackground: "#3e4451",
  black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
  brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
  brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
};

export class TerminalPanel {
  private sessions: Session[] = [];
  private active: Session | null = null;
  private counter = 0;
  private creating = false;

  constructor(private host: TerminalHost) {
    // Terminales de una carga anterior de la interfaz.
    invoke("pty_kill_all");
    $("term-new").addEventListener("click", () => this.create());
    $("term-claude").addEventListener("click", () => this.openClaude());
    onPanelView((v) => { if (v === "terminal") this.onShown(); });
    new ResizeObserver(() => this.fitActive()).observe($("term-host"));
  }

  /** Ctrl+Ñ / Ctrl+`: mostrar u ocultar la terminal (creando una si no hay). */
  toggle() {
    if (isPanelOpen() && currentView() === "terminal") {
      $("panel").hidden = true;
      return;
    }
    showPanel("terminal");
  }

  /** ¿El foco está dentro de una terminal? (para no robarle atajos de teclado). */
  hasFocus() {
    return $("term-host").contains(document.activeElement);
  }

  private onShown() {
    // `creating` evita un bucle: create() muestra el panel y eso vuelve a llamar aquí.
    if (!this.sessions.length) { if (!this.creating) this.create(); }
    else {
      this.fitActive();
      this.active?.term.focus();
    }
  }

  /** Abre Claude Code en una terminal nueva; al salir de él queda la shell abierta. */
  openClaude() {
    const existing = this.sessions.find((s) => s.title === "Claude" && !s.exited);
    if (existing) {
      showPanel("terminal");
      return this.select(existing);
    }
    return this.create({ title: "Claude", args: ["-NoLogo", "-NoExit", "-Command", "claude"] });
  }

  async create(opts: { title?: string; args?: string[] } = {}) {
    const cwd = this.host.cwd();
    if (!cwd) return this.host.status("Abre un proyecto para usar la terminal");
    this.creating = true;
    try {
      showPanel("terminal");
      await this.createSession(cwd, opts);
    } catch (e) {
      this.host.status(`No se pudo abrir la terminal: ${e}`);
      console.error(e);
    } finally {
      this.creating = false;
    }
  }

  private async createSession(cwd: string, opts: { title?: string; args?: string[] }) {
    const { Terminal, FitAddon, WebLinksAddon } = await loadXterm();

    const id = `term-${Date.now()}-${++this.counter}`;
    const title = opts.title ?? `Terminal ${this.counter}`;
    const el = document.createElement("div");
    el.className = "term-view";
    $("term-host").appendChild(el);

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, url) => {
      invoke("open_url", { url }).catch(() => {});
    }));
    term.open(el);

    const chip = document.createElement("button");
    chip.className = "serve-chip term-chip";
    chip.innerHTML = `<span class="chip-label"></span><span class="chip-close" title="Cerrar terminal">×</span>`;
    chip.querySelector(".chip-label")!.textContent = title;
    $("term-sessions").appendChild(chip);

    const s: Session = { id, title, term, fit, el, chip, exited: false, writes: Promise.resolve() };
    this.sessions.push(s);
    chip.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("chip-close")) this.close(s);
      else this.select(s);
    });
    chip.addEventListener("mousedown", (e) => { if (e.button === 1) { e.preventDefault(); this.close(s); } });

    // Copiar/pegar como en Windows Terminal: Ctrl+C copia si hay selección; Ctrl+V pega.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const ctrl = e.ctrlKey && !e.altKey;
      if (ctrl && (e.key === "c" || e.key === "C") && (term.hasSelection() || e.shiftKey)) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (ctrl && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        this.paste(term);
        return false;
      }
      return true;
    });

    // Escribir en orden: cada tecla espera a la anterior.
    term.onData((data) => {
      if (s.exited) return;
      s.writes = s.writes.then(() => invoke("pty_write", { id, data })).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      if (!s.exited) invoke("pty_resize", { id, cols, rows }).catch(() => {});
    });

    this.select(s);
    fit.fit();

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "data") term.write(ev.data);
      else {
        s.exited = true;
        chip.classList.add("exited");
        term.write(`\r\n\x1b[90m[proceso terminado${ev.code != null ? ` con código ${ev.code}` : ""}]\x1b[0m\r\n`);
      }
    };
    try {
      await invoke("pty_spawn", {
        id, cwd, cols: term.cols, rows: term.rows,
        program: null, args: opts.args ?? ["-NoLogo"], env: this.host.env(), onEvent: channel,
      });
    } catch (e) {
      s.exited = true;
      term.write(`\x1b[31mNo se pudo abrir la terminal: ${e}\x1b[0m\r\n`);
    }
  }

  /**
   * Ctrl+V: si el portapapeles tiene una imagen (p. ej. una captura con Win+Shift+S), se guarda
   * como PNG temporal y se pega su ruta: Claude Code la adjunta como imagen. Si no, se pega el texto.
   */
  private async paste(term: Terminal) {
    try {
      const image = await invoke<string | null>("clipboard_image_to_file");
      if (image) {
        term.paste(quotePath(image) + " ");
        this.host.status("Imagen pegada en la terminal");
        return;
      }
    } catch (e) {
      console.error("[terminal] no se pudo leer la imagen del portapapeles", e);
    }
    try {
      term.paste(await navigator.clipboard.readText());
    } catch { /* portapapeles vacío o no disponible */ }
  }

  /** Pegar rutas (archivos arrastrados) en la terminal activa. Devuelve false si no hay terminal. */
  pastePaths(paths: string[]): boolean {
    const s = this.active;
    if (!s || s.exited || $("view-terminal").hidden || $("panel").hidden) return false;
    s.term.paste(paths.map(quotePath).join(" ") + " ");
    s.term.focus();
    return true;
  }

  /** ¿Está el punto (en píxeles CSS de la ventana) sobre la terminal visible? */
  isOverTerminal(x: number, y: number) {
    if ($("panel").hidden || $("view-terminal").hidden) return false;
    const r = $("term-host").getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  private select(s: Session) {
    this.active = s;
    for (const x of this.sessions) {
      x.el.hidden = x !== s;
      x.chip.classList.toggle("selected", x === s);
    }
    requestAnimationFrame(() => {
      this.fitActive();
      s.term.focus();
    });
  }

  close(s: Session) {
    if (!s.exited) invoke("pty_kill", { id: s.id }).catch(() => {});
    s.term.dispose();
    s.el.remove();
    s.chip.remove();
    const i = this.sessions.indexOf(s);
    this.sessions.splice(i, 1);
    if (this.active === s) {
      this.active = null;
      const next = this.sessions[i] ?? this.sessions[i - 1];
      if (next) this.select(next);
    }
  }

  private fitActive() {
    const s = this.active;
    if (!s || $("view-terminal").hidden || $("panel").hidden) return;
    try { s.fit.fit(); } catch { /* contenedor sin tamaño todavía */ }
  }
}
