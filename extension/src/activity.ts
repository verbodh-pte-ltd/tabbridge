// What each agent did in this browser, step by step, for the side panel's live console.
// Kept in storage.session (gone when Chrome closes), newest last, at most KEEP steps.
// Summaries never show what was typed or filled in: those can be passwords or card numbers.

export interface Step {
  id: string;
  time: number;
  client: string;
  tool: string;
  summary: string;
  state: "running" | "done" | "failed";
  /** First line of the error, when it failed. */
  error?: string;
}

const KEEP = 100;

type Args = Record<string, any>;

const PLAIN: Record<string, (a: Args) => string> = {
  navigate: (a) => (a.url === "back" ? "Went back" : a.url === "forward" ? "Went forward" : a.url === "reload" ? "Reloaded the page" : `Opened ${a.url}`),
  click: (a) => `Clicked ${a.ref ?? `at ${a.x}, ${a.y}`}`,
  hover: (a) => `Pointed at ${a.ref ?? `${a.x}, ${a.y}`}`,
  type: (a) => `Typed ${String(a.text ?? "").length} characters`,
  form_input: (a) => `Filled ${a.ref}`,
  key: (a) => `Pressed ${a.keys}`,
  scroll: () => "Scrolled",
  find: (a) => `Looked for “${String(a.query ?? "").slice(0, 60)}”`,
  read_page: () => "Read the page",
  get_page_text: () => "Read the page text",
  screenshot: () => "Took a screenshot",
  javascript: () => "Ran a script on the page",
  tab_create: () => "Opened a new tab",
  tab_close: () => "Closed a tab",
  tab_select: () => "Switched tab",
  tabs_list: () => "Listed its tabs",
  wait_for: () => "Waited for the page",
  file_upload: () => "Uploaded a file",
  page_report: () => "Checked the page for errors",
  user_captures: () => "Read what you sent",
};

export function summarize(tool: string, args: Args): string {
  return PLAIN[tool]?.(args ?? {}) ?? tool;
}

async function load(): Promise<Step[]> {
  const { activity } = await chrome.storage.session.get("activity");
  return (activity ?? []) as Step[];
}

/** Records a step as running; call the returned function with the result when it ends. */
export async function startStep(client: string, tool: string, args: Args): Promise<(failed: boolean, error?: string) => Promise<void>> {
  const step: Step = { id: crypto.randomUUID(), time: Date.now(), client, tool, summary: summarize(tool, args), state: "running" };
  await chrome.storage.session.set({ activity: [...(await load()), step].slice(-KEEP) });
  return async (failed, error) => {
    const steps = await load();
    const i = steps.findIndex((s) => s.id === step.id);
    if (i < 0) return;
    steps[i] = { ...steps[i], state: failed ? "failed" : "done", error: failed ? error?.split("\n")[0].slice(0, 200) : undefined };
    await chrome.storage.session.set({ activity: steps });
  };
}
