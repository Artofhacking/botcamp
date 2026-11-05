import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));

// The product mark is apps/desktop/assets/icon.png. Packaged Windows does not
// read that PNG: the installer, the exe, shortcuts, and the taskbar use icon.ico.
// PNG frames are what current Windows and this repo already ship.
async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
}

const desktopIcon = await sharp(path("apps/desktop/assets/icon.png")).resize(1024, 1024).png().toBuffer();
await ico(desktopIcon, "apps/desktop/assets/icon.ico", [16, 32, 48, 64, 128, 256]);

// Unpackaged Mac draws this file as-is. The squircle matches the old Dock
// footprint: 1024 canvas, 100px margin, superellipse n=4.5.
function dockSquircle() {
  const cx = 512;
  const radius = 412;
  const exponent = 2 / 4.5;
  const steps = 256;
  let d = "";
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = cx + radius * Math.sign(ct) * Math.abs(ct) ** exponent;
    const y = cx + radius * Math.sign(st) * Math.abs(st) ** exponent;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path d="${d}Z" fill="white"/></svg>`,
  );
}

await sharp(desktopIcon)
  .ensureAlpha()
  .composite([{ input: dockSquircle(), blend: "dest-in" }])
  .png()
  .toFile(path("apps/desktop/assets/icon-macos.png"));
