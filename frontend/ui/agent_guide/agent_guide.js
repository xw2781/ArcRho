import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const host = window.ADAHost || null;
const navEl = document.getElementById("agNav");
const contentEl = document.getElementById("agContent");
const reloadBtn = document.getElementById("agReloadBtn");

window.ArcRhoZoomBridge?.wirePageZoomBridge();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownInlineToHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdownToHtml(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = [];
  let listType = "";
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(markdownInlineToHtml).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    out.push(`<${tag}>${list.map((item) => `<li>${markdownInlineToHtml(item)}</li>`).join("")}</${tag}>`);
    list = [];
    listType = "";
  };
  const flushCode = () => {
    out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${markdownInlineToHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (list.length && listType !== nextType) flushList();
      listType = nextType;
      list.push((bullet || ordered)[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  if (inCode || codeLines.length) flushCode();
  return out.join("\n") || "<p>No content yet.</p>";
}

function normalizeId(value, fallback) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || fallback;
}

function setActivePane(id) {
  document.querySelectorAll(".agTab").forEach((button) => {
    button.classList.toggle("active", button.dataset.target === id);
  });
  document.querySelectorAll(".agPane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === id);
  });
}

function renderGuide(data) {
  const components = Array.isArray(data?.components) ? data.components : [];
  if (!components.length) {
    navEl.innerHTML = `<div class="agStatus error">No prompt components were found.</div>`;
    contentEl.innerHTML = `<div class="agStatus error">No prompt components were found.</div>`;
    return;
  }
  const ids = new Set();
  const normalized = components.map((component, index) => {
    let id = normalizeId(component?.id || component?.title, `prompt-${index + 1}`);
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    return {
      id,
      title: String(component?.title || `Prompt ${index + 1}`),
      path: String(component?.path || ""),
      text: String(component?.text || ""),
    };
  });

  navEl.innerHTML = [
    `<div class="agPathBox"><strong>Server root</strong>${escapeHtml(data?.serverRoot || "Not configured")}</div>`,
    `<div class="agPathBox"><strong>Instructions folder</strong>${escapeHtml(data?.instructionsDir || "Not available")}</div>`,
    ...normalized.map((component, index) => (
      `<button class="agTab${index === 0 ? " active" : ""}" type="button" data-target="${escapeHtml(component.id)}">${escapeHtml(component.title)}</button>`
    )),
  ].join("\n");

  const workflow = `
    <div class="agWorkflow">
      <h2>Workflow</h2>
      <ol>
        <li>Edit <code>config\\arcbot\\arcbot_prompt.md</code> for first-level ArcBot behavior.</li>
        <li>Edit files under <code>config\\arcbot\\instructions</code> for topic-specific labels and workflow rules.</li>
        <li>ArcBot reads the entry prompt and instruction files when each request is built.</li>
        <li>Add new <code>.md</code> files to the instructions folder when new workflow areas are added.</li>
      </ol>
    </div>
  `;
  const panes = normalized.map((component, index) => `
    <article id="${escapeHtml(component.id)}" class="agPane${index === 0 ? " active" : ""}">
      <div class="agPaneHeader">
        <h2>${escapeHtml(component.title)}</h2>
        <div class="agComponentPath">${escapeHtml(component.path)}</div>
      </div>
      <div class="agMarkdown">${renderMarkdownToHtml(component.text)}</div>
      <details>
        <summary>Raw Markdown</summary>
        <pre><code>${escapeHtml(component.text)}</code></pre>
      </details>
    </article>
  `).join("\n");
  contentEl.innerHTML = `${workflow}${panes}`;

  navEl.querySelectorAll(".agTab").forEach((button) => {
    button.addEventListener("click", () => setActivePane(button.dataset.target || ""));
  });
}

async function loadGuide() {
  navEl.innerHTML = `<div class="agStatus">Loading prompt guide...</div>`;
  contentEl.innerHTML = `<div class="agStatus">Loading prompt components...</div>`;
  try {
    const result = await loadPromptGuideData();
    if (!result?.ok) throw new Error(result?.error || "Could not load ArcBot prompt guide.");
    renderGuide(result);
  } catch (err) {
    const message = escapeHtml(err?.message || err || "Could not load ArcBot prompt guide.");
    navEl.innerHTML = `<div class="agStatus error">Unavailable</div>`;
    contentEl.innerHTML = `<div class="agStatus error">${message}</div>`;
  }
}

function loadPromptGuideData() {
  if (host?.codexAssistantLoadPromptGuide) return host.codexAssistantLoadPromptGuide();
  return new Promise((resolve) => {
    const requestId = `agent_guide_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "ArcBot prompt guide request timed out." });
    }, 10000);
    function onMessage(event) {
      const msg = event?.data || {};
      if (msg.type !== "arcrho:agent-guide-load-result" || msg.requestId !== requestId) return;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      resolve(msg);
    }
    window.addEventListener("message", onMessage);
    try {
      window.parent?.postMessage({ type: "arcrho:agent-guide-load", requestId }, "*");
    } catch (err) {
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: String(err?.message || err || "Could not request ArcBot prompt guide.") });
    }
  });
}

reloadBtn?.addEventListener("click", loadGuide);
loadGuide();
