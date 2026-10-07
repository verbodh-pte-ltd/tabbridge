# TabBridge privacy policy

TabBridge is a Chrome extension and a small local program that let AI agents running on your own
computer use your browser. This policy covers both.

## What TabBridge collects

**Nothing is collected by us.** TabBridge has no server, no account, no analytics and no tracking.
The publisher never receives any data from it.

## What happens to page data

When an AI agent on your computer asks TabBridge to read a page, take a screenshot, or read
console, network or storage details, TabBridge sends that data to the agent over a private pipe on
the same computer, protected by a random token. It does not go anywhere else.

What the agent then does with it is up to the agent you chose (for example Claude Code, Codex or
Gemini CLI), under that agent's own privacy policy. Many agents send what they read to their AI
provider to work on it.

Screenshots an agent takes are saved as files in the folder the agent is working in, so you can keep
a step-by-step record. You can turn this off with `TABBRIDGE_GUIDE=0`.

## What is stored in your browser

- Your TabBridge settings and the list of sites you allowed or blocked, in Chrome's extension storage
  on your computer.
- Pages you send to your agent with right-click › "Send to my agent", until the agent reads them or
  Chrome closes.

## Secret values

By default, cookie values, Authorization headers and storage values that look like tokens or
session ids are hidden from agents. You can change this in TabBridge's settings.

## Permissions and why

| Permission | Used for |
| --- | --- |
| debugger | Clicking, typing, screenshots, console, network and DevTools details in tabs an agent uses |
| nativeMessaging | Talking to the TabBridge program on your computer, which the agent connects to |
| tabs, tabGroups | Opening the agent's tabs and keeping them in the TabBridge tab group |
| scripting, all sites | Reading the page and finding elements on whatever site the agent is asked to use |
| storage | Settings and your site choices |
| notifications | Telling you when TabBridge is waiting for your answer |
| downloads | Telling the agent where a file it downloaded was saved |
| contextMenus | The right-click "Send to my agent" menu |
| alarms | Reconnecting to the TabBridge program if Chrome paused the extension |
| sidePanel | The live console: each step an agent takes, its questions, and notes you send to your agent |

## Contact

Questions: support@verbodh.com · Source code: https://github.com/verbodh-pte-ltd/tabbridge
