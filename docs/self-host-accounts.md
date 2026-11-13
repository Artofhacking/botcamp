# Sign-in and accounts

Choose who can create an account and how people sign in: allowlists, email verification, SSO,
directory login, and password rules.

## Who can sign up

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
```

`SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` come from the operator's environment on every start. An empty allowlist clears any old stored list; signup order never grants privileges.

Server configuration belongs in the operator's environment. App accounts cannot change signup policy,
server integration credentials, or deployment updates, and cannot read deployment security logs.

There is no app-admin role, first-user privilege, or `ADMINS` list. Workspace owners manage only their own workspace.

`BOTCAMP_ADMIN_EMAILS` names accounts, comma-separated, that review plugin submissions, add stdio
MCP servers ([integrations](self-host-integrations.md)), and, on deployments that sell model
credits, give free access at `/admin/access`. An account counts only once its email is verified.
It grants nothing else.

A free-access grant names an email and gives up to $1,000 of model credits, up to 12 free own-key
months, or both. Whoever owns an organization with that verified email receives it the next time they
open the app, whether they signed up before or after the grant. A grant can be revoked until it is
received.

## Email verification and sign-in codes

With a nonempty signup allowlist and SMTP configured, users—including existing accounts—must
verify their email to sign in. Without an allowlist, verification never blocks: a password signup
signs in at once and is sent a verification link that only marks the address verified.

SMTP also enables sign-in with a six-digit emailed code, which expires after ten minutes and allows
three attempts. A code can create an account, so it follows the same registration and allowlist
rules as password signup. Signing in with a code to an existing unverified account removes that
account's password, SSO links and sessions, since nothing proved they belonged to the mailbox
owner. This is what stops someone who registered another person's address from keeping access.
A password reset proves the mailbox the same way, so resetting an unverified account's password
also removes its SSO links, passkeys and paired devices.

Allowlisted signup requires mailbox verification and email delivery, including the first account.
Without email delivery, use the server-side account bootstrap described below; public signup never marks an address verified or assigns server permissions.

## Installations without email

For an installation without email, first set `SIGNUPS_ENABLED=false` in `.env` and start the stack.
Create the intended account privately (the password stays in the shell environment):

```bash
read -r -p "Account email: " OWNER_EMAIL
read -r -s -p "Account password (at least 16 characters): " OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
docker compose -f infra/compose/docker-compose.yml exec -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js
unset OWNER_EMAIL OWNER_PASSWORD
```

This creates an ordinary verified account and a personal workspace, with no server privileges. For an existing unverified account, its password must match before it can be verified; an existing verified account is left unchanged.
Keep an installation without email on a trusted local network.

## Verification and password recovery email

Password changes for signed-in users require no email configuration. Forgotten-password recovery
appears on sign-in only when a transactional email provider is available. BotCamp uses a
provider-neutral contract with Resend API and SMTP adapters. Templates render locally with React
Email into HTML and plain text, independent of the sending provider.

To use the Resend HTTP API, verify a sending domain and create a sending-only API key restricted
to that domain, then configure:

```env
EMAIL_PROVIDER=resend
EMAIL_API_KEY=replace-with-sending-api-key
EMAIL_FROM=BotCamp <hello@mail.example.com>
```

Disable click and open tracking for account email in the provider's domain settings. Resend delivery
has a ten-second deadline and bounded retries with the same idempotency key, including when a
response is lost. Errors omit provider response bodies and credentials.

For Amazon SES or another SMTP server, use:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=BotCamp <no-reply@example.com>
```

Set `EMAIL_REPLY_TO` to send replies somewhere other than `EMAIL_FROM`.

`EMAIL_PROVIDER=smtp` is optional: an existing `SMTP_URL` continues to select SMTP when no provider
is specified. `EMAIL_PROVIDER=none` disables external sending. Explicit provider settings take
precedence over an old `SMTP_URL`; incomplete or unknown provider configurations fail at startup.

Resend also supports SMTP: use `smtp.resend.com`, username `resend`, and an API key as the password. For Amazon
SES, use the regional SMTP endpoint and SES SMTP credentials; these are different from ordinary AWS
access keys. Verify the sender/domain with the provider before testing delivery. Keep credentials in
`.env`, never in tracked files. `smtps://` uses implicit TLS; `smtp://` is also supported but requires
STARTTLS. BotCamp rejects configuration that disables TLS or certificate verification.

Local source development can use the offline email emulator instead. It captures email without
contacting a provider:

```env
EMAIL_EMULATOR=true
```

The emulator is forcibly disabled when `NODE_ENV=production` and requires the API to bind to a
loopback host. In `NODE_ENV=development`, captured messages are available from
`http://127.0.0.1:3100/api/dev/emails` with cache disabled; the API logs only delivery
metadata, never reset tokens. The inbox route is not registered in test, staging, or production.

Set `WELCOME_EMAIL_ENABLED=true` to send each new account one welcome email, with an unsubscribe
link, after it first signs in. It needs one of the providers above.

## Password policy

New passwords (signup, reset and change) must be 8 to 128 characters, with no composition rules.
Optionally reject new passwords that appear in known breaches:

```env
AUTH_BREACHED_PASSWORD_CHECK_ENABLED=true
```

This queries the Have I Been Pwned range API, sending only the first five characters of the
password's SHA-1 hash. It is off by default so the server makes no outside request. If the service
is unreachable or takes longer than three seconds, the password is accepted and the failure logged.

## OpenID Connect SSO

SSO works with a self-hosted or hosted OpenID Connect provider. Leave its settings unset to
keep password authentication alone. Configure all three credentials together on the API:

```env
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_NAME=SSO
OIDC_SCOPES=openid email profile
AUTH_PASSWORD_ENABLED=true
OIDC_ALLOW_SIGNUP_BYPASS=false
```

The issuer must be HTTPS and exactly match the discovery document's issuer. BotCamp loads
`<issuer>/.well-known/openid-configuration`, verifies ID tokens against discovery JWKS with
issuer, audience and nonce checks, and uses authorization codes with PKCE. Additional scopes
may be space- or comma-separated; `openid email profile` are always requested. `OIDC_NAME`
is the button label, defaulting to “SSO”. Secrets remain on the API; Compose clears the worker's
OIDC credentials. The capabilities endpoint exposes only the label, discovery availability,
and enabled authentication methods.

Register this redirect URI at the provider (using your public `BETTER_AUTH_URL` origin):

```text
https://app.example.com/api/auth/callback/oidc
```

Web, Electron and mobile use the same provider redirect URI. Electron completes SSO in a
sandboxed in-app popup sharing the app's session, then returns to the main window. Mobile completes the callback
on the API, then returns to `rakazo://sign-in` (or `rakazo://account` for linking and reauthentication) through Better Auth's Expo authorization proxy
and a native auth browser session. The `rakazo` app scheme is trusted by the auth server;
never register a client secret in the mobile app. Mobile stores the resulting session with
SecureStore, like password sign-in. Native builds need the Expo WebBrowser module.

Provider emails are verified only when `email_verified` is the boolean `true`. False or missing
claims stay unverified, including on subsequent sign-ins, and an unverified claim never changes
the account's email. Sign-in never links accounts by email.
If an email belongs to another account, sign in to that existing account and choose **Link SSO**
in account settings. Linking requires an authenticated session, a verified provider email and
matching email addresses. With email delivery, an account links SSO only after its email is
verified. Without it, an unverified account links only from a browser signed in to it, so not
from the mobile app. The issuer and provider subject identify the linked account thereafter. Changing issuers does
not reuse an old identity. Old-issuer links remain stored but do not count as linked to the
current provider, so **Link SSO** becomes available again. Link the new identity from the
existing signed-in account; authenticated-session, verified-email and matching-email checks
still apply. Restoring the old issuer makes its existing links usable again.

Ordinary SSO sign-in and linking may reuse the identity provider's existing session. They
do not grant fresh authentication proof for account deletion. The account settings' explicit
reauthentication flow requests `prompt=login` and `max_age=0`, binds the callback to the
same linked issuer and subject, and requires the initiating session to remain valid. Only
that callback grants proof to the resulting session, expiring five minutes after provider
authentication (callback delays do not extend it). Its verified
ID token must contain an `auth_time` consistent with that request (allowing 60 seconds of
clock skew) and less than five minutes old. Missing, stale or invalid claims fail closed.
OAuth callbacks are single-use, including concurrent requests. Password verification and
emailed deletion codes remain available. Submit deletion codes through the account settings
or the CSRF-protected `POST /api/auth/delete-user` endpoint; the GET deletion callback is disabled.

SSO signup follows closed registration and the deployment allowlist before creating an account.
Allowlisted provider emails must be verified; signup never bypasses mailbox proof. `OIDC_ALLOW_SIGNUP_BYPASS=true` explicitly admits IdP identities
without applying the allowlist or its email-verification admission requirement. Enable it only
when the IdP controls who may join this deployment. It does **not** reopen closed registration,
and does not change email verification claims or linking rules. Existing admitted accounts can
sign in while registration is closed.

Set `AUTH_PASSWORD_ENABLED=false` to leave password sign-in off. Password sign-in, signup, password
reset and password mutation endpoints are disabled server-side, and sign-in forms are hidden.
The API refuses to start in this mode unless OIDC or directory login is configured. With OIDC, it can still
start while discovery is temporarily unavailable: the provider remains registered, sign-in
returns a temporary error, and background retries recover without restarting. Discovery is lazy
on first use, refreshed in the background, and failures back off up to one minute. Availability
reflects discovery, not a guarantee that the provider's token endpoint is currently reachable.

Account deletion keeps the existing password confirmation for password users. Users without a
password may delete after explicit provider reauthentication within five minutes; **Sign in again** starts a fresh
provider round-trip bound to the signed-in account. Choosing a different identity cannot confirm
deletion or create another account in that flow. A stale or borrowed session alone cannot authorize deletion. With transactional
email configured, **Send deletion code** sends a single-use code to the account email, valid for ten
minutes. Enter it in account settings to confirm deletion. Email-code requests are rate-limited;
invalid, expired or wrong-account codes fail. No password needs to be created for deletion.

## Directory login

Directory login is a second sign-in method beside passwords and OpenID Connect. It uses the
Feishu or Lark authorization-code flow. Leave it unset to keep the other methods alone. It is
not the Feishu messaging app: `LARK_APP_ID` does not turn this login on, and linking a bot does
not sign anyone in. Configure both login credentials together on the API:

```env
LARK_LOGIN_APP_ID=replace-with-app-id
LARK_LOGIN_APP_SECRET=replace-with-app-secret
LARK_LOGIN_NAME=
LARK_LOGIN_SCOPES=
LARK_LOGIN_TENANT=
LARK_LOGIN_ALLOW_SIGNUP_BYPASS=false
LARK_DOMAIN=feishu
```

`LARK_DOMAIN` is the same setting messaging uses (`feishu`, the default, or `lark`). It selects
the accounts and OpenAPI hosts. An unknown value refuses to start when these credentials are set.
The button label is `LARK_LOGIN_NAME`. When that is empty, the label is 飞书 for `feishu` and Lark
for `lark`. The app secret stays on the API. Compose does not pass it to the worker.

Register this redirect URI on the Feishu or Lark app, using the public `BETTER_AUTH_URL` origin:

```text
https://app.example.com/api/auth/callback/directory
```

Web, Electron and mobile use that same redirect. Sign-in and linking request the directory
command line's user scopes (catalog 1.0.99), plus the contact email
(`contact:user.email:readonly`), employment (`contact:user.employee:readonly`), and
`offline_access` so the token can be refreshed. Enable each of those as a user permission on the
app and publish a version before this login asks for them. Requesting a scope the app has not
enabled makes the authorization page fail. `LARK_LOGIN_SCOPES` adds more scopes. It does not
replace that set. `im:message.send_as_user` is not requested: a bulk consent that includes it
waits on a review and blocks the rest. Authorization uses PKCE. The token exchange is the v2
endpoint, which is the one that accepts that PKCE verifier. The refresh token is stored encrypted
on the account and rotated when it is used. The app secret stays on the API and is not given to
the command. A worker that has the same login settings can open the grant. Compose does not pass
the secret to the worker, so those commands stay off there. A person who linked before this set
was published signs in or links again so the new consent is stored. Until then, directory
commands ask them to sign in again.

When the profile includes an enterprise mailbox, that address is used. Otherwise the contact
email is used. Feishu says both are imported by an administrator and are not proof that the
person controls the mailbox. BotCamp stores the address as unverified and does not mark it
verified from this login. A later directory sign-in does not change the account email or its
verification. A profile with no email cannot sign in.

The identity is that application's `open_id`, bound to the accounts host
(`https://accounts.feishu.cn` or `https://accounts.larksuite.com`). Replacing the Feishu app
changes `open_id`, so old links no longer match. Link the new identity from the existing
signed-in account. `LARK_LOGIN_TENANT`, when set, must equal the profile's `tenant_key`. A
different organization cannot sign in.

Sign-in attaches this directory identity to an existing account when the addresses match. The
existing account keeps its email and whether that email is verified. The directory address is an
imported contact, not proof that the person controls the mailbox, so the merge trusts the
directory for that address. A directory identity that is already linked stays on its account. Account settings shows this
login method whenever it is configured. The row's label is the configured name. Before it is
linked, the row offers a link. After linking, the row shows that person's name and picture.
Linking uses the signed-in browser session and does not require the addresses to match. It does
not change the account email or its verification.

A signed-in account can set a password from that same sign-in list. Setting it does not change
the account email or whether that email is verified. The directory link can be removed only after
a password exists. Until then, the row asks for a password first and the link stays. After the
link is removed, sign-in uses that same email and the password. Password sign-in still follows
the allowlist rule above: a nonempty allowlist requires a verified mailbox, including this one.

Signup follows closed registration and the deployment allowlist. A directory address does not
satisfy an allowlist that also requires a verified mailbox. An account that already exists is
signed in anyway, including when registration is closed or the address is outside the allowlist.
`LARK_LOGIN_ALLOW_SIGNUP_BYPASS=true`
admits these identities without applying the allowlist. Enable it only when the directory
controls who may join this deployment. It does not reopen closed registration, and it does not
mark the mailbox verified. Password-disabled mode can use this login instead of OIDC.

Account deletion can ask the directory to show its consent screen again. The directory has no
authentication-time claim, so the proof is that completed consent round-trip, bound to the same
`open_id` and the session that started it. The proof expires five minutes after the callback.
That is weaker than OpenID Connect, whose proof requires a fresh `auth_time`: a directory
session that is still signed in can consent without a new password. Password verification and
emailed deletion codes remain available. Callbacks are single-use.

## Passkeys

Passkeys are not offered. Settings does not add one, and sign-in does not accept one. `WEB_ORIGIN`
does not turn them on. Deleting an account still removes any passkey rows stored earlier.
