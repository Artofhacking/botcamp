# Architecture

The current product is the Node server, the web console, the Electron shell, and the Android WebView shell. The retired phone-to-desktop relay is [legacy](./legacy.md). Do not extend it.

## Processes

1. **API** (`apps/api`). Accounts, sessions, bots, and chats. When a message or routine becomes due, this process starts the run before the HTTP request returns. See [run execution](./run-execution.md).
2. **Worker** (`apps/worker`). Scheduled and maintenance jobs, plus any run the API hands over on shutdown or memory pressure. It also scans for runs whose owner died. That scan is recovery, not the path a new run takes.
3. **Web**. `apps/web` in development. In production it is a static build. It can live on another origin from the API; `config.js` is that switch (`apps/web/public/config.js`).
4. **Supervisor and computer**. Bot computers are containers or a configured remote sandbox, owned by the supervisor in `infra/sandboxes/supervisor`. The API does not receive the Docker socket. The image and the limits are [sandbox providers](./self-host-sandbox-providers.md).
5. **Desktop** (`apps/desktop`). Electron around the same web UI, plus the native computer on the person's own machine.
6. **Android** (`android/`). A WebView around the hosted console. It is not a second client implementation.

Postgres is the source of truth (`packages/db`). Several API and worker processes may run. A run is claimed with a lease so it executes once. Do not add a global queue or a single-flight lock in front of that start path. The rule is in `AGENTS.md`.

## Shared code

`packages/contracts` is the wire shape. `packages/core` is product logic. `packages/adapters` talks to providers and to operating systems. A provider name does not appear outside adapters and composition roots. UI that both web and desktop render lives in `packages/`, not in one app.

## Computers

A workspace has one shared Team Computer unless a bot is set to Private. Team bots share files and installed tools. Each bot still has its own screen and browser profile. The container is the security boundary. Directories inside it are organization, not isolation. Details and the takeover flow are [the computer](./computer.md) and [computer runtime](./computer-runtime.md).

## Clients and the server

Frontends send intent and render state. The API authorizes, validates, retries, and translates providers. A workflow that exists on the web also exists on desktop, or it degrades for a reason written down in the change.
