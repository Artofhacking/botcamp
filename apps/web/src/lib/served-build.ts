/**
 * The URL of the `/build-id` file the web server ships beside the page.
 *
 * A host can serve the app from a subpath (`/console/` on the production Demox host), while the
 * file is emitted into the build root next to `index.html`. It is therefore reachable relative to
 * the page, not at the origin root: a leading-slash path 404s there and reads as "no served build".
 */
export function servedBuildUrl(
  base: string = import.meta.env.BASE_URL,
  origin: string = window.location.origin,
): string {
  return new URL(`${base}build-id`, origin).href;
}
