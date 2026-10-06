import { getStatus } from "./settings.ts";

async function render(): Promise<void> {
  const status = await getStatus();
  document.getElementById("dot")!.classList.toggle("on", status.connected);
  document.getElementById("state")!.textContent = status.connected
    ? "Ready. Agents on this computer can connect."
    : status.error ?? "Not connected to the TabBridge host. Run: npx tabbridge install";
  const list = document.getElementById("agents")!;
  list.replaceChildren(...(status.sessions.length ? status.sessions.map((s) => {
    const li = document.createElement("li");
    li.textContent = `${s.client} · ${s.tabs} tab${s.tabs === 1 ? "" : "s"}`;
    return li;
  }) : [Object.assign(document.createElement("li"), { className: "muted", textContent: "None yet." })]));
}

document.getElementById("reconnect")!.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(render, 800);
});
document.getElementById("settings")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.session.onChanged.addListener(render);
render();
