import type { WorkspaceBundle } from "./types";

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = localStorage.getItem("botcamp_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`请求失败 (${res.status}): ${text}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export type DemoUser = { username: string; display_name: string };

export type AuthUser = {
  owner_user_id: string;
  username: string | null;
  display_name: string | null;
};

export async function fetchDemoUsers(): Promise<DemoUser[]> {
  const data = await request<{ users: DemoUser[] }>("/api/auth/demo-users");
  return data.users;
}

export async function login(username: string): Promise<AuthUser & { token: string }> {
  const data = await request<{
    owner_user_id: string;
    username: string;
    display_name: string;
    token: string;
  }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
  localStorage.setItem("botcamp_token", data.token);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    localStorage.removeItem("botcamp_token");
  }
}

export async function fetchMe(): Promise<AuthUser> {
  return request<AuthUser>("/api/auth/me");
}

export async function fetchWorkspace(): Promise<WorkspaceBundle> {
  return request<WorkspaceBundle>("/api/me/workspace");
}

export async function fetchManuscript(
  accountId: string,
  manuscriptId: string,
): Promise<{
  manuscript: { title: string; status: string };
  body: string | null;
  published_edition: string | null;
}> {
  return request(`/api/accounts/${accountId}/manuscripts/${manuscriptId}`);
}
