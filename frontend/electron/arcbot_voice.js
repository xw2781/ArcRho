const { spawn } = require("child_process");

// Windows' installed dictation engine: audio stays on this computer.
const DICTATION_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Speech
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new()
  $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $engine.SetInputToDefaultAudioDevice()
  @{type='ready'} | ConvertTo-Json -Compress
  while ($true) {
    $result = $engine.Recognize([TimeSpan]::FromSeconds(10))
    if ($result -and $result.Text) { @{type='text'; text=$result.Text} | ConvertTo-Json -Compress }
  }
} catch {
  @{type='error'; text=$_.Exception.Message} | ConvertTo-Json -Compress
} finally {
  if ($engine) { $engine.Dispose() }
}
`;

function registerArcBotVoice(ipcMain, spawnProcess = spawn) {
  const sessions = new Map();
  const stop = (owner) => {
    const session = sessions.get(owner);
    if (!session) return;
    sessions.delete(owner);
    clearTimeout(session.timer);
    session.sender.removeListener("destroyed", session.destroy);
    session.proc.kill();
  };
  ipcMain.handle("arcbot-voice-stop", event => { stop(event.sender.id); return { ok: true }; });
  ipcMain.handle("arcbot-voice-start", (event, payload) => {
    if (process.platform !== "win32") return { ok: false, error: "Voice input requires Windows speech recognition." };
    const sender = event.sender;
    stop(sender.id);
    const emit = value => {
      if (!sender.isDestroyed()) sender.send("arcbot-voice-event", { ...value, requestId: payload?.requestId });
    };
    const proc = spawnProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(DICTATION_SCRIPT, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const session = { proc, sender, destroy: () => stop(sender.id) };
    sessions.set(sender.id, session);
    sender.once("destroyed", session.destroy);
    session.timer = setTimeout(() => { emit({ type: "stopped" }); stop(sender.id); }, 120000);
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (sessions.get(sender.id) !== session) continue;
        try { emit(JSON.parse(line)); } catch { /* Non-protocol output is not dictated text. */ }
      }
    });
    proc.on("error", error => emit({ type: "error", text: error.message }));
    proc.on("close", () => {
      if (sessions.get(sender.id) !== session) return;
      emit({ type: "stopped" });
      stop(sender.id);
    });
    return { ok: true };
  });
  return { stop: () => { for (const owner of sessions.keys()) stop(owner); } };
}

module.exports = { registerArcBotVoice };
