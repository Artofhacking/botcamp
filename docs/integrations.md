# Connect apps

Choose **Connect apps** at the bottom of the sidebar to open **Integrations**. The list there is **QQ邮箱**, **Notion**, **GitHub**, and the directory sign-in when that sign-in is configured.

## Connect QQ邮箱

1. Choose **Connect** on **QQ邮箱**.
2. Under **Permission**, choose **只读** or **可发信**. **只读** is read-only. **可发信** includes sending.
3. Choose **Connect** again and sign in on the QQ Mail page.
4. On the desktop app, that sign-in finishes when you approve it. In a browser, copy the address the page lands on and paste it under **Callback address**, then choose **Submit**.

A saved mailbox shows **Connected**. Choose **Disconnect** to remove it. To change the permission, disconnect, then connect again and choose the other one.

Ask the bot to connect **QQ邮箱** in chat when you want the same sign-in on a card. After that sign-in, the bot can use the mailbox tools from the next turn. It can send only when **可发信** was the permission you saved.

## Directory

When directory sign-in is configured, its row uses the same name as the sign-in button. Signing in with it, or linking it from account settings, connects it. There is no separate switch. The bot can then use that person's directory commands: calendar, docs, drive, messages, mail, and the other command groups from that sign-in. A command that changes data asks for approval first. The `directory_read` and `directory_write` tool descriptions name that app, so asking for its messages or documents does not require naming a command. The consent asks only for permissions the app has enabled; enable another one and link again to use it. **Disconnect** is not on this row. Unlinking stays in account settings and still requires a password. A linked account from before the wider consent has to sign in or link again before those commands work.

## Connect Notion

Choose **Connect** on **Notion** and sign in to the workspace. After that sign-in, the bot can search and edit the pages you can open. Ask the bot to connect **Notion** in chat when you want the same sign-in on a card.

> [!NOTE]
> The permission you pick is stored with the connection. Saving it does not open a catalog of other apps.


## Connect GitHub

Choose **Connect** on **GitHub**. Enter the client ID and secret of an OAuth app, and set that app's callback to the redirect address shown there, then sign in. After that sign-in, the bot can work with the repositories, issues, and pull requests you can open. Ask the bot to connect **GitHub** in chat when you want the same sign-in on a card. GitHub does not register a client for this sign-in, so the client ID is required.

## APIs without an integration

For a service with only an API key or a website login, ask the bot to save it. See
[Reusable credentials](./bot-secrets.md).
