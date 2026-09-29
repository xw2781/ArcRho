function registerNotebookPythonIntelligence() {
  const ownsModel = (model) => cells.some((cell) => cell.editor?.getModel() === model);

  async function request(path, model, position, token, expression) {
    const code = expression ?? model.getValue();
    const version = model.getVersionId();
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const response = await scriptingFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, cursor_pos: expression?.length ?? model.getOffsetAt(position) }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      return token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version ? null : data;
    } catch {
      return null;
    } finally {
      subscription.dispose();
    }
  }

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")", "="],
    async provideSignatureHelp(model, position, token) {
      if (!ownsModel(model)) return null;
      const data = await request("/scripting/complete", model, position, token);
      if (!data?.signature) return null;
      return {
        value: {
          signatures: [{
            label: data.signature.signature,
            documentation: data.signature.docstring,
            parameters: data.signature.parameters.map((parameter) => ({ label: parameter.label })),
          }],
          activeSignature: 0,
          activeParameter: data.active_parameter,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", "(", ","],
    async provideCompletionItems(model, position, _context, token) {
      if (!ownsModel(model)) return { suggestions: [] };
      const data = await request("/scripting/complete", model, position, token);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { suggestions: (data?.suggestions || []).map((item) => ({
        label: item.label,
        insertText: item.insert_text,
        detail: item.detail,
        kind: item.kind === "parameter" ? monaco.languages.CompletionItemKind.Variable : monaco.languages.CompletionItemKind.Function,
        sortText: `${item.kind === "parameter" ? "0" : "1"}${item.label}`,
        range,
        expression: item.expression,
        model,
        position,
      })) };
    },
    async resolveCompletionItem(item, token) {
      if (!item.expression || item.model.isDisposed()) return item;
      const data = await request("/scripting/inspect", item.model, item.position, token, item.expression);
      return data?.found ? { ...item, detail: data.signature || data.type, documentation: data.docstring } : item;
    },
  });

  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, position, token) {
      if (!ownsModel(model)) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const data = await request("/scripting/inspect", model, position, token);
      if (!data?.found) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [
          { value: `\`\`\`python\n${data.signature || data.name}\n\`\`\`` },
          { value: data.docstring.replace(/[\\`*_{}\[\]<>()#+.!|~-]/g, "\\$&") },
        ],
      };
    },
  });
}
