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
  /** La próxima conexión de Claude Code que llegue será la de esta terminal. */
  expectClaudeConnection(claim: (conn: number) => void): void;
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
  /** Terminal que ejecuta Claude Code, y su conexión con el editor si ya se conectó. */
  claude: boolean;
  conn: number | null;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Rutas con espacios entre comillas, para que la shell y Claude las lean enteras. */
const quotePath = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** Paneles visibles a la vez, lado a lado. */
const MAX_PANES = 3;
const CLAUDE_ARGS = ["-NoLogo", "-NoExit", "-Command", "claude"];

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
  /** Sesiones que se ven ahora mismo, de izquierda a derecha. */
  private visible: Session[] = [];
  private active: Session | null = null;
  private lastClaude: Session | null = null;
  private counter = 0;
  private claudeCounter = 0;
  private creating = false;

  constructor(private host: TerminalHost) {
    // Terminales de una carga anterior de la interfaz.
    invoke("pty_kill_all");
    $("term-new").addEventListener("click", () => this.create());
    $("term-claude").addEventListener("click", () => this.newClaude());
    $("term-split").addEventListener("click", () => this.split());
    onPanelView((v) => { if (v === "terminal") this.onShown(); });
    new ResizeObserver(() => this.fitVisible()).observe($("term-host"));
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
      this.fitVisible();
      this.active?.term.focus();
    }
  }

  /** Botón ✳ Claude del panel: siempre una sesión nueva (puede haber varias a la vez). */
  newClaude(opts: { split?: boolean } = {}) {
    return this.create({ claude: true, split: opts.split });
  }

  /**
   * Barra de estado / Ctrl+Alt+K: ir al Claude que estabas usando (o abrir uno).
   * Devuelve su conexión con el editor, si ya se conoce.
   */
  openClaude(): number | null {
    const target = (this.active?.claude && !this.active.exited ? this.active : null)
      ?? (this.lastClaude && !this.lastClaude.exited ? this.lastClaude : null)
      ?? this.sessions.find((s) => s.claude && !s.exited) ?? null;
    if (!target) {
      this.newClaude();
      return null;
    }
    showPanel("terminal");
    this.select(target);
    return target.conn;
  }

  /** ⫽ Dividir: otra terminal del mismo tipo que la activa, al lado. */
  split() {
    if (this.visible.length >= MAX_PANES) return this.host.status(`Como máximo ${MAX_PANES} paneles lado a lado`);
    return this.create({ claude: this.active?.claude ?? false, split: true });
  }

  async create(opts: { claude?: boolean; split?: boolean } = {}) {
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

  private async createSession(cwd: string, opts: { claude?: boolean; split?: boolean }) {
    const { Terminal, FitAddon, WebLinksAddon } = await loadXterm();

    const id = `term-${Date.now()}-${++this.counter}`;
    const claude = !!opts.claude;
    const title = claude
      ? (++this.claudeCounter === 1 ? "Claude" : `Claude ${this.claudeCounter}`)
      : `Terminal ${this.counter}`;
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

    const s: Session = { id, title, term, fit, el, chip, exited: false, writes: Promise.resolve(), claude, conn: null };
    this.sessions.push(s);
    if (claude) {
      chip.classList.add("claude-chip");
      this.host.expectClaudeConnection((conn) => { s.conn = conn; });
    }
    // Clic dentro de un panel lo convierte en el activo (para Ctrl+V, arrastrar archivos, Ctrl+Alt+K…).
    el.addEventListener("mousedown", () => { if (this.active !== s) this.focusPane(s); });
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

    if (opts.split && this.visible.length && this.visible.length < MAX_PANES) {
      this.visible.push(s);
      this.focusPane(s);
    } else {
      this.select(s);
    }
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
        program: null, args: claude ? CLAUDE_ARGS : ["-NoLogo"], env: this.host.env(), onEvent: channel,
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

  /** Mostrar `s`: si ya se ve, solo se enfoca; si no, ocupa el panel activo. */
  private select(s: Session) {
    if (!this.visible.includes(s)) {
      const slot = this.active ? this.visible.indexOf(this.active) : -1;
      if (slot >= 0) this.visible[slot] = s;
      else this.visible = [s];
    }
    this.focusPane(s);
  }

  private focusPane(s: Session) {
    this.active = s;
    if (s.claude) this.lastClaude = s;
    this.layout();
    requestAnimationFrame(() => {
      this.fitVisible();
      s.term.focus();
    });
  }

  /** Paneles visibles en orden, el activo resaltado; los demás ocultos. */
  private layout() {
    for (const x of this.sessions) {
      const pos = this.visible.indexOf(x);
      x.el.hidden = pos < 0;
      x.el.style.order = String(pos);
      x.el.classList.toggle("focused", x === this.active && this.visible.length > 1);
      x.chip.classList.toggle("selected", x === this.active);
      x.chip.classList.toggle("shown", pos >= 0);
    }
    $("term-host").classList.toggle("split", this.visible.length > 1);
    ($("term-split") as HTMLButtonElement).disabled = !this.active || this.visible.length >= MAX_PANES;
  }

  close(s: Session) {
    if (!s.exited) invoke("pty_kill", { id: s.id }).catch(() => {});
    s.term.dispose();
    s.el.remove();
    s.chip.remove();
    const i = this.sessions.indexOf(s);
    this.sessions.splice(i, 1);
    const pane = this.visible.indexOf(s);
    if (pane >= 0) this.visible.splice(pane, 1);
    if (this.lastClaude === s) this.lastClaude = null;
    if (this.active === s) {
      this.active = null;
      const next = this.visible[Math.max(0, pane - 1)] ?? this.sessions[i] ?? this.sessions[i - 1];
      if (next) this.select(next);
      else this.layout();
    } else {
      this.layout();
      this.fitVisible();
    }
  }

  private fitVisible() {
    if ($("view-terminal").hidden || $("panel").hidden) return;
    for (const s of this.visible) {
      try { s.fit.fit(); } catch { /* contenedor sin tamaño todavía */ }
    }
  }
}
