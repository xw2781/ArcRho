// Plain-language headlines for ArcBot's tool calls in the work log. A call's
// text is the tool name, then its arguments as JSON, then its output once it
// returns, so a step reads "Reading ..." while it runs and "Read ..." after.
// Chats saved before the tools took the arco_ prefix still name them arcrho_.

const READ_KINDS = {
  catalog: () => "what project data ArcBot can read",
  project_names: () => "the list of projects on the server",
  reserving_class_combinations: () => "the project's reserving classes",
  dataset_index: (args) => (args.reserving_class ? `the datasets in ${lastPathPart(args.reserving_class)}` : "the project's datasets"),
  dataset_cache_load: (args) => `dataset ${quoted(args.dataset_name)}`,
  dataset_grid_load: (args) => `dataset ${quoted(args.dataset_name)}`,
  dataset_sidecar_load: (args) => `the settings of dataset ${quoted(args.dataset_name)}`,
  dfm_method_load: (args) => `DFM ${quoted(args.method_name)}`,
  bornhuetter_ferguson_load: (args) => `Bornhuetter-Ferguson method ${quoted(args.method_name)}`,
  cape_cod_load: (args) => `Cape Cod method ${quoted(args.method_name)}`,
  berquist_sherman_load: (args) => `Berquist-Sherman method ${quoted(args.method_name)}`,
  bootstrap_load: (args) => `bootstrap method ${quoted(args.method_name)}`,
  result_selection_load: (args) => `result selection ${quoted(args.method_name)}`,
  stochastic_consolidation_load: (args) => `stochastic consolidation ${quoted(args.method_name)}`,
};

const TOOLS = {
  project_read: (input, done) => {
    const kind = String(input.kind || "");
    const args = input.arguments && typeof input.arguments === "object" ? input.arguments : {};
    const describe = READ_KINDS[kind] || (() => kind.replace(/_load$/u, "").replace(/_/gu, " ") || "project data");
    const verb = kind === "catalog" ? (done ? "Checked" : "Checking") : (done ? "Read" : "Reading");
    const project = args.project_name ? ` from ${args.project_name}` : "";
    return `${verb} ${describe(args)}${project}`;
  },
  run_macro: (input, done) => `${done ? "Ran" : "Running"} the ${titleCase(input.macro_id)} macro`,
};

function quoted(value) {
  const text = String(value || "").trim();
  return text ? `"${text}"` : "";
}

function lastPathPart(value) {
  return String(value).split(/[\\/]/u).filter(Boolean).at(-1) || String(value);
}

function titleCase(value) {
  return String(value || "").split(/[_\s]+/u).filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

// The headline for one tool call, or "" when the text is not a known ArcBot tool.
export function getAssistantToolLabel(text) {
  const lines = String(text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = /^(?:arco|arcrho)_([a-z_]+)$/u.exec(lines[0] || "");
  const label = match && TOOLS[match[1]];
  if (!label) return "";
  let input = {};
  try {
    input = JSON.parse(lines[1] || "{}") || {};
  } catch {
    // Arguments still streaming in; label from the tool name alone.
  }
  return label(input, lines.length > 2);
}
