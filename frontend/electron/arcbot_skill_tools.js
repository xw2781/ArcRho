const RUN_MACRO_TOOL = {
  type: "function",
  name: "arco_run_macro",
  description: "Run one library macro the active skill names, such as opening a dataset window in the user's Arco. Only available while a skill is running; macro_id must be one of the skill's macros. Returns the macro's result.",
  inputSchema: {
    type: "object", properties: {
      macro_id: { type: "string" },
    }, required: ["macro_id"], additionalProperties: false,
  },
};

// The shared skill read returns the skill's front matter fields, its instructions
// and its reference files; the model gets all of it as one block of the prompt.
function buildSkillPrompt(skill) {
  if (!skill) return "";
  const parts = [
    `# Skill: ${skill.title}`,
    "A skill is running. Follow it step by step. It is advisory: never change the user's data, and never read another project unless the skill's steps call for it.",
    skill.instructions || "",
  ];
  for (const reference of Array.isArray(skill.references) ? skill.references : []) {
    parts.push(`## Reference: ${reference.name}\n\n${String(reference.text || "").trim()}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

// The macro runs in the user's own Arco through the app server, as it would from
// the Macros panel. A macro the skill did not name is refused.
async function runSkillMacro(params, skill, postAppServerJson) {
  if (params?.tool !== RUN_MACRO_TOOL.name) throw new Error("Unsupported ArcBot tool.");
  const macroId = String(params?.arguments?.macro_id || "").trim();
  if (!skill || !skill.macros.includes(macroId)) throw new Error("That macro is not available to the running skill.");
  return JSON.stringify(await postAppServerJson("/scripting/run-macro", { macro_id: macroId, active_context: {} }));
}

module.exports = { RUN_MACRO_TOOL, buildSkillPrompt, runSkillMacro };
