import { fileURLToPath } from "node:url";
import { isBuildId } from "@rakazo/contracts/client-build";
import { webDarkTokens } from "@rakazo/ui-tokens";
import type { Plugin, Rolldown } from "vite";
import { CACHE_PREFIX } from "./service-worker.js";

const SERVICE_WORKER_FILE = "sw.js";
const BASE_PLACEHOLDER = "__RAKAZO_SW_BASE__";
const MANIFEST_FILE = "site.webmanifest";
const PRECACHE_PLACEHOLDER = "__RAKAZO_SW_PRECACHE__";
const CACHE_PLACEHOLDER = "__RAKAZO_SW_CACHE__";

export function webManifest(base = "/") {
  const root = base.endsWith("/") ? base : `${base}/`;
  const icons = [192, 512].map((size) => ({
    src: `${root}icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
  }));
  return {
    id: root,
    name: "BotCamp",
    short_name: "BotCamp",
    description: "Your always-on agents, each with its own computer.",
    start_url: root,
    scope: root,
    display: "standalone",
    background_color: webDarkTokens.background,
    theme_color: webDarkTokens.background,
    // The icons are full-bleed, so the same art also works under a launcher mask.
    icons: [
      ...icons.map((icon) => ({ ...icon, purpose: "any" })),
      ...icons.map((icon) => ({ ...icon, purpose: "maskable" })),
    ],
  };
}

/**
 * Everything the first screen needs offline: the HTML shell, the entry's static
 * import graph, stylesheets and fonts. Lazy chunks are cached as they load.
 */
export function shellFiles(bundle: Rolldown.OutputBundle, base = "/"): string[] {
  const root = base.endsWith("/") ? base : `${base}/`;
  const files = new Set([root]);
  const visit = (fileName: string) => {
    const chunk = bundle[fileName];
    if (chunk?.type !== "chunk" || files.has(`/${fileName}`)) return;
    files.add(`/${fileName}`);
    for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(`/${css}`);
    chunk.imports.forEach(visit);
  };
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk" && output.isEntry && output.fileName !== SERVICE_WORKER_FILE) {
      visit(output.fileName);
    }
    if (output.type === "asset" && /\.(css|woff2)$/.test(output.fileName)) {
      files.add(`/${output.fileName}`);
    }
  }
  return [...files].sort();
}

/** Prefix the bundle's root-relative paths with the deployment's base path. */
function withBase(files: readonly string[], base: string): string[] {
  const root = base.endsWith("/") ? base : `${base}/`;
  if (root === "/") return [...files];
  return files.map((file) => `${root}${file.replace(/^\//, "")}`).sort();
}

/** The cache is named after the build, the same id `/build-id` and every API request carry. */
export function injectShell(
  code: string,
  precache: readonly string[],
  buildId: string,
  base = "/",
): string {
  if (!isBuildId(buildId)) throw new Error(`Expected a build id, got "${buildId}".`);
  const cacheName = `${CACHE_PREFIX}${buildId}`;
  let injected = code;
  for (const [placeholder, value] of [
    [PRECACHE_PLACEHOLDER, precache],
    [CACHE_PLACEHOLDER, cacheName],
    [BASE_PLACEHOLDER, base.endsWith("/") ? base : `${base}/`],
  ] as const) {
    const parts = injected.split(placeholder);
    if (parts.length === 1) {
      // The base placeholder is optional at the site root; the other two never are.
      if (placeholder === BASE_PLACEHOLDER) {
        if (base !== "/") throw new Error(`Expected one ${placeholder} in the service worker.`);
        continue;
      }
      throw new Error(`Expected one ${placeholder} in the service worker.`);
    }
    if (parts.length !== 2) throw new Error(`Expected one ${placeholder} in the service worker.`);
    injected = parts.join(JSON.stringify(value));
  }
  return injected;
}

/** Installable PWA shell: the web manifest and the service worker. */
export function rakazoPwa(buildId: string, base = "/"): Plugin[] {
  const root = base.endsWith("/") ? base : `${base}/`;
  const manifest = () => JSON.stringify(webManifest(root), null, 2);
  return [
    {
      name: "rakazo-pwa-manifest",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?", 1)[0] !== `${root}${MANIFEST_FILE}`) {
            next();
            return;
          }
          res.setHeader("content-type", "application/manifest+json; charset=utf-8");
          res.end(manifest());
        });
      },
    },
    {
      name: "rakazo-pwa-service-worker",
      apply: "build",
      enforce: "post",
      buildStart() {
        this.emitFile({
          type: "chunk",
          id: fileURLToPath(new URL("./sw.ts", import.meta.url)),
          fileName: SERVICE_WORKER_FILE,
        });
      },
      generateBundle(_options, bundle) {
        this.emitFile({ type: "asset", fileName: MANIFEST_FILE, source: manifest() });
        const html = bundle["index.html"];
        if (html?.type !== "asset") this.error("The index.html shell was not emitted.");
        const worker = bundle[SERVICE_WORKER_FILE];
        if (worker?.type !== "chunk") this.error("The service worker chunk was not emitted.");
        // Registered as a classic script, so it must stay one self-contained file.
        if (worker.imports.length || worker.dynamicImports.length || worker.exports.length) {
          this.error("The service worker must not import or export modules.");
        }
        // The shell is precached under the deployment's base path, so a subpath build must not
        // fetch the site root (which would install the wrong page, or fail on a 404).
        const precache = withBase(shellFiles(bundle), root);
        worker.code = injectShell(worker.code, precache, buildId, root);
        // Vite only rewrites links to files it emits; the manifest is generated here.
        if (root !== "/") {
          html.source = String(html.source).replace(
            `href="/${MANIFEST_FILE}"`,
            `href="${root}${MANIFEST_FILE}"`,
          );
        }
      },
    },
  ];
}
