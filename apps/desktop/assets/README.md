# Desktop icons

The shared editable source and export notes are in
[`packages/ui-tokens/assets`](../../../packages/ui-tokens/assets/README.md).

Packaged Mac builds take `icon.png`. macOS masks that to the Dock squircle.
`icon-macos.png` is the same mark already clipped, with the Dock margin, because an
unpackaged launch draws the file as-is.

`icon.png` is the product mark for Linux and for unpackaged Windows. `icon.ico` is that
same mark at the sizes Windows uses for the installer, the exe, shortcuts, and the taskbar.
Refresh `icon.ico` and `icon-macos.png` with `pnpm --filter @rakazo/ui-tokens export:brand`.
