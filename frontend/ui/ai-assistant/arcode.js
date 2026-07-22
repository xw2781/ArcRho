import { $, getHostApi, shell } from "../arcode/shared/host_context.js?v=20260614a";
import {
  configureAiAssistant,
  initAiAssistant as initSharedAiAssistant,
  isAiAssistantLauncherVisible,
  toggleAiAssistantLauncherVisible,
} from "./index.js?v=20260622a";

configureAiAssistant({
  appName: "Arcode",
  botName: "ArcBot",
  messageNamespace: "arcode",
  storagePrefix: "arcode",
  contextTimeoutMs: 900,
  projectInstanceContextTimeoutMs: 900,
  enableDfmApproval: false,
  $,
  getHostApi,
  shell,
});

export function initAiAssistant() {
  return initSharedAiAssistant();
}

export {
  isAiAssistantLauncherVisible,
  toggleAiAssistantLauncherVisible,
};
