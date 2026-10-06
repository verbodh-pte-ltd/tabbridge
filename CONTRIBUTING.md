# Contributing to TabBridge

Anyone is welcome to use, fork, fix and extend TabBridge. It is open source under the
[Apache License 2.0](LICENSE): you can use it for free, change it, ship it in your own products,
commercial or not, as long as you keep the license and copyright notice.

## Ways to help

- **Report a bug or ask for a feature:** open an issue at
  https://github.com/verbodh-pte-ltd/tabbridge/issues. Say what you ran, what you expected and what
  happened, with your OS, Chrome version and agent (Claude Code, Codex, Gemini CLI…).
- **Fix or add something:** fork the repo, make a branch, open a pull request into `main`.
- **Add a tool:** the list agents see is in `bridge/src/shared/tools.ts`; each tool's work is in
  `extension/src/` (`tools.ts`, `actions.ts` or `inspect.ts`). The unit test checks the two lists match.

## Build and test

You need Node.js 20+ and Chrome.

```
npm install
npm run build
npm test                          # unit tests, no browser
node bridge/dist/cli.js install   # registers the host for your user
npm run test:live                 # real Chrome in a throwaway profile, every tool
```

The live test uses its own Chrome profiles and a local test site, and pins every call to its own
test browser, so your everyday Chrome is never touched.

## What a pull request needs

- **A test for the change:** a unit test in `tests/`, and a live check in `tests/live/run.mjs` when it
  changes what happens in the browser. Run both before opening the PR.
- **Green checks:** GitHub runs the build and unit tests on every pull request.
- **A review:** a maintainer approves before it merges. `main` can't be pushed to directly by
  contributors, force-pushed or deleted.
- **Safety stays on by default:** don't weaken the risky-click question, hidden secrets, the
  per-agent tab rules or the `<untrusted-page-content>` wrapping without discussing it in an issue first.
- **Plain words in anything the user sees:** settings, prompts and errors say what happens and what to
  do next.
- **No secrets, no real people's data:** test pages use made-up names (Acme…).

## License of contributions

By opening a pull request you agree that your contribution is licensed under the Apache License 2.0,
the same as the rest of the project (section 5 of the license).
