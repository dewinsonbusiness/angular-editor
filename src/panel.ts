/** Panel inferior con vistas (Serve, Terminal). */

export type PanelView = "serve" | "terminal";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const listeners = new Set<(view: PanelView) => void>();
let view: PanelView = "serve";

export const isPanelOpen = () => !$("panel").hidden;
export const currentView = () => view;

export function showPanel(v: PanelView = view) {
  view = v;
  $("panel").hidden = false;
  document.querySelectorAll<HTMLElement>(".panel-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === v);
    t.setAttribute("aria-selected", String(t.dataset.view === v));
  });
  $("view-serve").hidden = v !== "serve";
  $("view-terminal").hidden = v !== "terminal";
  listeners.forEach((l) => l(v));
}

export function hidePanel() {
  $("panel").hidden = true;
}

/** Abre el panel en esa vista; si ya estaba abierto en ella, lo cierra. */
export function togglePanel(v: PanelView) {
  if (isPanelOpen() && view === v) hidePanel();
  else showPanel(v);
}

export function onPanelView(listener: (view: PanelView) => void) {
  listeners.add(listener);
}

export function setupPanel() {
  document.querySelectorAll<HTMLElement>(".panel-tab").forEach((t) => {
    t.addEventListener("click", () => showPanel(t.dataset.view as PanelView));
  });
  $("panel-close").addEventListener("click", hidePanel);
  showPanel("serve");
  hidePanel();
}
