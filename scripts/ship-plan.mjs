#!/usr/bin/env node
// Where a diff has to be published. `node scripts/ship-plan.mjs` prints one block per place.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PLACES = [
  {
    id: "demox-home",
    title: "Demox  /   botcamp.demox.site",
    match: (file) => file.startsWith("web/site/"),
    steps: [
      "The page source is the publish. Upload web/site/index.html to /.",
      "The buttons read /downloads/latest.json, so a new installer does not need a new page.",
      "A full site zip replaces every object, so it also has to contain /console/ and /admin/.",
    ],
  },
  {
    id: "demox-console",
    title: "Demox  /console/",
    match: (file) =>
      file.startsWith("apps/web/") ||
      file.startsWith("packages/ui-web/") ||
      file.startsWith("packages/ui-tokens/") ||
      file.startsWith("packages/chat-ui/") ||
      file.startsWith("packages/contracts/") ||
      file.startsWith("packages/core/") ||
      file.startsWith("packages/logging/"),
    steps: [
      "BOTCAMP_WEB_BASE=/console/ pnpm --filter @botcamp/web build",
      "Overlay apps/web/dist onto /console/.",
      "Leave config.js, source maps, and computer-screen/WuyingWebSDK.js in place.",
    ],
  },
  {
    id: "demox-admin",
    title: "Demox  /admin/",
    match: (file) => file.startsWith("web/admin/"),
    steps: ["Upload web/admin/index.html to /admin/.", "Leave admin/config.js in place."],
  },
  {
    id: "cvm",
    title: "CVM  API and worker   botcamp.aigc.sx.cn",
    match: (file) =>
      file.startsWith("apps/api/") ||
      file.startsWith("apps/worker/") ||
      file.startsWith("packages/adapter-kit/") ||
      file.startsWith("packages/adapters/") ||
      file.startsWith("packages/auth/") ||
      file.startsWith("packages/contracts/") ||
      file.startsWith("packages/core/") ||
      file.startsWith("packages/db/") ||
      file.startsWith("packages/logging/") ||
      file.startsWith("packages/memory/") ||
      file.startsWith("packages/page-kit/"),
    steps: [
      "infra/compose/release-tag.sh deploy <checkout> vX.Y.Z",
      "Only a vX.Y.Z tag from GitHub. A branch, a commit, and a copied file are refused.",
      "Leave .env, node_modules, data, and apps/web/public/config.js.",
      "pnpm --filter @botcamp/api build && pnpm --filter @botcamp/worker build",
      "pnpm --filter @botcamp/api db:migrate",
      "infra/compose/release-tag.sh seal <checkout>",
      'Restart the API and the worker. They start only when release-tag.sh require passes. GET /health returns {"ok":true}.',
    ],
  },
  {
    id: "cvm-supervisor",
    title: "CVM  computer supervisor",
    match: (file) => file.startsWith("infra/sandboxes/supervisor/"),
    steps: [
      "Restart the supervisor only after release-tag.sh require passes.",
      "A computer that is already running keeps its current image.",
    ],
  },
  {
    id: "downloads",
    title: "CVM  /downloads/",
    match: (file) => file.startsWith("android/"),
    steps: [
      "(cd android && ./build-apk.sh)",
      "Copy android/build/manual/BotCamp-<version>.apk to /downloads/ under that versioned name.",
      "Set version and android in /downloads/latest.json. The homepage reads that catalog.",
      "VERSION_NAME and VERSION_CODE live at the top of android/build-apk.sh. Set the same pair in android/app/build.gradle.kts.",
    ],
  },
  {
    id: "feed",
    title: "Update feed   publish url in apps/desktop/package.json",
    match: (file) => file.startsWith("apps/desktop/"),
    steps: [
      "gh workflow run desktop-unsigned.yml --ref main -f publish=true",
      "platform is mac, windows, or omitted for both. version overrides apps/desktop/package.json.",
      "This uploads the installer, its blockmap, and latest.yml or latest-mac.yml. The macOS zip stays out.",
      "Set the matching version and URL in /downloads/latest.json when this installer is the one the homepage should offer.",
    ],
  },
  {
    id: "registry",
    title: "Image registry   ghcr.io/<owner>/<repo>/computer",
    match: (file) =>
      file.startsWith("infra/sandboxes/computer/") || file.startsWith("infra/sandboxes/desktop/"),
    steps: [
      "Push to main. After Checks and Postgres journeys, sha-<commit> and edge move.",
      "computer:edge is what a new computer pulls. One that is already running is left as it started.",
    ],
  },
];

export function shipPlaces(files) {
  const hits = new Map(PLACES.map((place) => [place.id, []]));
  for (const file of files) {
    if (skip(file)) continue;
    for (const place of PLACES) {
      if (place.match(file)) hits.get(place.id).push(file);
    }
  }
  return PLACES.filter((place) => hits.get(place.id).length > 0).map((place) => ({
    ...place,
    files: hits.get(place.id),
  }));
}

function skip(file) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return (
    file.endsWith(".md") ||
    file.startsWith("docs/") ||
    file.startsWith("packages/testkit/") ||
    file.includes("/node_modules/") ||
    file.includes("/e2e/") ||
    name.includes(".test.") ||
    name.includes(".spec.")
  );
}

export function formatPlan(places) {
  if (places.length === 0) return "ship-plan\nnothing to publish\n";
  const blocks = ["ship-plan"];
  for (const place of places) {
    blocks.push("", place.title);
    const shown = place.files.slice(0, 8);
    blocks.push(
      `  files: ${shown.join(", ")}${place.files.length > shown.length ? `, +${place.files.length - shown.length}` : ""}`,
    );
    for (const step of place.steps) blocks.push(`  ${step}`);
  }
  blocks.push("");
  return `${blocks.join("\n")}\n`;
}

function changedFiles() {
  const range = process.argv.slice(2).filter((arg) => arg !== "--");
  if (range.length > 0) return range;
  let base = "HEAD";
  try {
    base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }).trim();
  } catch {
    // No origin/main. Uncommitted files still count.
  }
  const args = ["diff", "--name-only", base];
  const committed = execFileSync("git", args, { encoding: "utf8" });
  const work = execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" });
  const staged = execFileSync("git", ["diff", "--name-only", "--cached"], { encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return [...new Set(`${committed}\n${work}\n${staged}\n${untracked}`.split("\n").filter(Boolean))];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.stdout.write(formatPlan(shipPlaces(changedFiles())));
}
