import { browserLabel, getSettings, getSites, setSettings, setSite, type Settings } from "./settings.ts";

// Each checkbox, and how it maps to a setting. Two are worded the other way round on the page.
const BOXES: [string, keyof Settings, boolean][] = [
  ["allSites", "askNewSites", true],
  ["sharedGroup", "sharedGroup", false],
  ["notify", "notify", false],
  ["confirmRisky", "confirmRisky", false],
  ["yolo", "yolo", false],
  ["hideSecrets", "showSecrets", true],
];

async function render(): Promise<void> {
  const settings = await getSettings();
  for (const [id, key, inverted] of BOXES) (document.getElementById(id) as HTMLInputElement).checked = inverted ? !settings[key] : !!settings[key];

  const nameBox = document.getElementById("browserName") as HTMLInputElement;
  nameBox.placeholder = await browserLabel();
  nameBox.value = settings.browserName;

  const yes = (on: boolean) => (on ? "on" : "off");
  document.getElementById("incognito")!.textContent = yes(await chrome.extension.isAllowedIncognitoAccess());
  document.getElementById("files")!.textContent = yes(await chrome.extension.isAllowedFileSchemeAccess());

  const sites = Object.entries(await getSites()).sort(([a], [b]) => a.localeCompare(b));
  const list = document.getElementById("sites")!;
  if (!sites.length) return;
  list.replaceChildren(...sites.map(([origin, rule]) => {
    const li = document.createElement("li");
    li.className = "row";
    const name = document.createElement("span");
    name.textContent = `${origin} · ${rule === "allow" ? "always allowed" : "blocked"}`;
    const forget = document.createElement("button");
    forget.textContent = "Forget";
    forget.addEventListener("click", async () => { await setSite(origin, null); location.reload(); });
    li.append(name, forget);
    return li;
  }));
}

for (const [id, key, inverted] of BOXES) {
  document.getElementById(id)!.addEventListener("change", async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await setSettings({ [key]: inverted ? !checked : checked });
    render();
  });
}
document.getElementById("saveName")!.addEventListener("click", async () => {
  await setSettings({ browserName: (document.getElementById("browserName") as HTMLInputElement).value.trim() });
  render();
});
document.getElementById("open-chrome")!.addEventListener("click", () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});
render();
