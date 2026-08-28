import { showPageMessageBox } from "./message_box.js?v=20260827a";

export function unreviewedPrecedentNames(saveResult) {
  const candidates = saveResult?.unreviewed_precedents
    ?? saveResult?.sidecar?.unreviewed_precedents
    ?? [];
  if (!Array.isArray(candidates)) return [];
  const names = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const name = String(candidate ?? "").trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function methodSaveReviewWarningCopy(saveResult) {
  const names = unreviewedPrecedentNames(saveResult);
  const count = names.length;
  if (!count) return null;
  const datasetCopy = count === 1
    ? "1 precedent dataset has not been reviewed."
    : `${count} precedent datasets have not been reviewed.`;
  return {
    count,
    names,
    title: "Method saved with review warning",
    message: `${datasetCopy} The current method was saved.`,
  };
}

export function methodReviewDatasetOpenMessage(datasetName, options = {}) {
  const name = String(datasetName ?? "").trim();
  if (!name) return null;
  return {
    type: "arcrho:project-instance-open-dependent-dataset",
    inst: String(options.instanceId ?? "").trim(),
    datasetName: name,
    openMethod: true,
    project: String(options.projectName ?? "").trim(),
    reservingClass: String(options.reservingClass ?? "").trim(),
  };
}

export function openMethodReviewDataset(datasetName, options = {}) {
  const message = methodReviewDatasetOpenMessage(datasetName, options);
  if (!message) return false;
  const hostWindow = options.windowRef ?? window;
  if (!hostWindow?.parent || hostWindow.parent === hostWindow) return false;
  hostWindow.parent.postMessage(message, "*");
  return true;
}

export async function showMethodSaveReviewWarning(saveResult, options = {}) {
  const copy = methodSaveReviewWarningCopy(saveResult);
  if (!copy) return false;
  try {
    await showPageMessageBox({
      title: copy.title,
      message: copy.message,
      tone: "warn",
      links: copy.names.map((name) => ({
        label: name,
        ariaLabel: `Open related method or dataset ${name} in Project Instance`,
      })),
      onLinkClick: (item) => openMethodReviewDataset(item?.label, options),
      documentRef: options.documentRef,
    });
    return true;
  } catch (error) {
    console.warn("Method save review warning could not be displayed.", error);
    return false;
  }
}
