import { invoke } from "@tauri-apps/api/core";

export type AutoSave = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";

export interface Settings {
  autoSave: AutoSave;
  /** Milisegundos sin escribir antes de guardar (solo con autoSave = "afterDelay"). */
  autoSaveDelay: number;
  /** Mostrar al final de la línea actual quién la cambió y en qué commit (git blame). */
  gitBlame: boolean;
}

export const DEFAULTS: Settings = {
  autoSave: "off",
  autoSaveDelay: 1000,
  gitBlame: true,
};

const AUTOSAVE_OPTIONS: { value: AutoSave; label: string; help: string }[] = [
  { value: "off", label: "Manual", help: "Solo se guarda con Ctrl+S o Ctrl+K S." },
  { value: "afterDelay", label: "Tras un retraso", help: "Guarda cuando dejas de escribir durante el tiempo indicado." },
  { value: "onFocusChange", label: "Al cambiar de foco", help: "Guarda al cambiar de pestaña, abrir la paleta o la búsqueda, o salir del editor." },
  { value: "onWindowChange", label: "Al cambiar de ventana", help: "Guarda todo al pasar a otra aplicación (por ejemplo, al navegador)." },
];

const MIN_DELAY = 100;
const MAX_DELAY = 60_000;

let current: Settings = { ...DEFAULTS };
const listeners = new Set<(s: Settings) => void>();

/** Valida lo leído del disco: valores desconocidos o fuera de rango vuelven al predeterminado. */
function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  const autoSave = AUTOSAVE_OPTIONS.some((o) => o.value === r.autoSave) ? r.autoSave! : DEFAULTS.autoSave;
  const delay = Number(r.autoSaveDelay);
  const autoSaveDelay = Number.isFinite(delay) ? Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(delay))) : DEFAULTS.autoSaveDelay;
  const gitBlame = typeof r.gitBlame === "boolean" ? r.gitBlame : DEFAULTS.gitBlame;
  return { ...r, autoSave, autoSaveDelay, gitBlame } as Settings;
}

export async function loadSettings(): Promise<Settings> {
  try {
    current = sanitize(JSON.parse(await invoke<string>("read_settings")));
  } catch (e) {
    console.error("No se pudo leer la configuración; se usan los valores predeterminados", e);
    current = { ...DEFAULTS };
  }
  listeners.forEach((l) => l(current));
  return current;
}

export const settings = () => current;

export function onSettingsChange(listener: (s: Settings) => void) {
  listeners.add(listener);
}

export async function updateSettings(patch: Partial<Settings>) {
  current = sanitize({ ...current, ...patch });
  listeners.forEach((l) => l(current));
  await invoke("write_settings", { contents: JSON.stringify(current, null, 2) });
}

export function describeAutoSave(s: Settings): string {
  switch (s.autoSave) {
    case "off": return "Guardado manual";
    case "afterDelay": return `Autoguardado: ${s.autoSaveDelay >= 1000 ? `${s.autoSaveDelay / 1000} s` : `${s.autoSaveDelay} ms`}`;
    case "onFocusChange": return "Autoguardado: al cambiar de foco";
    case "onWindowChange": return "Autoguardado: al cambiar de ventana";
  }
}

// ---------- pantalla de configuración ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function openSettings() {
  const overlay = $("settings");
  const body = $("settings-body");
  body.replaceChildren();

  const section = document.createElement("section");
  section.innerHTML = `<h3>Guardado</h3><p class="setting-help">Cuándo se guardan los archivos modificados.</p>`;
  const group = document.createElement("div");
  group.className = "radio-group";
  group.setAttribute("role", "radiogroup");

  for (const opt of AUTOSAVE_OPTIONS) {
    const label = document.createElement("label");
    label.className = "radio";
    label.innerHTML = `<input type="radio" name="autosave" /><span><strong></strong><small></small></span>`;
    const input = label.querySelector("input")!;
    input.value = opt.value;
    input.checked = current.autoSave === opt.value;
    label.querySelector("strong")!.textContent = opt.label;
    label.querySelector("small")!.textContent = opt.help;
    input.addEventListener("change", () => {
      updateSettings({ autoSave: opt.value }).catch(reportError);
      delayRow.hidden = opt.value !== "afterDelay";
    });
    group.appendChild(label);
  }
  section.appendChild(group);

  const delayRow = document.createElement("label");
  delayRow.className = "setting-row";
  delayRow.innerHTML = `<span>Retraso</span><input type="number" min="${MIN_DELAY}" max="${MAX_DELAY}" step="100" /><span class="unit">ms</span>`;
  const delayInput = delayRow.querySelector("input")!;
  delayInput.value = String(current.autoSaveDelay);
  delayInput.addEventListener("change", () => {
    updateSettings({ autoSaveDelay: Number(delayInput.value) }).catch(reportError);
    delayInput.value = String(current.autoSaveDelay); // muestra el valor ya ajustado al rango
  });
  delayRow.hidden = current.autoSave !== "afterDelay";
  section.appendChild(delayRow);
  body.appendChild(section);

  const gitSection = document.createElement("section");
  gitSection.innerHTML = `<h3>Git</h3>`;
  const blame = document.createElement("label");
  blame.className = "radio";
  blame.innerHTML = `<input type="checkbox" /><span><strong>Autor de la línea actual</strong><small>Muestra al final de la línea del cursor quién la cambió, hace cuánto y el mensaje del commit (como en VS Code).</small></span>`;
  const blameInput = blame.querySelector("input")!;
  blameInput.checked = current.gitBlame;
  blameInput.addEventListener("change", () => updateSettings({ gitBlame: blameInput.checked }).catch(reportError));
  gitSection.appendChild(blame);
  body.appendChild(gitSection);

  overlay.hidden = false;
  (group.querySelector("input:checked") as HTMLInputElement | null)?.focus();
}

function reportError(e: unknown) {
  $("status-msg").textContent = `No se pudo guardar la configuración: ${e}`;
}

export function closeSettings() {
  $("settings").hidden = true;
}

export function setupSettingsUi() {
  const overlay = $("settings");
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeSettings(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeSettings(); } });
  $("settings-close").addEventListener("click", closeSettings);
}
