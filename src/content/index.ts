import { BatchRunner } from "./runner";
import type { Message } from "../shared/types";

declare global { interface Window { __fbgpeRunner?: BatchRunner; __fbgpeListenerInstalled?: boolean } }

if (!window.__fbgpeListenerInstalled) {
  window.__fbgpeListenerInstalled = true;
  chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
    if (message.type === "START_BATCH") {
      window.__fbgpeRunner = new BatchRunner();
      void window.__fbgpeRunner.start(message.batchId, message.settings);
      respond({ ok: true });
    } else if (message.type === "STOP_BATCH") {
      window.__fbgpeRunner?.stop();
      respond({ ok: true });
    }
  });
  window.addEventListener("pagehide", () => window.__fbgpeRunner?.navigateAway());
}
