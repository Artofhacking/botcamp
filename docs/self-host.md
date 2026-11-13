# Server operation

These pages describe how a running API, worker, and bot computers are configured. BotCamp does not offer a self-host install.

## Configure and operate

- [Configuration](./self-host-configuration.md): how settings reach each service, run limits, the
  database and outbound proxies.
- [Secrets](./self-host-secrets.md): the required keys and how to keep them.
- [Sign-in and accounts](./self-host-accounts.md): who can sign up, email, SSO, directory login,
  and passwords.
- [Models](./self-host-models.md): model providers, local models, approvals, media generation and
  voice.
- [Tools and integrations](./self-host-integrations.md): web search, memory, MCP servers,
  messaging apps, cloud coding agents and payments.
- [Computer providers](./self-host-sandbox-providers.md) and
  [Docker computers](./self-host-docker-computers.md): where bot computers run and how they are
  limited.
- [Storage and encryption](./self-host-storage.md): content encryption, object storage and upload
  limits.
- [Backup and restore](./self-host-backups.md) and [upgrading](./self-host-upgrading.md).
- [Logs and monitoring](./self-host-observability.md): logs, error reports, traces, security events
  and alerts.
- [Audit log](./self-host-audit-log.md): who did what in each organization, retention, export
  and SIEM forwarding.
- [Apps and clients](./self-host-clients.md): mobile and desktop apps, push, client updates and web
  page settings.
- [Billing](./self-host-billing.md): optional Stripe plans and model credits.

## Reporting a problem

From a checkout:

```bash
docker compose -f infra/compose/docker-compose.yml exec api node dist/cli/diagnostics.js
```

The report lists the revision, which features are on, migration status, each bot's MCP servers with
their health, and the latest runs. It prints no secrets, settings values, names, addresses,
paths or message content; servers, bots and runs appear only as short hashes.

When a user asks their bot to report a bug or send feedback, the report is saved on your server
in the `feedback_reports` table, with the chat, bot and run it came from. Nothing is sent to the
BotCamp project.
