# Desktop app

The desktop app for Mac, Windows and Linux runs the same BotCamp as the web.

## Install

Download it from [BotCamp](https://botcamp.demox.site). The Linux AppImage needs FUSE 2.

## Open

The app opens BotCamp. It does not ask which server to use.

## Let bots use this computer

The desktop app can give bots access to the computer it runs on, to run commands and work with your
files.

Turn on **Let bots use this computer** in **Settings → General** under **Computers**. Your computer
then shows as **Connected** or **Offline** there. Access belongs to the account that turned it on
and ends when that account signs out, resets its password or signs out everywhere. Signing back in
to the same account restores it without asking again.

The app asks **Allow bots to use this computer?** before access is granted. See
[The bot's computer](./computer.md#use-your-own-computer).

> [!WARNING]
> With **Use this Mac**, bots can run commands without asking. Don't choose it for a server other
> people use.

### Route traffic through this computer

Right under **Let bots use this computer**, **Route traffic through this computer** sends bots'
TCP traffic out through your Mac's network, so sites that only your network reaches, or your usual
address, work for them. It needs the switch above and turns off with it. It applies to your own
private computers, never a Team computer other people share. It needs the web, API, supervisor and
desktop app on the same release; the computer reaches a relay on the web service inside its own
Docker network, which forwards to this app.

The computer's page browser keeps its own connection in this release.

## Updates

The app checks for updates and downloads them in the background. When one is ready, an
**Install update** button appears at the bottom of the sidebar, or choose **Restart** when asked.
**Check for Updates…** in the app menu checks now. On a Mac, the app has to be in the Applications
folder for that install. A copy opened from the disk image keeps offering the installer.

## Shortcuts

Windows and Linux use Ctrl where macOS uses Cmd. The desktop app lists them in its menus.

- Cmd+N: create a bot or a group.
- Cmd+K: open the command menu to jump to any bot.
- Cmd+1 to Cmd+9 (desktop app): open one of the first nine bots in the sidebar.
- Ctrl+Tab / Ctrl+Shift+Tab (desktop app): switch to the next or previous bot.
- Cmd/Ctrl+Shift+Down / Cmd/Ctrl+Shift+Up (browser): switch to the next or previous bot.
- Cmd+[ / Cmd+] (Alt+Left / Alt+Right on Windows and Linux, desktop app): go back or forward.
- Cmd+F (desktop app): search.
- Cmd+B: show or hide the sidebar.
- Cmd+, (desktop app): open Settings.
- Esc in the message box: stop the bot's reply.
- Typing anywhere outside a text field starts a message.

The dock icon shows a badge count of unread chats.
