# TabBridge compared with Claude in Chrome

**Short answer.** TabBridge 0.1.1 does everything Claude in Chrome does for an agent, except run
Claude's own saved shortcuts, and adds the owner's features on top. Claude in Chrome's code isn't
public, so TabBridge is written from scratch to do the same job, for any agent rather than only Claude.

All of this is checked by the live test in real Chrome (53 of 53 checks pass), except where a row
says otherwise.

## Capabilities side by side

| Capability | Claude in Chrome | TabBridge 0.1.1 |
| --- | --- | --- |
| **Which agents can use it** | Claude only | Any MCP agent (Claude Code, Codex, Gemini CLI, Cursor…), plus `tabbridge call` from scripts and apps |
| **Tabs** | tabs_context, tabs_create, tabs_close | tabs_list, tab_create, tab_select, tab_close |
| **Tab group** | one group per session | one shared "TabBridge" group (or one per agent, in Settings); agents only use their own tabs |
| **Open a page** | navigate | navigate, reusing the current tab; opens the first tab itself |
| **Read the page** | read_page, find, get_page_text | read_page, find (controls first, then plain text), get_page_text |
| **Click** | computer: left, right, double, triple click | click: left/right/middle, `clickCount` 1–3, `modifiers` (Control, Shift…) |
| **Hover** | computer: hover | hover |
| **Drag** | computer: left_click_drag | drag: mouse-drag widgets and HTML drag-and-drop |
| **Type and keys** | computer: type, key | type, key (combinations like Control+a) |
| **Scroll** | computer: scroll, scroll_to | scroll by amount, or a ref into view |
| **Forms** | form_input | form_input (text, dropdown, checkbox), reports the field's label |
| **Screenshot** | computer: screenshot | screenshot, also saved as a numbered step in a guide |
| **Zoom** | computer: zoom | zoom, up to 4× sharper on a region |
| **Run JavaScript** | javascript_tool | javascript |
| **Console and network** | read_console_messages, read_network_requests | console_messages, network_requests, plus network_request with headers, timing and bodies |
| **Window size** | resize_window | resize_window |
| **File upload** | file_upload, upload_image | file_upload, asks the user first |
| **Recording** | gif_creator | gif_record: animated GIF saved into the project's guide |
| **Several browsers** | list_connected_browsers, select_browser, switch_browser | browsers: list and pick by name; `TABBRIDGE_BROWSER` for scripts |
| **Saved shortcuts** | shortcuts_list, shortcuts_execute | not copied: they are Claude's own app feature |

## Only in TabBridge (the owner's features)

| Feature | What it does |
| --- | --- |
| **Permissions on by default** | Everything allowed; each one can be switched off in Settings |
| **Ask before risky clicks** | YOLO mode is on at first (no questions). Switched off: send, buy, pay, delete, publish, upload… ask first, in the pane by the toolbar icon; "Don't allow" is the default button |
| **Secrets hidden** | Cookie values, auth headers and token-like storage show as "(hidden)" unless allowed |
| **Optional per-site approval** | Allow once, always allow, or block, per site |
| **Screenshots become a guide** | `tabbridge/NN-topic/` in the agent's project: numbered images and a README of steps |
| **DevTools as tools** | inspect_element, network_request, storage (local, session, cookies, IndexedDB, cache, service workers, manifest), performance, security |
| **page_report** | console errors, failed requests, performance and security in one call |
| **Right-click "Send to my agent"** | the user hands a page or element to the agent (user_captures); not covered by the live test, it needs a real right-click |
| **downloads** | where a downloaded file landed, and whether it finished |
| **Page text marked untrusted** | everything read from a page comes back inside `<untrusted-page-content>` |
| **Open source** | Apache 2.0, https://github.com/verbodh-pte-ltd/tabbridge |

## Not proven yet

- A real Claude Code or Codex session driving TabBridge (the owner paused that check).
- Mac and Linux install; Edge and Brave.
- The Web Store build: 0.1.0 is pending review; 0.1.1 is built but not uploaded.
