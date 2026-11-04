import { apiUrl } from "./api-origin.js";

/**
 * The previous BotCamp deployment hashed passwords with PBKDF2. On the first sign-in here the
 * API verifies that hash, rewrites the account with the current scheme and clears the import,
 * so this upgrade runs once per account and then never again.
 */
export async function upgradeLegacyPassword(email: string, password: string): Promise<boolean> {
  try {
    const response = await fetch(apiUrl("/api/auth/legacy-sign-in"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
