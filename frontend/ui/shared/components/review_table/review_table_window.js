// Project Instance nested-window host for the shared review-table panel.
//
// The page is opened inside a pi-window iframe by project_instance_review_table.js,
// announces itself with `arcrho:review-table-window-ready`, receives its row payload
// through `arcrho:review-table-window-init`, and reports the user's decision back
// with `arcrho:review-table-window-complete`. The parent Project Instance page owns
// the automation dialog lifecycle and the window frame.
import { createReviewTablePanel } from "./review_table.js?v=20260812b";

const inst = new URLSearchParams(window.location.search).get("inst") || "";
let panel = null;

function postToParent(type, payload = {}) {
  try {
    window.parent?.postMessage({ type, inst, ...payload }, "*");
  } catch {}
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object" || msg.type !== "arcrho:review-table-window-init") return;
  if (panel) return;
  try {
    panel = createReviewTablePanel(msg.options || {}, {
      container: document.getElementById("reviewTableWindowHost"),
      onComplete(result) {
        postToParent("arcrho:review-table-window-complete", {
          accepted: !!result?.accepted,
          selectedRowIds: Array.isArray(result?.selectedRowIds) ? result.selectedRowIds : [],
          reason: String(result?.reason || ""),
        });
      },
    });
    panel.focusSearch();
  } catch (err) {
    postToParent("arcrho:review-table-window-error", {
      error: String(err?.message || err || "Review table failed to render."),
    });
  }
});

postToParent("arcrho:review-table-window-ready");
