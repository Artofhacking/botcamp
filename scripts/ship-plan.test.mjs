import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPlan, shipPlaces } from "./ship-plan.mjs";

function ids(files) {
  return shipPlaces(files).map((place) => place.id);
}

test("a console source file goes to Demox /console/ only", () => {
  assert.deepEqual(ids(["apps/web/src/pages/Shell.tsx"]), ["demox-console"]);
});

test("tests, docs, and e2e publish nowhere", () => {
  assert.deepEqual(
    ids([
      "apps/web/src/pages/Shell.test.tsx",
      "apps/web/e2e/smoke.spec.ts",
      "docs/ci.md",
      "packages/testkit/src/index.ts",
      "README.md",
    ]),
    [],
  );
});

test("shared packages go to the console and the API", () => {
  assert.deepEqual(ids(["packages/core/src/foo.ts"]), ["demox-console", "cvm"]);
});

test("page-kit ships with the API", () => {
  assert.deepEqual(ids(["packages/page-kit/src/validate.ts"]), ["cvm"]);
});

test("desktop, android, admin, homepage, computer, and supervisor stay apart", () => {
  assert.deepEqual(ids(["apps/desktop/src/main.ts"]), ["feed"]);
  assert.deepEqual(ids(["android/build-apk.sh"]), ["downloads"]);
  assert.deepEqual(ids(["web/admin/index.html"]), ["demox-admin"]);
  assert.deepEqual(ids(["web/site/index.html"]), ["demox-home"]);
  assert.deepEqual(ids(["infra/sandboxes/computer/Dockerfile"]), ["registry"]);
  assert.deepEqual(ids(["infra/sandboxes/supervisor/src/index.ts"]), ["cvm-supervisor"]);
});

test("the plan names the command and an empty diff says so", () => {
  const text = formatPlan(shipPlaces(["apps/api/src/router.ts"]));
  assert.match(text, /pnpm --filter @botcamp\/api build/);
  assert.match(text, /release-tag\.sh deploy/);
  assert.match(text, /Only a vX\.Y\.Z tag/);
  assert.match(text, /Its commit must be on main/);
  assert.match(text, /Leave \.env/);
  assert.equal(formatPlan([]), "ship-plan\nnothing to publish\n");
});

test("the console plan is the same tagged commit on main", () => {
  const text = formatPlan(shipPlaces(["apps/web/src/pages/Shell.tsx"]));
  assert.match(text, /same tagged commit/);
  assert.match(text, /must already be on main/);
});
