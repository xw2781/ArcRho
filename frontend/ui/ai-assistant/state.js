export const PANEL_MIN_WIDTH = 420;
export const PANEL_DEFAULT_HEIGHT = 640;

export const ATTACHMENT_EXTENSIONS = [
  "txt", "md", "csv", "tsv", "json", "jsonl", "ipynb", "arcnb", "py", "r", "sql",
  "js", "ts", "html", "css", "xml", "yaml", "yml", "toml", "ini", "log",
];

export const WORK_STEP_DEFS = [
  { id: "understanding", label: "Request" },
  { id: "scanning", label: "App context" },
  { id: "executing", label: "Codex work" },
  { id: "finalizing", label: "Result" },
];

export const VISIBLE_WORK_STEP_IDS = new Set(["executing", "finalizing"]);

export const TYPING_FRAME_MS = 18;
export const TYPING_MAX_FRAMES = 220;
export const WORK_TYPING_FRAME_MS = 16;
export const WORK_TYPING_CHARS_PER_FRAME = 4;
