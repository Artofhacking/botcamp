# App icon source

`BotCamp.icon` is the older macOS Icon Composer source. Open it in Apple's Icon Composer
with Xcode 26 or newer. The orange foreground keeps its original lighting, sits 90 points
below center, and uses the system dark background. It is not the Windows or Linux icon.

The product mark is `apps/desktop/assets/icon.png`. Run
`pnpm --filter @botcamp/ui-tokens export:brand` to rebuild `icon.ico` and the
unpackaged Mac Dock icon from that file.

## Animated vector avatars

The animated avatar uses SVG paths and gradients in the shared `logo-avatar-art.ts`
definition. Its contour is sampled from this canonical source's alpha silhouette. The hands
and lighting are simplified vector shapes; the original photographic skin grain is
intentionally not reproduced. No raster body is embedded or loaded by the vector renderer.
