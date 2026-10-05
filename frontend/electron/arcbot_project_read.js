const PROJECT_READ_TOOL = {
  type: "function",
  name: "arcrho_project_read",
  description: "Read the active project's methods through the ArcRho Gateway. Call with kind=catalog first to discover read kinds and their arguments. Project scope is fixed by the UI; reserving_class defaults to the class open in the UI when omitted. No saves or mutations are available.",
  inputSchema: {
    type: "object", properties: {
      kind: { type: "string" },
      arguments: { type: "object", additionalProperties: true },
    }, required: ["kind", "arguments"], additionalProperties: false,
  },
};

// The registry owns method families and request arguments. This policy exposes
// method loads and the two discovery reads, never simulations or mutations.
const PROJECT_READ_SCRIPT = `
import json, sys
from arcrho_workspace_read_contract import WORKSPACE_READ_KINDS
from arcrho_api.gateway import GatewayClient
request = json.load(sys.stdin)
project = request['project']
allowed = {name: spec for name, spec in WORKSPACE_READ_KINDS.items()
           if name in ('reserving_class_combinations', 'dataset_index')
           or (spec.function.startswith('load_') and 'method_name' in spec.required)}
kind = request['kind']
if kind == 'catalog':
    result = {name: {'required': spec.required, 'optional': spec.optional}
              for name, spec in allowed.items()}
else:
    if kind not in allowed:
        raise ValueError('ArcBot exposes method loads and discovery reads only')
    arguments = request.get('arguments') or {}
    if 'project_name' in arguments and arguments['project_name'] != project:
        raise ValueError('Read is outside the active project')
    arguments['project_name'] = project
    spec = allowed[kind]
    active_class = request.get('reserving_class') or ''
    if active_class and not arguments.get('reserving_class') and 'reserving_class' in (*spec.required, *spec.optional):
        arguments['reserving_class'] = active_class
    result = GatewayClient().read(kind, **arguments)
print(json.dumps(result, ensure_ascii=False))
`;

function activeProject(context) {
  if (context?.disabled) return "";
  return String(context?.fields?.project || context?.projectInstance?.projectName || context?.projectName || "").trim();
}

// The reserving class open in the UI; reads default to it when ArcBot names none.
function activeReservingClass(context) {
  if (context?.disabled) return "";
  return String(context?.activeNestedWindow?.path || context?.projectInstance?.selectedPath || context?.fields?.reservingClass || "").trim();
}

async function readArcBotProject(params, context, runPython) {
  const project = activeProject(context);
  if (!project) throw new Error("Open a project and enable App Context before reading its methods.");
  const input = params?.arguments || {};
  if (params?.tool !== PROJECT_READ_TOOL.name) throw new Error("Unsupported ArcBot tool.");
  if (input.arguments?.project_name && input.arguments.project_name !== project) throw new Error("Read is outside the active project.");
  return runPython(PROJECT_READ_SCRIPT, JSON.stringify({ project, reserving_class: activeReservingClass(context), kind: input.kind, arguments: input.arguments || {} }));
}

module.exports = { PROJECT_READ_TOOL, PROJECT_READ_SCRIPT, activeProject, activeReservingClass, readArcBotProject };
