# Legacy gateway

These trees are the retired phone-to-desktop relay. The product is the Node API, worker, web console, Electron app, and Android shell. Do not add features here, and do not deploy these files as the current server.

| Path | What it was |
|---|---|
| `server/app.py` | Python account and model gateway. |
| `deploy/deploy.sh` | Copies that Python file into a release directory and restarts its systemd unit. |
| `deploy/nginx/camp.conf` | Per-slot reverse proxy for the relay. |
| `deploy/systemd/botcamp.service` | systemd unit for that gateway. |
| `mobile/` | Device picker for the relay. |
| `agent/` | Host agent that opened the reverse tunnel. |
| `local/` | Sample launchd and env files for that agent. Real keys are not in git. |
| `docs/tke-migration.md` | Notes from an old move of that relay. |
| `docs/architecture.md` before this rewrite | Described the relay. The current architecture is that file now. |

Some of those files still contain deployment hostnames and defaults. Leave them in place. Do not copy those values into new docs, commits, issues, or pull requests.

A change that must touch one of these paths says so in the pull request, and says why `apps/` cannot own the behavior.
