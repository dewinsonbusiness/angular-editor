# Editor Angular

Editor de código ultraligero, hecho exclusivamente para proyectos Angular.

## Funciones

- Árbol de archivos que sigue al archivo activo, pestañas y guardado con `Ctrl+S` (respeta CRLF/LF)
- Resaltado de plantillas Angular (control flow, bindings, pipes), TypeScript, SCSS, CSS y JSON
- `Ctrl+P` ir a archivo · `Ctrl+Shift+F` buscar en el proyecto (respeta `.gitignore`)
- `Alt+O` alternar `.ts` / `.html` / `.scss` del componente
- Recuerda las pestañas abiertas por proyecto · `Ctrl+K S` guardar todo
- Árbol: crear, renombrar, eliminar (a la papelera) y "Angular: generar" con `ng` o `nx`
  (detecta workspaces Nx por `nx.json`/`project.json`); se actualiza solo con cambios externos
- Panel de serve (`Ctrl+J`): `nx serve` / `ng serve` con errores enlazados al código
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
npm install        # también instala los language servers en lsp-servers/
npm run tauri dev
```

## Instalador

```sh
npm run tauri build
```

Genera `src-tauri/target/release/bundle/nsis/Editor Angular_<versión>_x64-setup.exe`.
Se instala por usuario (sin permisos de administrador) e incluye los language servers
(`lsp-servers/node_modules`). Necesita Node.js 22+ en el PATH para ejecutarlos.

## Estructura

- `src/main.ts` — UI: árbol, pestañas, paleta, búsqueda, atajos
- `src/lsp.ts` — integración LSP (workspace por pestañas, diagnósticos, renombrar, referencias)
- `src/lang.ts` — lenguaje de CodeMirror según extensión
- `src-tauri/src/lib.rs` — comandos de sistema de archivos y búsqueda
- `src/serve.ts` — panel de `nx serve` / `ng serve`
- `src-tauri/src/lsp.rs` — procesos de los language servers y framing LSP
- `src-tauri/src/fsops.rs` — crear/renombrar/eliminar, vigilancia del disco, `ng`/`nx generate`
- `src-tauri/src/serve.rs` — procesos de serve
- `lsp-servers/` — dependencias de los language servers que se empaquetan con la app
