# Connect apps

Choose **Connect apps** at the bottom of the sidebar to open **Integrations**. The list there is **QQ邮箱**, **Notion**, and the directory sign-in when that sign-in is configured.

## Connect QQ邮箱

1. Choose **Connect** on **QQ邮箱**.
2. Under **Mailbox**, enter the mailbox address.
3. Under **Authorization code**, enter the 16-character authorization code from QQ Mail. This is that code, not the password you use to sign in on the web.
4. Under **Permission**, choose **只读** or **可发信**. **只读** is read-only. **可发信** includes sending.
5. Choose **Test and save**. BotCamp signs in to the mailbox and keeps the connection only when that sign-in works. The code is stored encrypted and is not shown again.

A saved mailbox shows **Connected**. Choose **Disconnect** to remove it. To replace the code, disconnect, then connect again with the new one. You can also revoke the code in QQ Mail's authorization-code settings.

Ask the bot to connect **QQ邮箱** in chat when you want the same sign-in on a card. After that card is saved, the bot can list, open, and search the mailbox. It can send only when **可发信** was the permission you saved. Those tools show up on the bot's next turn.

## Directory

When directory sign-in is configured, its row uses the same name as the sign-in button. Signing in with it, or linking it from account settings, connects it. There is no separate switch. The bot can then use that person's directory commands: calendar, docs, drive, messages, mail, and the other command groups from that sign-in. A command that changes data asks for approval first. **Disconnect** is not on this row. Unlinking stays in account settings and still requires a password. A linked account from before the wider consent has to sign in or link again before those commands work.

## Connect Notion

Choose **Connect** on **Notion** and sign in to the workspace. After that sign-in, the bot can search and edit the pages you can open. Ask the bot to connect **Notion** in chat when you want the same sign-in on a card.

> [!NOTE]
> The permission you pick is stored with the connection. Saving it does not open a catalog of other apps.

## APIs without an integration

For a service with only an API key or a website login, ask the bot to save it. See
[Reusable credentials](./bot-secrets.md).
