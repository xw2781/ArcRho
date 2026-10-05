// The overlay an agent shows inside the Arco window it drives: an edge glow, the agent's own
// pointer, and a banner naming the agent and its current step, with Pause, Resume and End.
//
// The host injects this file into an isolated world of the window's top frame, so page scripts
// can neither see nor change it. The host owns the session and the pointer's path; this script
// only draws what it is told and remembers which banner button the person pressed until the host
// asks. Coordinates arrive in window pixels and are divided by the page zoom here.
(() => {
  if (window.__agentOverlay) return;

  const WAITING_AFTER_MS = 25000;

  let host = null;
  let parts = null;
  let assets = null;
  let state = {};
  let request = null;
  let frameHandle = 0;
  let renderedAt = 0;

  // Pointer motion, all in window pixels.
  let pos = { x: 0, y: 0 };
  let lastFrameAt = 0;
  let restSince = 0;
  let prevX = 0;
  let prevT = 0;
  let tilt = 0;
  let pressStart = -1;
  let pulseStart = -1;

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function button(label, kind, parent) {
    const node = el("button", kind === "primary" ? "button primary" : "button", parent);
    node.type = "button";
    node.textContent = label;
    return node;
  }

  function build() {
    host = document.createElement("arcrho-agent-control");
    const root = host.attachShadow({ mode: "closed" });
    const style = el("style", "", root);
    style.textContent = assets.css;
    el("div", "edges", root);

    const pointer = el("div", "pointer", root);
    const glow = el("div", "glow", pointer);
    const ripple = el("div", "ripple", pointer);
    const arrow = el("div", "arrow", pointer);
    const svg = new DOMParser().parseFromString(assets.svg, "image/svg+xml").documentElement;
    arrow.appendChild(document.importNode(svg, true));

    const banner = el("div", "banner", root);
    el("span", "dot", banner);
    const text = el("span", "text", banner);
    const agent = el("span", "agent", text);
    const action = el("span", "action", text);
    const stateLabel = el("span", "state", banner);
    const clock = el("span", "clock", banner);
    const pause = button("Pause", "", banner);
    const resume = button("Resume", "primary", banner);
    const end = button("End", "", banner);
    pause.addEventListener("click", () => { request = "pause"; });
    resume.addEventListener("click", () => { request = "resume"; });
    end.addEventListener("click", () => { request = "end"; });

    parts = { pointer, glow, ripple, arrow, banner, agent, action, stateLabel, clock, pause, resume, end };
    (document.documentElement || document.body).appendChild(host);
    if (!frameHandle) frameHandle = requestAnimationFrame(tick);
  }

  function ensureAttached() {
    if (!host) build();
    else if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }

  function zoom() {
    const value = Number(state.zoom);
    return value > 0 ? value : 1;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function render() {
    const paused = !!state.paused;
    const waiting = !paused && Date.now() - Number(state.lastCommandAt || 0) > WAITING_AFTER_MS;
    host.toggleAttribute("data-paused", paused);
    host.toggleAttribute("data-waiting", waiting);
    parts.banner.dataset.position = state.position || "TopCenter";
    parts.agent.textContent = state.agent || "Agent";
    parts.action.textContent = paused ? (state.pauseReason || "") : (state.action || "");
    parts.stateLabel.textContent = paused ? "Paused" : (waiting ? "Waiting" : "");
    parts.stateLabel.hidden = !parts.stateLabel.textContent;
    parts.clock.textContent = formatClock(Date.now() - Number(state.startedAt || Date.now()));
    parts.pause.hidden = paused;
    parts.resume.hidden = !paused;
    parts.end.hidden = !paused;
    parts.banner.title = paused
      ? "The agent is paused. Resume lets it continue; End takes it off this window."
      : `Click or type in this window, or press ${state.hotkey || "the stop key"}, to pause the agent.`;
    parts.pointer.hidden = state.showPointer === false;
  }

  function tick(now) {
    frameHandle = requestAnimationFrame(tick);
    if (!host || !host.isConnected) return;
    if (now - renderedAt > 250) {
      renderedAt = now;
      render();
    }
    const z = zoom();
    const gliding = now - lastFrameAt < 120;
    if (!gliding && restSince < lastFrameAt) restSince = now;

    // Lean with sideways speed, as a hand-held pointer would, then settle upright.
    const dt = Math.max(1, now - prevT);
    const speed = ((pos.x - prevX) / dt) * 1000;
    prevX = pos.x;
    prevT = now;
    const lean = Math.max(-18, Math.min(18, speed * 0.012));
    tilt += (lean - tilt) * (1 - Math.exp(-dt / 90));

    // At rest a small sway about the tip shows the agent is still at work; it calms when
    // the agent is waiting and stops while paused.
    const waiting = host.hasAttribute("data-waiting");
    const rest = gliding || state.paused ? 0 : Math.max(0, Math.min(1, (now - restSince - 250) / 400));
    const sway = (waiting ? 4 : 9) * rest * Math.sin((now / 1400) * 2 * Math.PI);

    let press = 1;
    if (pressStart >= 0) {
      const p = (now - pressStart) / 180;
      if (p >= 1) pressStart = -1;
      else press = 1 - 0.14 * Math.sin(p * Math.PI);
    }
    if (pulseStart >= 0) {
      const p = (now - pulseStart) / 420;
      if (p >= 1) {
        pulseStart = -1;
        parts.ripple.style.opacity = "0";
      } else {
        const eased = 1 - Math.pow(1 - p, 3);
        const r = 4 + 26 * eased;
        parts.ripple.style.width = `${r * 2}px`;
        parts.ripple.style.height = `${r * 2}px`;
        parts.ripple.style.transform = `translate(${-r - 2.6}px, ${-r - 2.6}px)`;
        parts.ripple.style.opacity = String(0.86 * (1 - p));
      }
    }

    const wave = 0.5 + 0.5 * Math.sin((now / 2600) * 2 * Math.PI);
    parts.glow.style.opacity = String(gliding ? 1 : 0.55 + 0.45 * wave);
    parts.arrow.style.transform = `rotate(${tilt + sway}deg) scale(${press})`;
    parts.pointer.style.transform = `translate(${pos.x / z}px, ${pos.y / z}px)`;
  }

  function bannerRect() {
    if (!parts) return null;
    const r = parts.banner.getBoundingClientRect();
    const z = zoom();
    return { x: r.left * z, y: r.top * z, width: r.width * z, height: r.height * z };
  }

  function describeElement(node) {
    if (!node) return "";
    let text = node.tagName.toLowerCase();
    if (node.id) text += `#${node.id}`;
    const className = typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : "";
    if (className) text += `.${className}`;
    const label = node.getAttribute("aria-label") || node.getAttribute("title") || "";
    const content = (label || node.textContent || "").replace(/\s+/g, " ").trim();
    if (content) text += ` "${content.length > 48 ? `${content.slice(0, 47)}…` : content}"`;
    return text;
  }

  // Names the element under a point, looking into same-origin frames so a click inside a
  // workspace page reports the control it lands on rather than the frame holding it.
  function describe(point) {
    const z = zoom();
    let doc = document;
    let x = point.x / z;
    let y = point.y / z;
    let node = null;
    const frames = [];
    for (let depth = 0; depth < 6; depth += 1) {
      node = doc.elementFromPoint(x, y);
      if (!node || (node.tagName !== "IFRAME" && node.tagName !== "FRAME")) break;
      let inner = null;
      try {
        inner = node.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) break;
      const r = node.getBoundingClientRect();
      frames.push(describeElement(node).split(" ")[0]);
      x -= r.left + node.clientLeft;
      y -= r.top + node.clientTop;
      doc = inner;
    }
    return { element: describeElement(node), frames };
  }

  window.__agentOverlay = {
    install(payload) {
      assets = payload;
      ensureAttached();
      return true;
    },
    apply(next) {
      ensureAttached();
      state = { ...state, ...next };
      if (next.pointer) pos = { x: next.pointer.x, y: next.pointer.y };
      render();
      return bannerRect();
    },
    frame(point) {
      ensureAttached();
      pos = { x: point.x, y: point.y };
      lastFrameAt = performance.now();
      return true;
    },
    press() {
      pressStart = performance.now();
      pulseStart = pressStart;
      return true;
    },
    // Hides the overlay for a screenshot and resolves once a frame without it has painted.
    // A window that is not painting still resolves after a short wait.
    setCaptureHidden(hidden) {
      if (host) host.toggleAttribute("data-capture-hidden", !!hidden);
      return new Promise((resolve) => {
        const done = () => resolve(true);
        setTimeout(done, 150);
        requestAnimationFrame(() => requestAnimationFrame(done));
      });
    },
    describe,
    takeRequest() {
      const value = request;
      request = null;
      return value;
    },
    remove() {
      if (frameHandle) cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      if (host) host.remove();
      host = null;
      parts = null;
      state = {};
      request = null;
      return true;
    },
  };
})();
