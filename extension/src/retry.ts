// Chrome refuses tab and group edits for a moment while the user drags a tab (or right after a
// window gets focus): "Tabs cannot be edited right now". Wait and try again instead of failing
// the agent's step. Any other error fails at once.

const BUSY = /Tabs cannot be edited right now/i;

export async function whenTabsEditable<T>(edit: () => T | Promise<T>, tries = 20, waitMs = 100): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await edit();
    } catch (err: any) {
      if (i >= tries || !BUSY.test(err?.message ?? "")) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
