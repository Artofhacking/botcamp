# App icon source

`BotCamp.icon` is the editable source for the macOS and Windows app icons. Open it in Apple's
Icon Composer with Xcode 26 or newer. The orange foreground keeps its original lighting, sits
90 points below center, and uses the system dark background.

macOS packaging compiles the source into a Tahoe asset catalog and generates the legacy ICNS
fallback. Run `pnpm --filter @rakazo/ui-tokens export:brand` to refresh the web favicons and
the Windows/Linux icons.

## Animated vector avatars

The animated avatar uses SVG paths and gradients in the shared `logo-avatar-art.ts`
definition. Its contour is sampled from this canonical source's alpha silhouette. The hands
and lighting are simplified vector shapes; the original photographic skin grain is
intentionally not reproduced. No raster body is embedded or loaded by the vector renderer.
