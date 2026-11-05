type ServiceWorkerHost = Pick<Window, "addEventListener" | "navigator" | "rakazoDesktop">;

/**
 * Production browsers only. Dev must always reach Vite, and Electron serves the
 * renderer itself, so a worker there would shadow the bundled assets.
 */
export function registerServiceWorker(
  target: ServiceWorkerHost = window,
  production: boolean = import.meta.env.PROD,
): void {
  if (!production || target.rakazoDesktop || !("serviceWorker" in target.navigator)) return;
  target.addEventListener(
    "load",
    () => {
      // The worker is built next to the app, so a subpath deployment registers its own copy
      // instead of asking the site root for one that does not exist.
      const worker = `${import.meta.env.BASE_URL}sw.js`.replace(/\/{2,}/g, "/");
      // "none" rechecks the worker script with the network. The host marks sw.js
      // immutable for a year, which would otherwise keep the previous worker.
      target.navigator.serviceWorker
        .register(worker, { scope: import.meta.env.BASE_URL, updateViaCache: "none" })
        .catch(() => undefined);
    },
    { once: true },
  );
}
