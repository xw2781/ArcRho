// Plain-text terminal cursor semantics, shared by live and imported streams.
// Keep the original stream separately for notebook persistence.
function createNotebookStreamText() {
  const lines = [[]];
  let column = 0;

  return {
    append(text) {
      for (const character of String(text || "")) {
        if (character === "\r") {
          column = 0;
        } else if (character === "\n") {
          lines.push([]);
          column = 0;
        } else if (character === "\b") {
          column = Math.max(0, column - 1);
        } else {
          lines[lines.length - 1][column] = character;
          column += 1;
        }
      }
      return lines.map((line) => line.join("")).join("\n");
    },
  };
}
