/**
 * Deployment switches for what the app shows. A host sets them in `config.js` next to the
 * build, so trimming the UI never needs a rebuild:
 *
 *   window.__RAKAZO_UI__ = { hiddenSections: ["computer", "models", "billing"] };
 */

declare global {
  interface Window {
    __RAKAZO_UI__?: { hiddenSections?: string[] };
  }
}

function deploymentUi(): NonNullable<Window["__RAKAZO_UI__"]> {
  return typeof window === "undefined" ? {} : (window.__RAKAZO_UI__ ?? {});
}

/** True when this deployment hides the section from the settings navigation. */
export function sectionHidden(id: string): boolean {
  return new Set(deploymentUi().hiddenSections ?? []).has(id);
}
