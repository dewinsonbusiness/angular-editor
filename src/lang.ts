import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { angular } from "@codemirror/lang-angular";
import { css } from "@codemirror/lang-css";
import { sass } from "@codemirror/lang-sass";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";

export interface LangInfo {
  name: string;
  ext: () => Extension;
}

const LANGS: Record<string, LangInfo> = {
  ts: { name: "TypeScript", ext: () => javascript({ typescript: true }) },
  mts: { name: "TypeScript", ext: () => javascript({ typescript: true }) },
  js: { name: "JavaScript", ext: () => javascript() },
  mjs: { name: "JavaScript", ext: () => javascript() },
  // En un proyecto Angular, todo .html es plantilla: control flow, bindings, pipes.
  html: { name: "Angular HTML", ext: () => angular() },
  htm: { name: "HTML", ext: () => html() },
  css: { name: "CSS", ext: () => css() },
  scss: { name: "SCSS", ext: () => sass({ indented: false }) },
  sass: { name: "Sass", ext: () => sass({ indented: true }) },
  json: { name: "JSON", ext: () => json() },
};

const PLAIN: LangInfo = { name: "Texto", ext: () => [] };

export function langFor(path: string): LangInfo {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGS[ext] ?? PLAIN;
}
