# Editor Angular

Editor de código ultraligero, hecho exclusivamente para proyectos Angular.

## Funciones

- Árbol de archivos que sigue al archivo activo, pestañas y guardado con `Ctrl+S` (respeta CRLF/LF)
- Resaltado de plantillas Angular (control flow, bindings, pipes), TypeScript, SCSS, CSS y JSON
- `Ctrl+P` ir a archivo · `Ctrl+Shift+F` buscar en el proyecto (respeta `.gitignore`)
- `Alt+O` alternar `.ts` / `.html` / `.scss` del componente
- Inteligencia de código vía LSP (Angular Language Service + TypeScript):
  errores en vivo, autocompletado, hover, `F12`/`Ctrl+clic` ir a definición,
  `Shift+F12` referencias, `F2` renombrar en todo el proyecto, `Shift+Alt+F` formatear

## Stack

| Parte | Tecnología |
|---|---|
| Shell nativo | [Tauri 2](https://tauri.app) (Rust) |
| Interfaz | TypeScript sin framework + Vite |
| Editor | [CodeMirror 6](https://codemirror.net) + `@codemirror/lang-angular` |
| Cliente LSP | `@codemirror/lsp-client` |
| Servidores | `@angular/language-server`, `typescript-language-server` (ejecutados con Node) |

## Requisitos

- Node.js 22+
- Rust (stable) y, en Windows, Visual Studio Build Tools con la carga "Desarrollo de escritorio con C++"

## Desarrollo

```sh
npm install
npm run tauri dev
```

## Estructura

- `src/main.ts` — UI: árbol, pestañas, paleta, búsqueda, atajos
- `src/lsp.ts` — integración LSP (workspace por pestañas, diagnósticos, renombrar, referencias)
- `src/lang.ts` — lenguaje de CodeMirror según extensión
- `src-tauri/src/lib.rs` — comandos de sistema de archivos y búsqueda
- `src-tauri/src/lsp.rs` — procesos de los language servers y framing LSP
