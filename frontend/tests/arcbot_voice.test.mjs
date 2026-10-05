import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { registerArcBotVoice } = require("../electron/arcbot_voice");
test("dictation routes text to its owner and releases the microphone on stop or destruction", { skip: process.platform !== "win32" }, () => {
  const handlers = new Map(), processes = [], events = [];
  const voice = registerArcBotVoice({ handle: (name, callback) => handlers.set(name, callback) }, () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.kill = () => { proc.killed = true; };
    processes.push(proc); return proc;
  });
  const sender = new EventEmitter(); sender.id = 1; sender.isDestroyed = () => false;
  sender.send = (_channel, event) => events.push(event);
  try {
    handlers.get("arcbot-voice-start")({ sender }, { requestId: "a" });
    processes[0].stdout.emit("data", '{"type":"text","text":"Paid ');
    processes[0].stdout.emit("data", 'loss"}\n');
    assert.deepEqual(events, [{ type: "text", text: "Paid loss", requestId: "a" }]);
    handlers.get("arcbot-voice-stop")({ sender });
    assert.equal(processes[0].killed, true);
    processes[0].stdout.emit("data", '{"type":"text","text":"stale"}\n');
    assert.equal(events.length, 1);
    handlers.get("arcbot-voice-start")({ sender }, { requestId: "b" });
    sender.emit("destroyed");
    assert.equal(processes[1].killed, true);
  } finally { voice.stop(); }
});
