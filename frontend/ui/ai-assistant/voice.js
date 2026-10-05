import { addComposerTip } from "./composer-tip.js";

export function installVoiceInput({ host, input, controls, onInput, getSessionId }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "aiAssistantComposerIconBtn aiAssistantVoiceBtn";
  const icon = document.createElement("span");
  icon.className = "aiAssistantVoiceIcon";
  icon.setAttribute("aria-hidden", "true");
  button.append(icon);
  const tip = addComposerTip(button, "Dictate");
  button.setAttribute("aria-label", "Start voice input");
  button.setAttribute("aria-pressed", "false");
  const status = document.createElement("span");
  status.className = "aiAssistantVoiceStatus";
  status.setAttribute("role", "status");
  controls.prepend(button);
  controls.parentNode.append(status);
  let requestId = "";
  let sessionId = "";
  const reset = () => {
    requestId = "";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Start voice input");
    tip.textContent = "Dictate";
  };
  const stop = () => {
    reset();
    status.textContent = "";
    void host.arcBotVoiceStop?.();
  };
  host.onArcBotVoice?.(event => {
    if (!requestId || event.requestId !== requestId) return;
    if (sessionId !== getSessionId()) { stop(); return; }
    if (event.type === "ready") status.textContent = "Listening locally. Pause between phrases; review before sending.";
    if (event.type === "text") {
      const separator = input.value && !/\s$/.test(input.value) ? " " : "";
      input.value += separator + event.text;
      onInput();
    }
    if (event.type === "error") {
      status.textContent = `Voice input unavailable: ${event.text}. Check your Windows microphone and speech language settings.`;
      reset();
      void host.arcBotVoiceStop?.();
    }
    if (event.type === "stopped") { reset(); status.textContent = "Dictation stopped. Review your text before sending."; }
  });
  button.addEventListener("click", async () => {
    if (requestId) { stop(); return; }
    sessionId = getSessionId();
    requestId = `voice-${Date.now()}`;
    const startingId = requestId;
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", "Stop voice input");
    tip.textContent = "Stop dictation";
    status.textContent = "Starting microphone…";
    try {
      const result = await host.arcBotVoiceStart(requestId);
      if (requestId === startingId && !result?.ok) throw new Error(result?.error || "Could not start dictation");
    } catch (error) {
      if (requestId !== startingId) return;
      reset();
      status.textContent = String(error.message || error);
    }
  });
  window.addEventListener("pagehide", stop);
  return { stop };
}
