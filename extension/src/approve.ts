import type { Answer, Approval } from "./permissions.ts";

const id = new URLSearchParams(location.search).get("id");

function button(text: string, answer: Answer, style = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  if (style) b.className = style;
  b.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "approval_answer", id, answer });
    window.close();
  });
  return b;
}

async function render(): Promise<void> {
  const approval: Approval | null = await chrome.runtime.sendMessage({ type: "approval_get", id });
  const buttons = document.getElementById("buttons")!;
  if (!approval) {
    document.getElementById("title")!.textContent = "This request has ended";
    document.getElementById("lead")!.textContent = "It was answered or timed out. You can close this window.";
    return;
  }
  const detail = document.getElementById("detail")!;
  if (approval.kind === "site") {
    document.getElementById("title")!.textContent = `Let ${approval.client} use ${approval.origin}?`;
    document.getElementById("lead")!.textContent = `${approval.client} wants to read and act on this site in its TabBridge tabs, signed in as you.`;
    detail.textContent = approval.detail;
    buttons.append(
      button("Allow once", "once", "primary"),
      button("Always allow this site", "always"),
      button("Block", "block", "danger"),
    );
  } else {
    document.getElementById("title")!.textContent = `Let ${approval.client} do this?`;
    document.getElementById("lead")!.textContent = `On ${approval.origin}:`;
    detail.textContent = approval.detail;
    document.getElementById("hint")!.textContent = "It looks like it sends, buys, deletes or publishes something.";
    buttons.append(button("Allow", "allow", "primary"), button("Don't allow", "deny", "danger"));
  }
  // A stray Enter must never approve a risky action: focus "Don't allow" there.
  ((approval.kind === "action" ? buttons.lastElementChild : buttons.firstElementChild) as HTMLElement)?.focus();
}
render();
