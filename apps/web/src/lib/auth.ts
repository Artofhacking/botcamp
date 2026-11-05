import { passkeyClient } from "@better-auth/passkey/client";
import type { OrganizationClientOptions } from "better-auth/client/plugins";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import type { ReactAuthClient } from "better-auth/react";
import { createAuthClient } from "better-auth/react";
import { apiOrigin } from "./api-origin.js";
import { captureAuthToken, getAuthToken } from "./auth-token.js";

// An uninstantiated generic resolves to `any`, which would erase every plugin's actions.
// The client infers a plugin-less client, so the annotation is applied after construction.
export const authClient = createAuthClient({
  // Auth lives on the API host; without this the client would ask the page's own origin.
  baseURL: `${apiOrigin()}/api/auth`,
  // Every auth call carries the bearer token and keeps the one returned by a sign-in.
  fetchOptions: {
    auth: { type: "Bearer", token: () => getAuthToken() ?? "" },
    onSuccess: (context: { response: Response }) => {
      captureAuthToken(context.response);
    },
  },
  plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
}) as ReactAuthClient<{
  plugins: [
    ReturnType<typeof organizationClient<OrganizationClientOptions>>,
    ReturnType<typeof emailOTPClient>,
    ReturnType<typeof passkeyClient>,
  ];
}>;
