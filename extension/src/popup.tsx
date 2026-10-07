// The toolbar pane. TabBridge opens it by itself when it needs an answer (chrome.action.openPopup;
// Chrome's side panel can't open without a click), so questions come first, then the status.
// Closing the pane doesn't answer anything: the question waits, the badge counts it, and
// clicking the toolbar icon brings it back.
import { PanelRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Actions, Agents, Header, NotConnected, Questions, useLive, YoloRow } from "./pane/shared.tsx";
import { Button } from "./ui/button.tsx";

function Pane() {
  const { status, approvals } = useLive();
  const answered = useRef(false);

  // Opened for a question and every question is answered: get out of the way.
  useEffect(() => {
    if (answered.current && approvals.length === 0) window.close();
  }, [approvals]);

  const openConsole = async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id! });
    window.close();
  };

  return (
    <main className="w-[360px]">
      <Header status={status} />
      <YoloRow />
      <Questions approvals={approvals} onAnswered={() => { answered.current = true; }} />
      <NotConnected status={status} />
      <Agents status={status} />
      <Actions>
        <Button variant="ghost" size="sm" className="col-span-2" onClick={openConsole}>
          <PanelRight /> Open the live console
        </Button>
      </Actions>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Pane />);
