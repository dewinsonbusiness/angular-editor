import { EditorState, Facet, type Extension } from "@codemirror/state";
import { snippetCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

/**
 * Plantillas Angular (.html): bloques de control flow al escribir "@" y Emmet con Tab
 * (por ejemplo "div" → <div></div>, "ul>li*3" → la lista completa), como en VS Code.
 */

// ---------- control flow (@if, @for, @switch, @defer, @let) ----------

const BLOCKS = [
  snippetCompletion("@if (${condición}) {\n\t${}\n}", {
    label: "@if", detail: "bloque condicional", type: "keyword", boost: 10,
  }),
  snippetCompletion("@if (${condición}) {\n\t${}\n} @else {\n\t${}\n}", {
    label: "@if … @else", detail: "condicional con alternativa", type: "keyword", boost: 9,
  }),
  snippetCompletion("@else {\n\t${}\n}", { label: "@else", detail: "alternativa", type: "keyword" }),
  snippetCompletion("@else if (${condición}) {\n\t${}\n}", { label: "@else if", detail: "otra condición", type: "keyword" }),
  snippetCompletion("@for (${item} of ${items}; track ${item}.${id}) {\n\t${}\n}", {
    label: "@for", detail: "repetir por cada elemento", type: "keyword", boost: 10,
  }),
  snippetCompletion("@for (${item} of ${items}; track ${item}.${id}) {\n\t${}\n} @empty {\n\t${Sin elementos}\n}", {
    label: "@for … @empty", detail: "repetir, con contenido si está vacío", type: "keyword", boost: 9,
  }),
  snippetCompletion("@empty {\n\t${}\n}", { label: "@empty", detail: "si la lista está vacía", type: "keyword" }),
  snippetCompletion("@switch (${expresión}) {\n\t@case (${valor}) {\n\t\t${}\n\t}\n\t@default {\n\t\t${}\n\t}\n}", {
    label: "@switch", detail: "elegir entre casos", type: "keyword", boost: 8,
  }),
  snippetCompletion("@case (${valor}) {\n\t${}\n}", { label: "@case", detail: "caso de @switch", type: "keyword" }),
  snippetCompletion("@default {\n\t${}\n}", { label: "@default", detail: "caso por defecto", type: "keyword" }),
  snippetCompletion("@defer (on ${viewport}) {\n\t${}\n} @placeholder {\n\t${}\n}", {
    label: "@defer", detail: "carga diferida", type: "keyword", boost: 7,
  }),
  snippetCompletion("@placeholder {\n\t${}\n}", { label: "@placeholder", detail: "mientras no carga @defer", type: "keyword" }),
  snippetCompletion("@loading {\n\t${}\n}", { label: "@loading", detail: "mientras carga @defer", type: "keyword" }),
  snippetCompletion("@error {\n\t${}\n}", { label: "@error", detail: "si falla @defer", type: "keyword" }),
  snippetCompletion("@let ${nombre} = ${valor};", { label: "@let", detail: "variable de plantilla", type: "keyword", boost: 6 }),
];

function controlFlow(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/@[\w ]*$/);
  if (!before || /\s\S/.test(before.text.slice(1)) && !context.explicit) return null;
  const at = context.state.sliceDoc(before.from, before.from + 1);
  if (at !== "@") return null;
  // Solo en texto de la plantilla, no dentro de una etiqueta, atributo o {{ }}.
  const node = syntaxTree(context.state).resolveInner(before.from, 1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (/Tag|Attribute|Interpolation|Comment/.test(n.name)) return null;
  }
  return { from: before.from, options: BLOCKS, validFor: /^@[\w ]*$/ };
}

// ---------- Emmet ----------

/** Etiquetas HTML conocidas: "div" + Tab es Emmet; "hola" + Tab no (sería Claude). */
const TAGS = new Set(("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite " +
  "code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form " +
  "h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta " +
  "meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section " +
  "select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title " +
  "tr track u ul var video wbr svg path ng-container ng-template ng-content router-outlet").split(" "));

/** Componentes del proyecto (selectores), para que "app-todo" + Tab también se expanda. */
let projectSelectors = new Set<string>();
export function setProjectSelectors(selectors: Iterable<string>) {
  projectSelectors = new Set(selectors);
}

/** ¿Hay una abreviatura Emmet razonable justo antes del cursor, en texto de la plantilla? */
export function emmetAbbreviationAt(state: EditorState): boolean {
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const before = state.sliceDoc(line.from, sel.head);
  const m = /(?:^|[\s>])([a-zA-Z!][\w\-:]*(?:[.#>+*^\[\]{}()$@=\w\-:"' ]*?))$/.exec(before);
  if (!m) return false;
  const abbr = m[1];
  if (abbr.includes("{{") || /\s/.test(abbr.replace(/\{[^}]*\}|\[[^\]]*\]/g, ""))) return false;
  const first = /^[a-zA-Z!][\w\-:]*/.exec(abbr)![0].toLowerCase();
  const hasOperators = /[.#>+*^\[{(]/.test(abbr);
  if (!(TAGS.has(first) || projectSelectors.has(first) || first === "!" || (hasOperators && /^[a-z]/.test(first)))) return false;
  // Solo en texto de la plantilla (no dentro de una etiqueta, atributo o {{ }}).
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(sel.head, -1); n; n = n.parent) {
    if (/^(StartTag|EndTag|SelfClosingTag|TagName|Attribute|AttributeValue|Interpolation|Comment)$/.test(n.name)) return false;
    if (n.name === "Element" || n.name === "Document" || n.name === "Text") break;
  }
  return true;
}

/**
 * Expande la abreviatura Emmet antes del cursor. Emmet (~110 KB) se carga la primera vez que
 * se usa, no al abrir el editor. Su sintaxis por defecto ya es HTML.
 */
let emmet: Promise<typeof import("@emmetio/codemirror6-plugin")> | null = null;
export function expandAbbreviation(view: EditorView): boolean {
  (emmet ??= import("@emmetio/codemirror6-plugin"))
    .then((m) => {
      if (!m.expandAbbreviation(view)) emmetStatus("Emmet no reconoció la abreviatura");
    })
    .catch((e) => {
      emmet = null; // reintentar la carga la próxima vez
      emmetStatus(`Emmet no se pudo cargar: ${e?.message ?? e}`);
    });
  return true;
}

let emmetStatus: (msg: string) => void = (msg) => console.warn(msg);
/** Dónde mostrar los avisos de Emmet (barra de estado). */
export function setEmmetStatus(fn: (msg: string) => void) {
  emmetStatus = fn;
}

/** "div → Emmet" en la lista de sugerencias, como en VS Code (Tab o Enter lo expanden). */
function emmetSuggestion(context: CompletionContext): CompletionResult | null {
  if (!emmetAbbreviationAt(context.state)) return null;
  const word = context.matchBefore(/[^\s>]+$/);
  if (!word || word.text.includes("{{")) return null;
  return {
    from: word.from,
    options: [{
      label: word.text,
      detail: "Emmet",
      type: "keyword",
      boost: 99,
      apply: (view) => { expandAbbreviation(view); },
    }],
    filter: false,
  };
}

/** Marca los documentos que son plantillas Angular (para que Tab pruebe Emmet). */
export const isAngularTemplate = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

/** Extensiones para archivos .html de Angular. */
export const angularTemplateTools: Extension = [
  isAngularTemplate.of(true),
  EditorState.languageData.of(() => [{ autocomplete: controlFlow }, { autocomplete: emmetSuggestion }]),
];
