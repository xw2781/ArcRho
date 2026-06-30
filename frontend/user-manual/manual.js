(function () {
  const pages = [
    { id: "home", title: "Home", href: "index.html", group: "Start" },
    { id: "shell", title: "App Shell", href: "pages/shell.html", group: "Frontend" },
    { id: "server-connection", title: "Server Connection", href: "pages/server-connection.html", group: "Frontend" },
    { id: "project-settings", title: "Project Settings", href: "pages/project-settings.html", group: "Frontend" },
    { id: "project-instance", title: "Project Instance", href: "pages/project-instance.html", group: "Frontend" },
    { id: "dataset", title: "Dataset Viewer", href: "pages/dataset.html", group: "Frontend" },
    { id: "dfm", title: "DFM Methods", href: "pages/dfm.html", group: "Frontend" },
    { id: "result-selection", title: "Result Selection", href: "pages/result-selection.html", group: "Frontend" },
    { id: "workflow", title: "Workflow", href: "pages/workflow.html", group: "Frontend" },
    { id: "macros-tasks", title: "Macros And Tasks", href: "pages/macros-tasks.html", group: "Automation" },
    { id: "arcbot", title: "ArcBot", href: "pages/arcbot.html", group: "Automation" },
    { id: "arcode", title: "Arcode", href: "pages/arcode.html", group: "Automation" },
    { id: "python-api", title: "Python API", href: "pages/python-api.html", group: "Integrations" },
    { id: "excel-addin", title: "Excel Add-In", href: "pages/excel-addin.html", group: "Integrations" },
    { id: "resq-migration", title: "ResQ Migration", href: "pages/resq-migration.html", group: "Integrations" },
    { id: "troubleshooting", title: "Troubleshooting", href: "pages/troubleshooting.html", group: "Help" }
  ];

  const body = document.body;
  const page = body.dataset.page || "home";
  const isNested = window.location.pathname.replace(/\\/g, "/").includes("/pages/");
  const root = isNested ? "../" : "";
  const content = document.querySelector(".manual-page");
  if (!content) return;

  const pageInfo = pages.find((item) => item.id === page) || pages[0];
  const title = content.dataset.pageTitle || pageInfo.title;
  const intro = content.dataset.pageIntro || "";

  function localHref(href) {
    if (href === "index.html") return root + href;
    return isNested ? "../" + href : href;
  }

  function buildNav() {
    const nav = document.createElement("nav");
    nav.className = "manual-nav";
    let group = "";
    pages.forEach((item) => {
      if (item.group !== group) {
        group = item.group;
        const heading = document.createElement("div");
        heading.className = "nav-group-title";
        heading.textContent = group;
        nav.appendChild(heading);
      }
      const link = document.createElement("a");
      link.href = localHref(item.href);
      link.textContent = item.title;
      link.dataset.pageId = item.id;
      link.classList.toggle("active", item.id === page);
      nav.appendChild(link);
    });
    return nav;
  }

  function buildToc() {
    const toc = document.createElement("div");
    toc.className = "page-toc";
    const headings = Array.from(content.querySelectorAll(".manual-section[id] > .section-head h2"));
    if (!headings.length) return toc;
    const label = document.createElement("strong");
    label.textContent = "On this page";
    toc.appendChild(label);
    headings.forEach((heading) => {
      const section = heading.closest(".manual-section");
      const link = document.createElement("a");
      link.href = `#${section.id}`;
      link.textContent = heading.textContent;
      toc.appendChild(link);
    });
    return toc;
  }

  function hydrateShell() {
    const shell = document.createElement("div");
    shell.className = "manual-shell";

    const sidebar = document.createElement("aside");
    sidebar.className = "manual-sidebar";
    sidebar.innerHTML = `
      <div class="brand-block">
        <div class="brand-mark">A</div>
        <div>
          <div class="brand-title">ArcRho Manual</div>
          <div class="brand-subtitle">Standalone folder guide</div>
        </div>
      </div>
      <label class="manual-search"><span>Find</span><input id="manualSearch" type="search" placeholder="Filter this page"></label>
    `;
    sidebar.appendChild(buildNav());
    const note = document.createElement("div");
    note.className = "sidebar-note";
    note.textContent = "Each topic is a separate file. Open index.html to return home.";
    sidebar.appendChild(note);

    const stage = document.createElement("div");
    stage.className = "manual-stage";
    const top = document.createElement("header");
    top.className = "manual-top";
    top.innerHTML = `
      <div>
        <div class="breadcrumb">ArcRho User Manual / ${pageInfo.group}</div>
        <h1>${title}</h1>
        ${intro ? `<p class="manual-intro">${intro}</p>` : ""}
      </div>
    `;
    top.appendChild(buildToc());
    stage.appendChild(top);
    stage.appendChild(content);

    shell.appendChild(sidebar);
    shell.appendChild(stage);
    body.textContent = "";
    body.appendChild(shell);

    const backTop = document.createElement("button");
    backTop.type = "button";
    backTop.className = "back-top";
    backTop.textContent = "Top";
    backTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    body.appendChild(backTop);
  }

  function initSearch() {
    const search = document.getElementById("manualSearch");
    if (!search) return;
    search.addEventListener("input", () => {
      const value = search.value.trim().toLowerCase();
      const blocks = Array.from(document.querySelectorAll(".manual-section, .manual-panel, .task-card, .nav-card"));
      blocks.forEach((block) => {
        const haystack = block.textContent.toLowerCase();
        block.classList.toggle("hidden-by-search", Boolean(value) && !haystack.includes(value));
      });
    });
  }

  function initCodeTools() {
    document.querySelectorAll("[data-code-tabs]").forEach((group) => {
      const buttons = Array.from(group.querySelectorAll("[data-tab]"));
      const panels = Array.from(group.querySelectorAll("[data-panel]"));
      buttons.forEach((button) => {
        button.addEventListener("click", () => {
          buttons.forEach((item) => item.classList.toggle("active", item === button));
          panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === button.dataset.tab));
        });
      });
    });

    document.querySelectorAll("pre.code-sample").forEach((pre) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-button";
      button.textContent = "Copy";
      button.addEventListener("click", async () => {
        const text = pre.innerText.replace(/^Copy\s*/, "");
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = "Copied";
        } catch (error) {
          button.textContent = "Select";
        }
        window.setTimeout(() => { button.textContent = "Copy"; }, 1200);
      });
      pre.appendChild(button);
    });
  }

  function initAccordions() {
    document.querySelectorAll("[data-accordion]").forEach((accordion) => {
      accordion.querySelectorAll(".accordion-trigger").forEach((trigger) => {
        trigger.addEventListener("click", () => {
          const panel = trigger.nextElementSibling;
          trigger.classList.toggle("open");
          if (panel) panel.classList.toggle("open");
        });
      });
    });
  }

  function initReplay() {
    document.querySelectorAll("[data-replay]").forEach((button) => {
      button.addEventListener("click", () => {
        const host = button.previousElementSibling || button.closest(".manual-section");
        if (!host) return;
        host.classList.remove("demo-running");
        void host.offsetWidth;
        host.classList.add("demo-running");
        window.setTimeout(() => host.classList.remove("demo-running"), 3200);
      });
    });
  }

  function initBackTop() {
    const button = document.querySelector(".back-top");
    if (!button) return;
    const update = () => button.classList.toggle("visible", window.scrollY > 600);
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  hydrateShell();
  initSearch();
  initCodeTools();
  initAccordions();
  initReplay();
  initBackTop();
})();
