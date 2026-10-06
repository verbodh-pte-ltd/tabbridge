# Chrome Web Store listing

Pasted into the developer console. Kept here so a new version re-uses the same answers.

## Store listing

**Name:** TabBridge

**Summary (132 characters max):**
Let AI agents on your computer use your Chrome: open pages, click, type, take screenshots and read DevTools data, with your approval.

**Category:** Developer Tools · **Language:** English

**Description:**

TabBridge lets an AI agent that runs on your own computer use your Chrome: Claude Code, Codex, Gemini CLI, Cursor, or any app that speaks the Model Context Protocol (MCP).

TabBridge is only a bridge. It has no AI model and needs no API key. Your agent does the thinking; TabBridge gives it hands in the browser, in your normal profile with your sign-ins.

What an agent can do
• Open pages, go back and forward, reload
• Read the page as a list of elements, find things, read the text
• Click, type, press keys, fill in forms, scroll
• Take screenshots, saved as a numbered step-by-step guide in your project
• See what DevTools sees: console, network requests with headers and bodies, elements and styles, storage, cookies, IndexedDB, cache, service workers, performance and security
• page_report: everything about a broken page in one call
• Right-click any page or element and choose "Send to my agent"

You stay in charge
• Agents only use their own tabs, kept in a TabBridge tab group
• Risky clicks (send, buy, pay, delete, publish…) ask you first
• Cookie values and tokens are hidden from agents unless you allow them
• Optionally, be asked before an agent uses each new site
• Everything stays on your computer: TabBridge has no server

Setup
1. Add TabBridge to Chrome.
2. Run once in a terminal: npx tabbridge install
3. Connect your agent, for example: claude mcp add tabbridge -- npx -y tabbridge mcp

Open source (Apache 2.0): https://github.com/verbodh-pte-ltd/tabbridge

**Images:**
- Icon: extension/static/icons/icon128.png (in the zip)
- Screenshots, 1280×800: store/screenshots/01-settings.png, 02-asks-before-risky-actions.png,
  03-page-report-for-the-agent.png, 04-connected-agents.png
- Small promo tile, 440×280: store/small-promo-tile-440x280.png

**Links:** Homepage and support: https://github.com/verbodh-pte-ltd/tabbridge

## Privacy practices

**Single purpose:**
Lets AI agents that the user runs on their own computer control and read the user's Chrome tabs, through a local connection, so the agents can complete browser tasks for the user.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| debugger | Sends clicks, key presses and typing to tabs the agent uses, takes screenshots, and reads console, network, storage, performance and security details (the same data as DevTools), only in tabs in the agent's TabBridge group or tabs the user sends to it. |
| nativeMessaging | Connects to the TabBridge program the user installs on their computer (npx tabbridge install), which is how the user's local AI agent reaches the extension. |
| tabs | Opens, lists, selects and closes the agent's tabs, and reads their URL and title so the agent knows where it is. |
| tabGroups | Keeps every tab an agent uses in one "TabBridge" group, so the user can see which tabs agents control and agents can't use other tabs. |
| scripting | Reads the page's elements and text, and fills in form fields, on the page the agent is working on. |
| storage | Saves the user's TabBridge settings and the sites they allowed or blocked. |
| notifications | Tells the user when TabBridge is waiting for their approval, and confirms when they sent a page to their agent. |
| downloads | Tells the agent where a file it downloaded was saved and whether the download finished. |
| contextMenus | Adds "Send this page / element to my agent" to the right-click menu. |
| alarms | Reconnects to the local TabBridge program if Chrome paused the extension. |
| Host permission (all sites) | The user's agent may be asked to work on any website the user chooses, so the extension must be able to read and act on any site. The user can require approval per site in settings. |

**Remote code:** No. All code is in the package; nothing is loaded from elsewhere.

**Data usage:** TabBridge sends page content to a program on the user's own computer, at the request of the user's AI agent. The publisher collects nothing. Declare website content as handled (passed to the user's local agent), not sold, not used for anything unrelated to the single purpose, not used for credit decisions.

**Privacy policy URL:** https://github.com/verbodh-pte-ltd/tabbridge/blob/main/PRIVACY.md

## Distribution

Visibility: **Unlisted** first. Switch to **Public** once the owner has installed it from the store and run one task.
