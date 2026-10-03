(() => {
  const content = document.querySelector("main.guide-content");
  if (!content) return;

  const page = document.body.dataset.page;
  const root = page === "home" ? "" : "../";
  const chapters = [
    ["home", "Guide Home", "index.html", "Start"],
    ["shell", "App Navigation", "pages/shell.html", "Start"],
    ["server-connection", "Server Connections", "pages/server-connection.html", "Start"],
    ["project-settings", "Project Settings", "pages/project-settings.html", "Projects And Data"],
    ["project-instance", "Project Page", "pages/project-instance.html", "Projects And Data"],
    ["dataset", "Dataset Viewer", "pages/dataset.html", "Projects And Data"],
    ["dfm", "Development Factor Method", "pages/dfm.html", "Methods"],
    ["result-selection", "Result Selection", "pages/result-selection.html", "Methods"],
    ["workflow", "Workflow", "pages/workflow.html", "Automation"],
    ["macros-tasks", "Macros And Tasks", "pages/macros-tasks.html", "Automation"],
    ["arcode", "Arcode", "pages/arcode.html", "Automation"],
    ["arcbot", "ArcBot", "pages/arcbot.html", "Automation"],
    ["python-api", "Python API", "pages/python-api.html", "Integrations"],
    ["excel-addin", "Excel Add-in", "pages/excel-addin.html", "Integrations"],
    ["resq-migration", "ResQ Migration", "pages/resq-migration.html", "Integrations"],
    ["troubleshooting", "Troubleshooting", "pages/troubleshooting.html", "Help"],
  ];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function buildNavigation() {
    let shell = content.closest(".guide-shell");
    if (!shell) {
      shell = element("div", "guide-shell");
      content.before(shell);
      shell.append(content);
    }
    let sidebar = shell.querySelector(".guide-sidebar");
    if (!sidebar) {
      sidebar = element("aside", "guide-sidebar");
      shell.prepend(sidebar);
    }
    sidebar.id = "guide-navigation";
    const brand = element("a", "guide-brand");
    brand.href = `${root}index.html`;
    brand.append(element("strong", "", "Arco"), element("span", "", "User Guide"));
    const navigation = element("nav", "guide-nav");
    navigation.setAttribute("aria-label", "Guide chapters");
    let lastGroup;
    for (const [id, title, path, group] of chapters) {
      if (group !== lastGroup) navigation.append(element("h2", "", group));
      lastGroup = group;
      const link = element("a", "", title);
      link.href = root + path;
      if (id === page) link.setAttribute("aria-current", "page");
      navigation.append(link);
    }
    sidebar.replaceChildren(brand, navigation);

    const headings = [...content.querySelectorAll("section[id]")]
      .map(section => [section, section.querySelector("h2")])
      .filter(([, heading]) => heading);
    if (headings.length) {
      const toc = element("nav", "guide-toc");
      toc.setAttribute("aria-label", "On this page");
      toc.append(element("h2", "", "On This Page"));
      for (const [section, heading] of headings) {
        const link = element("a", "", heading.textContent);
        link.href = `#${section.id}`;
        toc.append(link);
      }
      sidebar.append(toc);
    }
    const reference = element("p", "guide-reference", "Open this guide from Help → User Guide in Arco.");
    sidebar.append(reference);

    const toggle = element("button", "guide-menu-toggle", "Show guide navigation");
    toggle.type = "button";
    toggle.setAttribute("aria-controls", sidebar.id);
    toggle.setAttribute("aria-expanded", "false");
    shell.before(toggle);
    const setOpen = open => {
      shell.classList.toggle("is-navigation-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide guide navigation" : "Show guide navigation";
    };
    toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
    sidebar.addEventListener("click", event => {
      if (!event.target.closest("a")) return;
      if (toggle.getAttribute("aria-expanded") === "true") toggle.focus();
      setOpen(false);
    });
    content.id ||= "guide-content";
    const skip = element("a", "guide-skip-link", "Skip to guide content");
    skip.href = `#${content.id}`;
    document.body.prepend(skip);
  }

  function addImageViewer() {
    const screenshots = content.querySelectorAll(".screenshot > img");
    if (!screenshots.length) return;
    const dialog = element("dialog", "image-dialog");
    dialog.setAttribute("aria-labelledby", "image-dialog-title");
    dialog.setAttribute("aria-describedby", "image-dialog-caption");
    const header = element("div", "image-dialog-header");
    const title = element("strong", "", "Screenshot");
    title.id = "image-dialog-title";
    const close = element("button", "", "Close image");
    close.type = "button";
    const image = element("img");
    const caption = element("p", "image-dialog-caption");
    caption.id = "image-dialog-caption";
    header.append(title, close);
    dialog.append(header, image, caption);
    document.body.append(dialog);
    let opener;
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => opener?.focus());
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    for (const source of screenshots) {
      const button = element("button", "screenshot-button");
      button.type = "button";
      button.setAttribute("aria-label", `Enlarge screenshot: ${source.alt}`);
      button.setAttribute("aria-haspopup", "dialog");
      const figure = source.closest("figure");
      source.before(button);
      button.append(source);
      button.addEventListener("click", () => {
        opener = button;
        image.src = source.currentSrc || source.src;
        image.alt = source.alt;
        caption.textContent = figure.querySelector("figcaption")?.textContent || source.alt;
        dialog.showModal();
        close.focus();
      });
    }
  }

  function addWalkthroughs() {
    for (const walkthrough of content.querySelectorAll("[data-walkthrough]")) {
      const steps = [...walkthrough.querySelectorAll("figure[data-step]")];
      if (steps.length < 2) continue;
      let controls = walkthrough.querySelector(".walkthrough-controls");
      if (!controls) {
        controls = element("div", "walkthrough-controls");
        walkthrough.append(controls);
      }
      const control = (selector, tag, text) => {
        let node = walkthrough.querySelector(`[${selector}]`);
        if (!node) {
          node = element(tag, "", text);
          node.setAttribute(selector, "");
          controls.append(node);
        }
        return node;
      };
      const previous = control("data-previous", "button", "Previous step");
      const next = control("data-next", "button", "Next step");
      const status = control("data-step-status", "span");
      previous.type = next.type = "button";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");
      let current = 0;
      const showStep = index => {
        current = index;
        steps.forEach((step, i) => { step.hidden = i !== current; });
        previous.disabled = current === 0;
        next.disabled = current === steps.length - 1;
        status.textContent = `Step ${current + 1} of ${steps.length}`;
      };
      previous.addEventListener("click", () => showStep(current - 1));
      next.addEventListener("click", () => showStep(current + 1));
      walkthrough.classList.add("walkthrough-ready");
      showStep(0);
    }
  }

  buildNavigation();
  addImageViewer();
  addWalkthroughs();
  document.documentElement.classList.add("guide-enhanced");
})();
