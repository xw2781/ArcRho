export const NOTES_INDENT_UNIT = "    ";

function clampSelectionOffset(value, textLength, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(textLength, Math.trunc(number)));
}

/**
 * Applies the Notes editor's Tab behavior at the current selection.
 *
 * @param {unknown} value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {string} indentUnit
 * @returns {{value: string, selectionStart: number, selectionEnd: number}}
 */
export function indentNotesText(
  value,
  selectionStart,
  selectionEnd,
  indentUnit = NOTES_INDENT_UNIT,
) {
  const text = String(value ?? "");
  const unit = String(indentUnit || NOTES_INDENT_UNIT);
  const start = clampSelectionOffset(selectionStart, text.length, text.length);
  const end = Math.max(start, clampSelectionOffset(selectionEnd, text.length, start));
  const cursor = start + unit.length;
  return {
    value: text.slice(0, start) + unit + text.slice(end),
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

/**
 * Removes one four-space indent (or one tab) from every selected line.
 *
 * @param {unknown} value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {string} indentUnit
 * @returns {{value: string, selectionStart: number, selectionEnd: number}}
 */
export function outdentNotesText(
  value,
  selectionStart,
  selectionEnd,
  indentUnit = NOTES_INDENT_UNIT,
) {
  const text = String(value ?? "");
  const unit = String(indentUnit || NOTES_INDENT_UNIT);
  const start = clampSelectionOffset(selectionStart, text.length, text.length);
  const end = Math.max(start, clampSelectionOffset(selectionEnd, text.length, start));
  const blockStart = text.lastIndexOf("\n", Math.max(0, start) - 1) + 1;

  let endAnchor = end;
  if (start !== end && end > blockStart && text[end - 1] === "\n") {
    endAnchor = end - 1;
  }
  let blockEnd = text.indexOf("\n", endAnchor);
  if (blockEnd === -1) blockEnd = text.length;

  const block = text.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  let removedBeforeStart = 0;
  let removedBeforeEnd = 0;
  let relativeOffset = 0;

  const outdented = lines.map((line) => {
    let removeCount = 0;
    if (line.startsWith(unit)) {
      removeCount = unit.length;
    } else if (line.startsWith("\t")) {
      removeCount = 1;
    }

    const absoluteLineStart = blockStart + relativeOffset;
    relativeOffset += line.length + 1;
    if (removeCount > 0) {
      if (absoluteLineStart < start) {
        removedBeforeStart += Math.min(removeCount, start - absoluteLineStart);
      }
      if (absoluteLineStart < end) {
        removedBeforeEnd += Math.min(removeCount, end - absoluteLineStart);
      }
    }
    return removeCount > 0 ? line.slice(removeCount) : line;
  });

  const nextStart = Math.max(blockStart, start - removedBeforeStart);
  const nextEnd = Math.max(nextStart, end - removedBeforeEnd);
  return {
    value: text.slice(0, blockStart) + outdented.join("\n") + text.slice(blockEnd),
    selectionStart: nextStart,
    selectionEnd: nextEnd,
  };
}
