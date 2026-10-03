import { invoke, Channel } from "@tauri-apps/api/core";
import { EditorView, keymap, showDialog } from "@codemirror/view";
import { ChangeSet, Text, type EditorState, type Extension, type ChangeSpec } from "@codemirror/state";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  LSPClient, LSPPlugin, Workspace, type WorkspaceFile, type Transport,
  serverCompletion, hoverTooltips, signatureHelp, serverDiagnostics,
  formatKeymap,
} from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";

/** Lo que el módulo LSP necesita del editor (pestañas, vista, estado). */
export interface EditorHost {
  view: EditorView;
  activePath(): string | null;
  openPath(path: string): Promise<void>;
  tabState(path: string): EditorState | null;
  setTabState(path: string, state: EditorState): void;
  markProblems(path: string, errors: number, warnings: number): void;
  showLocations(title: string, items: Location[]): void;
  status(msg: string): void;
}

export interface Location { path: string; line: number; col: number; text: string }

type Kind = "typescript" | "angular";

// ---------- rutas <-> URIs (mismo formato que vscode-uri: file:///c%3A/...) ----------

export function pathToUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  let prefix = "";
  const m = /^([A-Za-z]):(.*)$/.exec(p);
  if (m) { prefix = "/" + m[1].toLowerCase() + "%3A"; p = m[2]; }
  return "file://" + prefix + p.split("/").map(encodeURIComponent).join("/");
}

export function uriToPath(uri: string): string {
  let s = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[A-Za-z]:/.test(s)) s = (s[1].toUpperCase() + s.slice(2)).replace(/\//g, "\\");
  return s;
}

export const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uriKey = (uri: string) => uriToPath(uri).toLowerCase();

function offsetAt(doc: Text, pos: lsp.Position): number {
  const line = doc.line(Math.min(pos.line + 1, doc.lines));
  return Math.min(line.from + pos.character, line.to);
}

// ---------- workspace: los archivos siguen abiertos en el servidor mientras su pestaña exista ----------

class TabFile implements WorkspaceFile {
  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    public doc: Text,
    private ws: TabWorkspace,
  ) {}
  getView() { return this.ws.viewFor(this.uri); }
}

class TabWorkspace extends Workspace {
  files: TabFile[] = [];

  constructor(client: LSPClient, private host: EditorHost) { super(client); }

  viewFor(uri: string): EditorView | null {
    const plugin = LSPPlugin.get(this.host.view);
    return plugin && uriKey(plugin.uri) === uriKey(uri) ? this.host.view : null;
  }

  getFile(uri: string) {
    const k = uriKey(uri);
    return this.files.find((f) => uriKey(f.uri) === k) ?? null;
  }

  syncFiles() {
    const result = [];
    for (const file of this.files) {
      const view = file.getView();
      const plugin = view && LSPPlugin.get(view);
      if (!view || !plugin || plugin.unsyncedChanges.empty) continue;
      result.push({ file, prevDoc: file.doc, changes: plugin.unsyncedChanges });
      file.doc = view.state.doc;
      file.version++;
      plugin.clear();
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const existing = this.getFile(uri);
    if (!existing) {
      const file = new TabFile(uri, languageId, 0, view.state.doc, this);
      this.files.push(file);
      this.client.didOpen(file);
    } else if (!existing.doc.eq(view.state.doc)) {
      this.pushFull(existing, view.state.doc);
    }
  }

  // Cambiar de pestaña destruye el plugin pero el archivo sigue abierto; se cierra en release().
  closeFile() {}

  release(uri: string) {
    const file = this.getFile(uri);
    if (!file) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(file.uri);
  }

  pushFull(file: TabFile, doc: Text) {
    file.version++;
    file.doc = doc;
    this.client.notification<lsp.DidChangeTextDocumentParams>("textDocument/didChange", {
      textDocument: { uri: file.uri, version: file.version },
      contentChanges: [{ text: doc.toString() }],
    });
  }

  async displayFile(uri: string) {
    const path = uriToPath(uri);
    await this.host.openPath(path);
    const active = this.host.activePath();
    return active && samePath(active, path) ? this.host.view : null;
  }
}

// ---------- transporte: mensajes JSON por IPC de Tauri, en orden ----------

async function startTransport(
  id: string, kind: Kind, root: string,
  answer: (method: string, params: any) => Promise<unknown>,
  onExit: () => void,
): Promise<Transport> {
  const handlers = new Set<(msg: string) => void>();
  let queue: string[] = [];
  let chain = Promise.resolve();

  const flush = () => {
    const messages = queue;
    queue = [];
    chain = chain
      .then(() => invoke<void>("lsp_send", { id, messages }))
      .catch((e) => console.error(`[lsp ${id}]`, e));
  };

  const transport: Transport = {
    send(msg) {
      queue.push(msg);
      if (queue.length === 1) queueMicrotask(flush);
    },
    subscribe: (h) => void handlers.add(h),
    unsubscribe: (h) => void handlers.delete(h),
  };

  const channel = new Channel<string>();
  channel.onmessage = async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === "$/editor/exited") { onExit(); return; }
    // Peticiones del servidor al cliente: el cliente de CodeMirror no las atiende.
    if (msg.method && msg.id !== undefined) {
      let result: unknown = null;
      try { result = await answer(msg.method, msg.params); } catch (e) { console.error(e); }
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      return;
    }
    for (const h of handlers) h(raw);
  };

  await invoke("lsp_start", { id, kind, root, onMessage: channel });
  return transport;
}

// ---------- gestor ----------

interface Server { kind: Kind; client: LSPClient; ws: TabWorkspace }

const SEVERITY = ["error", "error", "warning", "info", "hint"] as const;

export class LspManager {
  private servers = new Map<Kind, Server>();
  private diagnostics = new Map<string, { doc: Text; items: lsp.Diagnostic[] }>();
  private generation = 0;

  constructor(private host: EditorHost) {}

  async start(root: string) {
    this.stop();
    const gen = this.generation;
    for (const kind of ["typescript", "angular"] as Kind[]) {
      const id = `${kind}-${gen}`;
      try {
        const transport = await startTransport(
          id, kind, root,
          (method, params) => this.answer(method, params),
          () => { if (gen === this.generation) this.host.status(`El servidor ${kind} se detuvo`); },
        );
        if (gen !== this.generation) return void invoke("lsp_stop", { id });
        let ws!: TabWorkspace;
        const client = new LSPClient({
          rootUri: pathToUri(root),
          timeout: kind === "angular" ? 20000 : 10000,
          workspace: (c) => (ws = new TabWorkspace(c, this.host)),
          sanitizeHTML: (html) => html.replace(/<(script|iframe|object)[\s\S]*?<\/\1>/gi, ""),
          notificationHandlers: {
            "textDocument/publishDiagnostics": (c, p) => this.onDiagnostics(c, p),
            "angular/projectLoadingStart": () => (this.host.status("Angular: cargando proyecto…"), true),
            "angular/projectLoadingFinish": () => (this.host.status("Angular: listo"), true),
          },
          unhandledNotification: () => {},
          extensions: [
            serverCompletion(),
            hoverTooltips(),
            signatureHelp(),
            serverDiagnostics(),
            keymap.of([
              ...formatKeymap,
              { key: "F2", run: (v) => this.rename(v), preventDefault: true },
              { key: "Shift-F12", run: (v) => this.references(v), preventDefault: true },
            ]),
          ],
        }).connect(transport);
        this.servers.set(kind, { kind, client, ws });
        client.initializing.then(
          () => kind === "typescript" && this.host.status("TypeScript: listo"),
          (e) => this.host.status(`Error iniciando ${kind}: ${e?.message ?? e}`),
        );
      } catch (e) {
        this.host.status(`No se pudo iniciar ${kind}: ${e}`);
      }
    }
  }

  stop() {
    this.generation++;
    for (const [kind, s] of this.servers) {
      s.client.disconnect();
      invoke("lsp_stop", { id: `${kind}-${this.generation - 1}` });
    }
    this.servers.clear();
    this.diagnostics.clear();
  }

  private kindFor(path: string): Kind | null {
    const p = path.toLowerCase();
    if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(p)) return "typescript";
    if (p.endsWith(".html")) return "angular";
    return null;
  }

  /** Extensión LSP para un archivo, o nada si no hay servidor para él. */
  extensionFor(path: string): Extension {
    const kind = this.kindFor(path);
    const server = kind && this.servers.get(kind);
    if (!server) return [];
    const p = path.toLowerCase();
    const languageId = p.endsWith(".html") ? "html" : /\.[mc]?js$/.test(p) ? "javascript" : "typescript";
    return server.client.plugin(pathToUri(path), languageId);
  }

  /** Enviar cambios pendientes antes de cambiar de pestaña. */
  syncAll() {
    for (const s of this.servers.values()) s.client.sync();
  }

  release(path: string) {
    const uri = pathToUri(path);
    for (const s of this.servers.values()) s.ws.release(uri);
    this.diagnostics.delete(path.toLowerCase());
  }

  afterActivate() {
    this.applyDiagnostics();
  }

  // ---------- diagnósticos ----------

  private onDiagnostics(client: LSPClient, params: lsp.PublishDiagnosticsParams): boolean {
    const file = client.workspace.getFile(params.uri);
    if (!file || (params.version != null && params.version !== file.version)) return true;
    const path = uriToPath(params.uri);
    this.diagnostics.set(path.toLowerCase(), { doc: file.doc, items: params.diagnostics });
    const count = (sev: number) => params.diagnostics.filter((d) => (d.severity ?? 1) === sev).length;
    this.host.markProblems(path, count(1), count(2));
    const active = this.host.activePath();
    if (active && samePath(active, path)) this.applyDiagnostics();
    return true;
  }

  private applyDiagnostics() {
    const view = this.host.view;
    const plugin = LSPPlugin.get(view);
    if (!plugin) return;
    const stored = this.diagnostics.get(uriKey(plugin.uri));
    if (stored && !stored.doc.eq(plugin.syncedDoc)) return; // obsoletos; llegarán nuevos
    const map = (p: lsp.Position) => plugin.unsyncedChanges.mapPos(offsetAt(plugin.syncedDoc, p));
    const items: Diagnostic[] = (stored?.items ?? []).map((d) => ({
      from: map(d.range.start),
      to: map(d.range.end),
      severity: SEVERITY[d.severity ?? 1],
      source: d.source,
      message: typeof d.message === "string" ? d.message : d.message.value,
    }));
    view.dispatch(setDiagnostics(view.state, items));
  }

  // ---------- peticiones del servidor al cliente ----------

  private async answer(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "workspace/configuration":
        return (params?.items ?? []).map(() => null);
      case "workspace/applyEdit":
        await this.applyWorkspaceEdit(params.edit);
        return { applied: true };
      default: // registerCapability, workDoneProgress/create, etc.
        return null;
    }
  }

  // ---------- ediciones en varios archivos (renombrar, acciones de código) ----------

  async applyWorkspaceEdit(edit: lsp.WorkspaceEdit): Promise<number> {
    const byPath = new Map<string, { path: string; edits: lsp.TextEdit[] }>();
    const add = (uri: string, edits: lsp.TextEdit[]) => {
      const path = uriToPath(uri);
      const entry = byPath.get(path.toLowerCase()) ?? { path, edits: [] };
      entry.edits.push(...edits);
      byPath.set(path.toLowerCase(), entry);
    };
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
    for (const dc of edit.documentChanges ?? []) {
      if ("edits" in dc) add(dc.textDocument.uri, dc.edits as lsp.TextEdit[]);
    }

    const toChanges = (doc: Text, edits: lsp.TextEdit[]): ChangeSpec[] =>
      edits.map((e) => ({ from: offsetAt(doc, e.range.start), to: offsetAt(doc, e.range.end), insert: e.newText }));

    const onDisk: string[] = [];
    for (const { path, edits } of byPath.values()) {
      const active = this.host.activePath();
      if (active && samePath(active, path)) {
        const view = this.host.view;
        view.dispatch({ changes: toChanges(view.state.doc, edits), userEvent: "rename" });
        continue;
      }
      const state = this.host.tabState(path);
      if (state) {
        const next = state.update({ changes: toChanges(state.doc, edits) }).state;
        this.host.setTabState(path, next);
        const uri = pathToUri(path);
        for (const s of this.servers.values()) {
          const file = s.ws.getFile(uri);
          if (file) s.ws.pushFull(file as TabFile, next.doc);
        }
        continue;
      }
      // Archivo no abierto: se edita en disco respetando sus finales de línea.
      const text = await invoke<string>("read_file", { path });
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const doc = Text.of(text.split(/\r\n|\n/));
      const next = ChangeSet.of(toChanges(doc, edits), doc.length).apply(doc);
      await invoke("write_file", { path, contents: next.sliceString(0, next.length, eol) });
      onDisk.push(pathToUri(path));
    }
    if (onDisk.length) {
      for (const s of this.servers.values()) {
        s.client.notification<lsp.DidChangeWatchedFilesParams>("workspace/didChangeWatchedFiles", {
          changes: onDisk.map((uri) => ({ uri, type: 2 })),
        });
      }
    }
    return byPath.size;
  }

  /** Pide la definición al servidor y la abre. Devuelve false si no hay ninguna. */
  async goToDefinition(view: EditorView, pos: number): Promise<boolean> {
    const plugin = LSPPlugin.get(view);
    if (!plugin) return false;
    plugin.client.sync();
    let result: lsp.Location | lsp.Location[] | lsp.LocationLink[] | null;
    try {
      result = await plugin.client.request<lsp.DefinitionParams, typeof result>("textDocument/definition", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(pos),
      });
    } catch {
      return false;
    }
    const first = Array.isArray(result) ? result[0] : result;
    if (!first) return false;
    const [uri, start] = "targetUri" in first
      ? [first.targetUri, first.targetSelectionRange.start]
      : [first.uri, first.range.start];
    await this.host.openPath(uriToPath(uri));
    const target = this.host.view;
    const at = offsetAt(target.state.doc, start);
    target.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    return true;
  }

  private rename(view: EditorView): boolean {
    const plugin = LSPPlugin.get(view);
    const word = view.state.wordAt(view.state.selection.main.head);
    if (!plugin || !word) return false;
    const old = view.state.sliceDoc(word.from, word.to);
    const { close, result } = showDialog(view, {
      label: "Nuevo nombre",
      input: { name: "name", value: old },
      focus: true,
      submitLabel: "Renombrar",
      class: "cm-lsp-rename-panel",
    });
    result.then(async (form) => {
      view.dispatch({ effects: close });
      const name = (form?.elements.namedItem("name") as HTMLInputElement | null)?.value.trim();
      if (!name || name === old) return;
      plugin.client.sync();
      try {
        const edit = await plugin.client.request<lsp.RenameParams, lsp.WorkspaceEdit | null>("textDocument/rename", {
          textDocument: { uri: plugin.uri },
          position: plugin.toPosition(word.from),
          newName: name,
        });
        if (!edit) return this.host.status("Este símbolo no se puede renombrar");
        const n = await this.applyWorkspaceEdit(edit);
        this.host.status(`Renombrado «${old}» → «${name}» en ${n} archivo(s)`);
      } catch (e: any) {
        this.host.status(`Error al renombrar: ${e?.message ?? e}`);
      }
    });
    return true;
  }

  private references(view: EditorView): boolean {
    const plugin = LSPPlugin.get(view);
    if (!plugin) return false;
    plugin.client.sync();
    plugin.client
      .request<lsp.ReferenceParams, lsp.Location[] | null>("textDocument/references", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(view.state.selection.main.head),
        context: { includeDeclaration: true },
      })
      .then(async (locs) => {
        if (!locs?.length) return this.host.status("Sin referencias");
        const docs = new Map<string, Promise<Text>>();
        const docFor = (path: string) => {
          const key = path.toLowerCase();
          if (!docs.has(key)) {
            const state = this.host.tabState(path);
            docs.set(key, state ? Promise.resolve(state.doc)
              : invoke<string>("read_file", { path }).then((t) => Text.of(t.split(/\r\n|\n/))));
          }
          return docs.get(key)!;
        };
        const items = await Promise.all(locs.map(async (l) => {
          const path = uriToPath(l.uri);
          const doc = await docFor(path).catch(() => Text.empty);
          const line = l.range.start.line + 1;
          return {
            path, line, col: l.range.start.character,
            text: line <= doc.lines ? doc.line(line).text.trim() : "",
          };
        }));
        this.host.showLocations(`${items.length} referencias`, items);
      })
      .catch((e) => this.host.status(`Error buscando referencias: ${e?.message ?? e}`));
    return true;
  }
}
