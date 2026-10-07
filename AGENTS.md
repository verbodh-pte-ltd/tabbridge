# AGENTS.md — TabBridge

Instructions for any coding agent (Codex, Claude Code, Gemini CLI…) working **on** this repository.
To **use** TabBridge from an agent, see the skill in `.agents/skills/tabbridge/SKILL.md`.

## What this is

A Chrome extension plus a Node bridge that let any MCP agent drive the user's own Chrome. It is an
integrator only: no AI model, no API key, no server.

```
agent ──MCP stdio──► tabbridge mcp ──local pipe + token──► tabbridge host ──native messaging──► extension ──► Chrome
```

| Folder | What |
| --- | --- |
| `bridge/src/` | the `tabbridge` npm package: `cli.ts` (commands), `mcp.ts` (MCP server), `host.ts` (native host), `client.ts` (pipe client, browser slots), `guide.ts` (screenshot guide), `install.ts` (register/doctor), `bridge-tools.ts` (`browsers`, upload paths) |
| `bridge/src/shared/` | `tools.ts` (every tool's name, description, schema; agent instructions), `protocol.ts` (messages, extension ids) |
| `extension/src/` | `background.ts` (native port), `tools.ts` (core tools), `actions.ts` (hover, drag, zoom, upload, GIF), `inspect.ts` (DevTools tools, page_report), `page-agent.ts` (injected; refs and labels), `permissions.ts` (approvals), `sessions.ts` (tab groups), `cdp.ts` (debugger) |
| `extension/static/` | manifest, popup, settings, approval pages, icons |
| `tests/` | unit tests (`node --test`), `tests/live/` drives real Chrome |
| `scripts/` | build, store zip, store screenshots, demo GIF |
| `store/` | Web Store listing text and images |

## Commands

```
npm install
npm run typecheck
npm run build                     # bridge/dist + extension/dist; syncs the version everywhere
npm test                          # unit tests
node bridge/dist/cli.js install   # register the host for this user (needed for the live test)
npm run test:live                 # real Chrome, throwaway profiles, every tool
npm run package:store             # store/tabbridge-<version>.zip, without the dev "key"
node scripts/demo-gif.mjs         # re-record docs/demo.gif and docs/demo-steps/
```

npm only. Node 20+ (tests run TypeScript directly, so no parameter properties or enums in `.ts`
files the tests import).

## Rules for changes

1. **A tool is three edits:** its definition in `bridge/src/shared/tools.ts`, its handler in
   `extension/src/` (`tools.ts`, `actions.ts` or `inspect.ts`), and a live check in
   `tests/live/run.mjs`. `tests/extension.test.ts` fails if the advertised and implemented lists
   differ. Tools the bridge answers itself go in `BRIDGE_TOOLS`.
2. **Test first, then change.** A unit test for logic; a live check for anything that happens in the
   browser. Run `npm test` and `npm run test:live`; report the counts, and any check that failed.
   Type checks and a build are not proof a tool works.
3. **Safety defaults stay on:** hidden secrets in `inspect.ts`, agents limited to their own tabs
   (`sessions.ts`), blocked sites staying blocked, and `<untrusted-page-content>` around everything
   read from a page. The risky-action question (`RISKY` in `permissions.ts`) is there but YOLO mode
   (`Settings.yolo`) starts on, by the maintainer's decision; the user switches it off in the pane,
   side panel or settings. Changing any of these needs an issue and the maintainer's yes.
4. **Input tools bring their tab to the front** (`foreground`): Chrome drops mouse and key events
   sent to a background tab.
5. **Never type secrets in tests or demos.** Test pages use made-up names (Acme). The repo is public:
   no real names, account ids, tokens or private URLs.
6. **Words the user sees are plain:** settings, approval windows and tool errors say what happened
   and what to do next. Tool descriptions are for agents: short, exact, say when to use the tool.
7. **Version:** bump only `bridge/package.json`; `npm run build` copies it into the manifest and
   `version.ts`. A store release also needs `npm run package:store` and an upload.
8. **Extension ids:** the dev id comes from the `key` in the manifest; the store id is in
   `STORE_EXTENSION_IDS`. The host trusts only these.

## Gotchas

- Branded Chrome ignores `--load-extension`; the live test loads the extension through DevTools
  (`Extensions.loadUnpacked` over `--remote-debugging-pipe`).
- Chrome refuses every extension on Web Store pages. Use the DevTools protocol there, not the extension.
- One host per Chrome; several Chromes take slots 1–9, named in Settings, listed by `browsers`.
- The live test pins its calls to its own named test browser, so it is safe while TabBridge runs in
  the developer's everyday Chrome.

## Git

`main` is protected: no force-push or deletion; changes from contributors come through a pull request
with the `build and unit tests` check green and a review. Commit messages say what changed and why.
