import type { WorkspaceBundle } from "./types";

type BotOk<T> = T & { ok?: boolean; error?: { message?: string } };

async function bot<T>(
  endpoint: string,
  payload: unknown = null,
): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = localStorage.getItem("botcamp_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch("api/bot", {
    method: "POST",
    headers,
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ endpoint, payload }),
  });
  const data = (await res.json().catch(() => ({}))) as BotOk<T>;
  if (!res.ok || data.ok === false) {
    const message =
      (data.error && typeof data.error.message === "string"
        ? data.error.message
        : null) || `请求失败 (${res.status})`;
    const err = new Error(message);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return data;
}

export type DemoUser = { username: string; display_name: string };

export type AuthUser = {
  kind: "email" | "media";
  email?: string | null;
  role?: string | null;
  owner_user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
};

export type MediaAccountRow = {
  id: string;
  display_name: string;
  platform: string;
  status: string;
  stage?: string;
};

export async function fetchDemoUsers(): Promise<DemoUser[]> {
  const data = await bot<{ users: DemoUser[] }>("media/demo-users");
  return data.users;
}

export async function loginMedia(
  username: string,
): Promise<AuthUser & { token: string }> {
  const data = await bot<{
    owner_user_id: string;
    username: string;
    display_name: string;
    token: string;
  }>("media/login", { username });
  localStorage.setItem("botcamp_token", data.token);
  localStorage.setItem("botcamp_auth_kind", "media");
  return {
    kind: "media",
    owner_user_id: data.owner_user_id,
    username: data.username,
    display_name: data.display_name,
    token: data.token,
  };
}

export async function loginEmail(
  email: string,
  password: string,
): Promise<AuthUser> {
  localStorage.removeItem("botcamp_token");
  const data = await bot<{ user: { email: string; role?: string } }>(
    "auth/login",
    { email, password },
  );
  localStorage.setItem("botcamp_auth_kind", "email");
  return {
    kind: "email",
    email: data.user.email,
    role: data.user.role ?? null,
    display_name: data.user.email,
  };
}

export async function logout(): Promise<void> {
  const kind = localStorage.getItem("botcamp_auth_kind");
  try {
    if (kind === "media") await bot("media/logout", {});
    else await bot("auth/logout", {});
  } finally {
    localStorage.removeItem("botcamp_token");
    localStorage.removeItem("botcamp_auth_kind");
  }
}

export async function restoreSession(): Promise<AuthUser | null> {
  const kind = localStorage.getItem("botcamp_auth_kind");
  if (kind === "media" || localStorage.getItem("botcamp_token")) {
    try {
      const me = await bot<{
        owner_user_id: string;
        username: string | null;
        display_name: string | null;
      }>("media/me");
      return {
        kind: "media",
        owner_user_id: me.owner_user_id,
        username: me.username,
        display_name: me.display_name,
      };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 401) {
        localStorage.removeItem("botcamp_token");
        localStorage.removeItem("botcamp_auth_kind");
        return null;
      }
      throw e;
    }
  }
  try {
    const me = await bot<{ user: { email: string; role?: string } | null }>(
      "auth/me",
      null,
    );
    if (!me.user) return null;
    localStorage.setItem("botcamp_auth_kind", "email");
    return {
      kind: "email",
      email: me.user.email,
      role: me.user.role ?? null,
      display_name: me.user.email,
    };
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 401) return null;
    throw e;
  }
}

export async function fetchWorkspace(): Promise<WorkspaceBundle> {
  const data = await bot<{ workspace: WorkspaceBundle }>("media/workspace");
  return data.workspace;
}

export async function fetchManuscript(
  accountId: string,
  manuscriptId: string,
): Promise<{
  manuscript: { title: string; status: string };
  body: string | null;
  published_edition: string | null;
}> {
  return bot("media/manuscript", { accountId, manuscriptId });
}

export async function fetchMediaAccounts(): Promise<{
  accounts: MediaAccountRow[];
  current_media_account_id: string | null;
}> {
  return bot("media/accounts");
}

export async function focusMediaAccount(
  accountId: string,
): Promise<{ workspace: WorkspaceBundle }> {
  return bot("media/focus", { accountId });
}

export async function createMediaAccount(
  displayName?: string,
): Promise<{ workspace: WorkspaceBundle }> {
  return bot("media/create-account", {
    display_name: displayName || "新自媒体账号",
  });
}

export async function noteMediaEntity(body: {
  accountId: string;
  kind?: "post" | "event";
  entityId?: string;
  title?: string | null;
  text: string;
}): Promise<{ workspace: WorkspaceBundle }> {
  return bot("media/note", body);
}

export async function updateMediaEntity(body: {
  accountId: string;
  kind?: "post" | "manuscript";
  entityId: string;
  action:
    | "confirm_topic"
    | "pass_review"
    | "confirm_publish"
    | "hold"
    | "set_status";
  status?: string;
  note?: string;
}): Promise<{ workspace: WorkspaceBundle }> {
  return bot("media/update", body);
}
