import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { ABOUT_CSS } from '../../../ds-bot/src/client/about.js'
import { BOT_SETTINGS_CSS } from '../../../ds-bot/src/client/bot-settings.js'
import { BROWSER_CSS } from '../../../ds-bot/src/client/browser-pane.js'
import { FEEDBACK_CSS } from '../../../ds-bot/src/client/feedback.js'
import { FOLDER_CSS } from '../../../ds-bot/src/client/folder-menu.js'
import { GROUP_SETTINGS_CSS } from '../../../ds-bot/src/client/group-settings.js'
import { installLocale } from '../../../ds-bot/src/client/i18n.js'
import { MEMBER_CSS } from '../../../ds-bot/src/client/member-status.js'
import { MODEL_CSS } from '../../../ds-bot/src/client/model-menu.js'
import { PROVIDERS_CSS } from '../../../ds-bot/src/client/providers-page.js'
import { SCHEDULE_CSS } from '../../../ds-bot/src/client/schedules.js'
import { SECRET_CSS } from '../../../ds-bot/src/client/secret-card.js'
import { SIDE_CSS } from '../../../ds-bot/src/client/side-chat.js'
import { SIDEBAR_CSS } from '../../../ds-bot/src/client/sidebar.js'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../ds-bot/src/client/styles.js'
import { USAGE_CSS } from '../../../ds-bot/src/client/usage-page.js'
import { WIDGET_CSS } from '../../../ds-bot/src/client/widget-cell.js'
import { createLocale } from './locale.js'
import { installDesktopBridge } from './desktop/bridge.js'
import { clientMode, detectPlatform, installClientFetch } from './session.js'
import { Gate } from './gate.js'
import './app.css'

installDesktopBridge()
installLocale(createLocale(navigator.language))
document.documentElement.lang = navigator.language
if (clientMode()) {
  installClientFetch()
  const platform = detectPlatform()
  document.documentElement.dataset.client = ''
  document.documentElement.dataset.platform = platform
  if (platform === 'macos') document.documentElement.dataset.mac = ''
  document.title = 'BotCamp'
}
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
for (const [tag, text] of [
  ['shell', SHELL_CSS], ['sidebar', SIDEBAR_CSS], ['conversation', CONVERSATION_CSS], ['secrets', SECRET_CSS], ['providers', PROVIDERS_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS], ['usage', USAGE_CSS], ['schedules', SCHEDULE_CSS],
  ['feedback', FEEDBACK_CSS], ['about', ABOUT_CSS], ['members', MEMBER_CSS],
  ['widgets', WIDGET_CSS], ['side', SIDE_CSS], ['browser', BROWSER_CSS],
]) installStyles(text, tag)

// The plugin's colors switch on body[data-ds-dark-theme]. A saved choice wins; otherwise
// the system light or dark mode sets it.
const COLOR_KEY = 'botcamp-color'
const darkQuery = matchMedia('(prefers-color-scheme: dark)')
const paintScheme = () => {
  const choice = localStorage.getItem(COLOR_KEY)
  const dark = choice === 'dark' || (choice !== 'light' && darkQuery.matches)
  document.body.toggleAttribute('data-ds-dark-theme', dark)
}
paintScheme()
darkQuery.addEventListener('change', paintScheme)
window.addEventListener('botcamp:color', paintScheme)

createRoot(document.getElementById('root')).render(h(Gate))
