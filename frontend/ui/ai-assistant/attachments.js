export function getAttachmentExtension(fileName) {
  const leaf = String(fileName || "").split(/[\\/]/).pop() || "";
  const match = leaf.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

export function getAttachmentIconKind(fileName) {
  const ext = getAttachmentExtension(fileName);
  if (["csv", "tsv", "xlsx", "xls", "xlsm", "json", "jsonl", "parquet"].includes(ext)) return "data";
  if (["py", "r", "sql", "js", "ts", "html", "css", "xml", "yaml", "yml", "toml", "ini"].includes(ext)) return "code";
  if (["md", "txt", "log", "ipynb", "arcnb"].includes(ext)) return "note";
  return "file";
}

export function getAttachmentTypeLabel(fileName) {
  const ext = getAttachmentExtension(fileName);
  if (!ext) return "File";
  if (["md", "markdown"].includes(ext)) return "MD";
  return ext.toUpperCase();
}

export function getAttachmentIconSvg(kind) {
  if (kind === "data") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect><path d="M5 10h14"></path><path d="M10 5v14"></path><path d="M14 5v14"></path></svg>';
  }
  if (kind === "code") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l-6-6 6-6"></path><path d="M15 6l6 6-6 6"></path></svg>';
  }
  if (kind === "note") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h8l4 4v12H7z"></path><path d="M15 4v5h4"></path><path d="M10 13h6"></path><path d="M10 17h4"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path></svg>';
}
