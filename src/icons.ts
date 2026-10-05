/**
 * Iconos del árbol: un glifo corto coloreado por tipo de archivo (sin imágenes que cargar).
 * Se elige primero por nombre exacto, luego por sufijo de Angular y por último por extensión.
 */

export interface FileIcon { glyph: string; kind: string }

const BY_NAME: Record<string, FileIcon> = {
  "package.json": { glyph: "N", kind: "npm" },
  "package-lock.json": { glyph: "N", kind: "lock" },
  "pnpm-lock.yaml": { glyph: "P", kind: "lock" },
  "pnpm-workspace.yaml": { glyph: "P", kind: "pnpm" },
  "yarn.lock": { glyph: "Y", kind: "lock" },
  "angular.json": { glyph: "A", kind: "angular" },
  "nx.json": { glyph: "Nx", kind: "nx" },
  "project.json": { glyph: "Nx", kind: "nx" },
  ".gitignore": { glyph: "⎇", kind: "git" },
  ".gitattributes": { glyph: "⎇", kind: "git" },
  ".editorconfig": { glyph: "⚙", kind: "config" },
  ".npmrc": { glyph: "N", kind: "npm" },
  ".nvmrc": { glyph: "⬢", kind: "node" },
  "dockerfile": { glyph: "D", kind: "docker" },
  "readme.md": { glyph: "i", kind: "readme" },
  "license": { glyph: "©", kind: "config" },
};

// Artefactos de Angular: estilo clásico (x.component.ts) y el de Angular 20+ (auth-guard.ts).
const ANGULAR: [RegExp, FileIcon][] = [
  [/[.-]spec\.ts$/, { glyph: "✓", kind: "spec" }],
  [/\.component\.ts$/, { glyph: "C", kind: "ng" }],
  [/[.-]service\.ts$/, { glyph: "S", kind: "ng-service" }],
  [/\.module\.ts$/, { glyph: "M", kind: "ng" }],
  [/[.-]guard\.ts$/, { glyph: "G", kind: "ng-guard" }],
  [/[.-]interceptor\.ts$/, { glyph: "I", kind: "ng-guard" }],
  [/[.-]resolver\.ts$/, { glyph: "R", kind: "ng-guard" }],
  [/[.-]pipe\.ts$/, { glyph: "P", kind: "ng-pipe" }],
  [/[.-]directive\.ts$/, { glyph: "D", kind: "ng-pipe" }],
  [/[.-](routes|routing)(\.module)?\.ts$/, { glyph: "⤳", kind: "ng-routes" }],
  [/[.-](store|state|reducer|effects|actions|selectors)\.ts$/, { glyph: "◈", kind: "ng-store" }],
  [/\.config\.ts$/, { glyph: "⚙", kind: "ng-config" }],
  [/^tsconfig.*\.json$/, { glyph: "TS", kind: "tsconfig" }],
  [/^eslint\.config\.|^\.eslintrc/, { glyph: "ES", kind: "eslint" }],
  [/^\.prettier/, { glyph: "Pr", kind: "prettier" }],
  [/^(vite|vitest|jest|karma|webpack|proxy)\.conf(ig)?\./, { glyph: "⚙", kind: "config" }],
  [/^\.env/, { glyph: "$", kind: "env" }],
];

const BY_EXT: Record<string, FileIcon> = {
  ts: { glyph: "TS", kind: "ts" },
  mts: { glyph: "TS", kind: "ts" },
  cts: { glyph: "TS", kind: "ts" },
  js: { glyph: "JS", kind: "js" },
  mjs: { glyph: "JS", kind: "js" },
  cjs: { glyph: "JS", kind: "js" },
  html: { glyph: "<>", kind: "html" },
  scss: { glyph: "#", kind: "scss" },
  sass: { glyph: "#", kind: "scss" },
  css: { glyph: "#", kind: "css" },
  less: { glyph: "#", kind: "css" },
  json: { glyph: "{}", kind: "json" },
  md: { glyph: "M↓", kind: "md" },
  yaml: { glyph: "Y", kind: "yaml" },
  yml: { glyph: "Y", kind: "yaml" },
  svg: { glyph: "◆", kind: "svg" },
  png: { glyph: "▣", kind: "image" },
  jpg: { glyph: "▣", kind: "image" },
  jpeg: { glyph: "▣", kind: "image" },
  gif: { glyph: "▣", kind: "image" },
  webp: { glyph: "▣", kind: "image" },
  ico: { glyph: "▣", kind: "image" },
  woff: { glyph: "F", kind: "font" },
  woff2: { glyph: "F", kind: "font" },
  ttf: { glyph: "F", kind: "font" },
  txt: { glyph: "≡", kind: "text" },
  log: { glyph: "≡", kind: "text" },
  xml: { glyph: "<>", kind: "xml" },
  sh: { glyph: "$", kind: "shell" },
  ps1: { glyph: "$", kind: "shell" },
  bat: { glyph: "$", kind: "shell" },
};

const DEFAULT: FileIcon = { glyph: "·", kind: "file" };

export function fileIcon(name: string): FileIcon {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  for (const [re, icon] of ANGULAR) if (re.test(lower)) return icon;
  return BY_EXT[lower.slice(lower.lastIndexOf(".") + 1)] ?? DEFAULT;
}

/** Carpetas con un color propio (las habituales en proyectos Angular/Nx). */
const SPECIAL_DIRS: Record<string, string> = {
  src: "src", app: "app", apps: "app", libs: "lib", packages: "lib", shared: "lib",
  assets: "assets", public: "assets", environments: "env", node_modules: "deps",
  ".git": "deps", ".angular": "deps", dist: "deps", ".nx": "deps", ".vscode": "config", ".claude": "config",
  components: "app", services: "lib", pages: "app", features: "app", core: "lib",
};

export function folderKind(name: string): string {
  return SPECIAL_DIRS[name.toLowerCase()] ?? "plain";
}
