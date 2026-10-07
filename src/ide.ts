import { invoke, Channel } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { pathToUri, uriToPath, samePath } from "./lsp";
import { reviewDiff, closeDiffs } from "./diffview";

/**
 * Servidor MCP que habla con el CLI `claude` (integración de IDE de Claude Code),
 * replicando las herramientas y notificaciones de la extensión oficial de VS Code.
 * Rust (src-tauri/src/ide.rs) solo transporta los mensajes por WebSocket.
 */

export interface IdeTab { path: string; state: EditorState; dirty: boolean; active: boolean; languageId: string }

export interface IdeDiagnostic {
  path: string;
  lines: number;
  items: { message: string; severity?: number; range: Range; source?: string; code?: string | number | { value: string | number } }[];
}

export interface IdeHost {
  view: EditorView;
  root(): string | null;
  tabs(): IdeTab[];
  activePath(): string | null;
  openFile(path: string): Promise<boolean>;
  save(path: string): Promise<boolean>;
  diagnostics(): IdeDiagnostic[];
  /** Muestra el Claude que estás usando (o abre uno) y devuelve su conexión, si se conoce. */
  focusClaude(): number | null;
  /** Número de sesiones de Claude conectadas (0 = ninguna). */
  onConnection(sessions: number): void;
  status(msg: string): void;
}

interface Pos { line: number; character: number }
interface Range { start: Pos; end: Pos }
interface SelectionInfo { text: string; filePath: string; fileUrl: string; selection: Range & { isEmpty: boolean } }

type IdeEvent =
  | { kind: "connected"; conn: number }
  | { kind: "disconnected"; conn: number }
  | { kind: "message"; conn: number; data: string };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const SEVERITY = ["", "Error", "Warning", "Information", "Hint"];

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const bool = (def: boolean, description?: string) => ({ type: "boolean", default: def, ...(description ? { description } : {}) });

const TOOLS = [
  {
    name: "openDiff",
    description: "Open a git diff for the file",
    inputSchema: obj({
      old_file_path: str("Path to the file to show diff for. If not provided, uses active editor."),
      new_file_path: str("Path to the file to show diff for. If not provided, uses active editor."),
      new_file_contents: str("Contents of the new file. If not provided, uses active editor."),
      tab_name: str("Name of the tab to show diff for. If not provided, uses active editor."),
    }, ["old_file_path", "new_file_path", "new_file_contents", "tab_name"]),
  },
  {
    name: "getDiagnostics",
    description: "Get language diagnostics from VS Code",
    inputSchema: obj({ uri: str("Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files.") }),
  },
  { name: "close_tab", inputSchema: obj({ tab_name: str() }, ["tab_name"]) },
  { name: "closeAllDiffTabs", description: "Close all diff tabs in the editor", inputSchema: obj() },
  {
    name: "openFile",
    description: "Open a file in the editor and optionally select a range of text",
    inputSchema: obj({
      filePath: str("Path to the file to open"),
      preview: bool(false, "Whether to open the file in preview mode"),
      startText: str("Text pattern to find the start of the selection range. Selects from the beginning of this match."),
      endText: str("Text pattern to find the end of the selection range. Selects up to the end of this match. If not provided, only the startText match will be selected."),
      selectToEndOfLine: bool(false, "If true, selection will extend to the end of the line containing the endText match."),
      makeFrontmost: bool(true, "Whether to make the file the active editor tab. If false, the file will be opened in the background without changing focus."),
    }, ["filePath"]),
    annotations: { readOnlyHint: true },
  },
  { name: "getOpenEditors", description: "Get information about currently open editors", inputSchema: obj() },
  { name: "getWorkspaceFolders", description: "Get all workspace folders currently open in the IDE", inputSchema: obj() },
  { name: "getCurrentSelection", description: "Get the current text selection in the active editor", inputSchema: obj() },
  { name: "checkDocumentDirty", description: "Check if a document has unsaved changes (is dirty)", inputSchema: obj({ filePath: str("Path to the file to check") }, ["filePath"]) },
  { name: "saveDocument", description: "Save a document with unsaved changes", inputSchema: obj({ filePath: str("Path to the file to save") }, ["filePath"]) },
  { name: "getLatestSelection", description: "Get the most recent text selection (even if not in the active editor)", inputSchema: obj() },
];

function posOf(state: EditorState, offset: number): Pos {
  const line = state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export class IdeBridge {
  /** Sesiones de `claude` conectadas ahora mismo (puede haber varias). */
  private clients = new Set<number>();
  private port = 0;
  private lastSelection: SelectionInfo | null = null;
  private lastSentSelection = "";
  private selectionTimer = 0;

  constructor(private host: IdeHost) {
    const channel = new Channel<IdeEvent>();
    channel.onmessage = (ev) => this.onEvent(ev);
    invoke<{ port: number; clients: number[] }>("ide_attach", { onEvent: channel }).then((info) => {
      this.port = info.port;
      info.clients.forEach((c) => this.clients.add(c));
      if (this.clients.size) this.host.onConnection(this.clients.size);
    }).catch((e) => console.error("[ide] no disponible:", e));
  }

  /** Variables para que `claude` arrancado en la terminal integrada se conecte solo. */
  terminalEnv(): Record<string, string> {
    return this.port ? { CLAUDE_CODE_SSE_PORT: String(this.port), ENABLE_IDE_INTEGRATION: "true" } : {};
  }

  private get connected() { return this.clients.size > 0; }
  get isConnected() { return this.connected; }

  setWorkspace(root: string) {
    invoke("ide_set_workspace", { folders: [root] }).catch(() => {});
  }

  // ---------- eventos y envío ----------

  private onEvent(ev: IdeEvent) {
    if (ev.kind === "connected") {
      this.clients.add(ev.conn);
      this.claim(ev.conn);
      this.host.onConnection(this.clients.size);
      // Como VS Code: al conectarse, la sesión nueva recibe la selección actual.
      setTimeout(() => this.sendSelection(ev.conn), 500);
    } else if (ev.kind === "disconnected") {
      this.clients.delete(ev.conn);
      this.host.onConnection(this.clients.size);
    } else {
      this.onMessage(ev.conn, ev.data);
    }
  }

  /** A una sesión concreta, o a todas si `conn` es null (notificaciones). */
  private send(conn: number | null, msg: object) {
    if (!this.connected) return;
    invoke("ide_send", { conn, message: JSON.stringify({ jsonrpc: "2.0", ...msg }) }).catch(() => {});
  }

  private notify(method: string, params: object, conn: number | null = null) {
    this.send(conn, { method, params });
  }

  private async onMessage(conn: number, raw: string) {
    let msg: { id?: number | string; method?: string; params?: any };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.method || msg.id === undefined) return; // respuestas o notificaciones del CLI: nada que hacer
    try {
      const result = await this.handle(msg.method, msg.params ?? {});
      this.send(conn, { id: msg.id, result });
    } catch (e: any) {
      this.send(conn, { id: msg.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e) } });
    }
  }

  private async handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Claude Code Editor Angular MCP", version: "0.1.0" },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        try {
          return await this.callTool(params.name, params.arguments ?? {});
        } catch (e: any) {
          return { ...text(e?.message ?? String(e)), isError: true };
        }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  // ---------- herramientas ----------

  private resolve(filePath: string): string {
    let p = filePath.startsWith("file://") ? uriToPath(filePath) : filePath;
    const root = this.host.root();
    const absolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
    if (!absolute && root) p = root + "\\" + p;
    p = p.replace(/\//g, "\\");
    return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
  }

  private tab(path: string) {
    return this.host.tabs().find((t) => samePath(t.path, path));
  }

  private async readDisk(path: string): Promise<string | null> {
    try { return await invoke<string>("read_file", { path }); } catch { return null; }
  }

  private async callTool(name: string, a: any): Promise<ToolResult> {
    switch (name) {
      case "openFile": return this.openFile(a);
      case "openDiff": return this.openDiff(a);
      case "getDiagnostics": return text(this.getDiagnostics(a.uri));
      case "close_tab": closeDiffs(a.tab_name); return text("TAB_CLOSED");
      case "closeAllDiffTabs": return text(`CLOSED_${closeDiffs()}_DIFF_TABS`);
      case "getOpenEditors": return text({ tabs: this.openEditors() });
      case "getWorkspaceFolders": {
        const root = this.host.root();
        return text({
          success: true,
          folders: root ? [{ name: root.split(/[\\/]/).pop(), uri: pathToUri(root), path: root, index: 0 }] : [],
          rootPath: root,
          workspaceFile: null,
        });
      }
      case "getCurrentSelection": {
        const sel = this.currentSelection();
        return text(sel ? { success: true, ...sel } : { success: false, message: "No active editor found" });
      }
      case "getLatestSelection":
        return text(this.lastSelection ?? { success: false, message: "No selection available" });
      case "checkDocumentDirty": {
        const path = this.resolve(a.filePath);
        const t = this.tab(path);
        return text(t ? { success: true, filePath: path, isDirty: t.dirty, isUntitled: false }
          : { success: false, message: `Document not open: ${path}` });
      }
      case "saveDocument": {
        const path = this.resolve(a.filePath);
        const t = this.tab(path);
        if (!t) return text({ success: false, message: `Document not open: ${path}` });
        const saved = t.dirty ? await this.host.save(t.path) : false;
        return text({ success: true, filePath: path, saved, message: saved ? "Document saved successfully" : "Document was not dirty or save failed" });
      }
      default:
        throw new Error(`Tool ${name} not found`);
    }
  }

  private async openFile(a: { filePath: string; startText?: string; endText?: string; selectToEndOfLine?: boolean; makeFrontmost?: boolean }): Promise<ToolResult> {
    const path = this.resolve(a.filePath);
    if (a.makeFrontmost === false) {
      const t = this.tab(path);
      const contents = t ? null : await this.readDisk(path);
      if (!t && contents === null) throw new Error(`File not found: ${path}`);
      return text({
        success: true, filePath: path, fileUrl: pathToUri(path), message: `Opened file: ${path}`,
        languageId: t?.languageId ?? "", lineCount: t ? t.state.doc.lines : contents!.split(/\r?\n/).length,
        isDirty: t?.dirty ?? false, isUntitled: false, isClosed: false,
      });
    }
    if (!(await this.host.openFile(path))) throw new Error(`File not found: ${path}`);
    if (!a.startText) return text(`Opened file: ${path}`);

    const view = this.host.view;
    const doc = view.state.doc.toString();
    const from = doc.indexOf(a.startText);
    if (from < 0) return text(`Opened file: ${path} (text "${a.startText}" not found)`);
    let to = from + a.startText.length;
    if (a.endText) {
      const end = doc.indexOf(a.endText, to);
      if (end >= 0) to = end + a.endText.length;
    }
    if (a.selectToEndOfLine) to = view.state.doc.lineAt(to).to;
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
    return text(`Opened file and selected text "${view.state.sliceDoc(from, to).slice(0, 200)}"`);
  }

  private async openDiff(a: { old_file_path: string; new_file_path: string; new_file_contents: string; tab_name: string }): Promise<ToolResult> {
    const oldPath = this.resolve(a.old_file_path);
    const newPath = this.resolve(a.new_file_path);
    const open = this.tab(oldPath);
    const oldContents = open ? open.state.doc.toString() : (await this.readDisk(oldPath)) ?? "";
    const root = this.host.root();
    const rel = root && newPath.toLowerCase().startsWith(root.toLowerCase()) ? newPath.slice(root.length + 1) : newPath;
    this.host.status(`Claude propone cambios en ${rel}`);
    const r = await reviewDiff({
      oldPath, newPath, oldContents, newContents: a.new_file_contents, tabName: a.tab_name,
      title: oldContents ? rel : `${rel} (archivo nuevo)`,
    });
    this.host.status(r.accepted ? `Cambios aceptados en ${rel}` : `Cambios rechazados en ${rel}`);
    return r.accepted
      ? { content: [{ type: "text", text: "FILE_SAVED" }, { type: "text", text: r.contents }] }
      : { content: [{ type: "text", text: "DIFF_REJECTED" }, { type: "text", text: a.tab_name }] };
  }

  private getDiagnostics(uri?: string) {
    const only = uri ? uriToPath(uri) : null;
    return this.host.diagnostics()
      .filter((d) => !only || samePath(d.path, only))
      .map((d) => ({
        uri: pathToUri(d.path),
        linesInFile: d.lines,
        diagnostics: d.items.map((i) => ({
          message: i.message,
          severity: SEVERITY[i.severity ?? 1] || "Error",
          range: i.range,
          source: i.source,
          ...(i.code != null ? { code: String(typeof i.code === "object" ? i.code.value : i.code) } : {}),
        })),
      }));
  }

  private openEditors() {
    return this.host.tabs().map((t) => {
      const sel = t.state.selection.main;
      return {
        uri: pathToUri(t.path),
        isActive: t.active,
        isPinned: false,
        isPreview: false,
        isDirty: t.dirty,
        label: t.path.split(/[\\/]/).pop(),
        groupIndex: 0,
        viewColumn: 1,
        isGroupActive: true,
        fileName: t.path,
        languageId: t.languageId,
        lineCount: t.state.doc.lines,
        isUntitled: false,
        ...(t.active ? { selection: { start: posOf(t.state, sel.from), end: posOf(t.state, sel.to), isReversed: sel.head < sel.anchor } } : {}),
      };
    });
  }

  // ---------- selección y menciones ----------

  private currentSelection(): SelectionInfo | null {
    const path = this.host.activePath();
    if (!path) return null;
    const state = this.host.view.state;
    const r = state.selection.main;
    return {
      text: state.sliceDoc(r.from, r.to),
      filePath: path,
      fileUrl: pathToUri(path),
      selection: { start: posOf(state, r.from), end: posOf(state, r.to), isEmpty: r.empty },
    };
  }

  /** Llamar cuando cambia la selección o la pestaña activa (se agrupa cada 300 ms, como VS Code). */
  selectionChanged() {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.sendSelection(), 300);
  }

  /** Selección actual a todas las sesiones (o solo a `conn`, p. ej. a una que acaba de conectarse). */
  private sendSelection(conn: number | null = null) {
    const sel = this.currentSelection();
    if (!sel) return;
    this.lastSelection = sel;
    const key = JSON.stringify(sel);
    if (!this.connected) return;
    if (conn === null) {
      if (key === this.lastSentSelection) return;
      this.lastSentSelection = key;
    }
    this.notify("selection_changed", sel, conn);
  }

  // ---------- qué conexión es de qué terminal ----------

  private pendingClaims: ((conn: number) => void)[] = [];
  private lastConnected: number | null = null;

  /**
   * Una terminal que acaba de lanzar `claude` se queda con la próxima conexión que llegue.
   * Así Ctrl+Alt+K menciona en el Claude que estás usando y no en todos.
   */
  expectConnection(claim: (conn: number) => void) {
    this.pendingClaims.push(claim);
    // Si en un minuto no se conectó (p. ej. Claude pidió confirmar la carpeta), no bloquear a otras.
    setTimeout(() => { this.pendingClaims = this.pendingClaims.filter((c) => c !== claim); }, 60_000);
  }

  private claim(conn: number) {
    this.lastConnected = conn;
    this.pendingClaims.shift()?.(conn);
  }

  /** Ctrl+Alt+K: menciona el archivo (y las líneas seleccionadas) en el Claude que estás usando. */
  atMention() {
    const sel = this.currentSelection();
    if (!sel) return this.host.status("Abre un archivo para mencionarlo a Claude");
    const target = this.host.focusClaude();
    if (!this.connected) {
      return this.host.status("Claude Code no está conectado todavía: vuelve a pulsar Ctrl+Alt+K cuando arranque");
    }
    const conn = target != null && this.clients.has(target) ? target : this.lastConnected;
    const params: { filePath: string; lineStart?: number; lineEnd?: number } = { filePath: sel.filePath };
    if (!sel.selection.isEmpty) {
      params.lineStart = sel.selection.start.line;
      params.lineEnd = sel.selection.end.line;
    }
    this.notify("at_mentioned", params, conn !== null && this.clients.has(conn) ? conn : null);
    const lines = params.lineStart != null ? `#L${params.lineStart + 1}-${params.lineEnd! + 1}` : "";
    this.host.status(`Enviado a Claude: ${sel.filePath.split(/[\\/]/).pop()}${lines}`);
  }

  diagnosticsChanged(path: string) {
    if (this.connected) this.notify("diagnostics_changed", { uris: [pathToUri(path)] });
  }
}
