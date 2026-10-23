/**
 * Prove owner A cannot read owner B's MediaAccount data.
 * Run: npm run seed && npm run test:isolation
 */
import { seed, PHOSA_MAC_ID, OTHER_MAC_ID } from "./seed.mjs";
import { createApp } from "../server/index.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function login(base, username) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  assert(res.ok, `login ${username} failed: ${res.status}`);
  const body = await res.json();
  assert(body.token, "missing token");
  return body;
}

async function api(base, token, path) {
  return fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function main() {
  seed();
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const unauth = await fetch(`${base}/api/me/workspace`);
    assert(unauth.status === 401, `expected 401 unauth, got ${unauth.status}`);

    const phosa = await login(base, "phosa");
    const other = await login(base, "other_creator");

    const wsPhosa = await api(base, phosa.token, "/api/me/workspace");
    assert(wsPhosa.ok, "phosa workspace");
    const phosaBody = await wsPhosa.json();
    assert(
      phosaBody.account.display_name === "小稿的AI日记",
      "phosa should see 小稿",
    );
    assert(phosaBody.account.id === PHOSA_MAC_ID, "phosa mac id");

    const listPhosa = await api(base, phosa.token, "/api/accounts");
    const listPhosaBody = await listPhosa.json();
    assert(
      listPhosaBody.accounts.every((a) => a.owner_user_id === phosa.owner_user_id),
      "phosa list only own",
    );
    assert(
      !listPhosaBody.accounts.some((a) => a.id === OTHER_MAC_ID),
      "phosa must not list other mac",
    );

    const cross = await api(base, phosa.token, `/api/accounts/${OTHER_MAC_ID}`);
    assert(cross.status === 403, `phosa→other account expected 403, got ${cross.status}`);

    const crossMs = await api(
      base,
      phosa.token,
      `/api/accounts/${OTHER_MAC_ID}/manuscripts/any`,
    );
    assert(
      crossMs.status === 403,
      `phosa→other manuscript expected 403, got ${crossMs.status}`,
    );

    const wsOther = await api(base, other.token, "/api/me/workspace");
    assert(wsOther.ok, "other workspace");
    const otherBody = await wsOther.json();
    assert(
      otherBody.account.display_name === "别家效率号",
      "other should see 别家效率号",
    );
    assert(
      !JSON.stringify(otherBody).includes("小稿的AI日记"),
      "other must not see 小稿 payload",
    );
    assert(
      otherBody.posts.some((p) => p.title.includes("机密")),
      "other sees own secret post",
    );
    assert(
      !phosaBody.posts.some((p) => p.title.includes("机密")),
      "phosa must not see other secret post",
    );

    const reverse = await api(base, other.token, `/api/accounts/${PHOSA_MAC_ID}`);
    assert(
      reverse.status === 403,
      `other→phosa account expected 403, got ${reverse.status}`,
    );

    const debug = await fetch(`${base}/api/debug/kv-keys`);
    assert(debug.status === 404, `debug kv-keys must be gone, got ${debug.status}`);

    console.log("isolation-check OK: A≠B enforced (401/403 + list scoped)");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error("isolation-check FAILED:", err.message);
  process.exit(1);
});
