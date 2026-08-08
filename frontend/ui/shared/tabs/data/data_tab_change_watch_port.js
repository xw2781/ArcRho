// Host port for the open-window change watch. The Data tab reports dataset
// mutation boundaries (a durable save or run starting/ending) and durable
// dataset state transitions (a completed load, or a completed save that
// re-read the server state) so a host page can pause, start, or rebase its
// object-change watch around self-initiated writes. Hosts that do not watch
// (for example DFM, whose page watch covers the method itself) leave the
// port unconfigured and every notification is a no-op.

let changeWatchHooks = null;

export function configureDataTabChangeWatch(hooks) {
  changeWatchHooks = hooks && typeof hooks === "object" ? hooks : null;
}

function invoke(hookName, detail) {
  try {
    changeWatchHooks?.[hookName]?.(detail);
  } catch {
    // The watch is advisory; host hook failures must not break the Data tab.
  }
}

export function notifyDataTabDatasetMutationStarted(detail = {}) {
  invoke("onMutationStarted", detail);
}

export function notifyDataTabDatasetMutationEnded(detail = {}) {
  invoke("onMutationEnded", detail);
}

export function notifyDataTabDurableDatasetState(detail = {}) {
  invoke("onDurableDatasetState", detail);
}

/** Bracket one durable write so a change-watch poll cannot race it. */
export async function withDataTabDatasetMutation(detail, run) {
  notifyDataTabDatasetMutationStarted(detail);
  try {
    return await run();
  } finally {
    notifyDataTabDatasetMutationEnded(detail);
  }
}
