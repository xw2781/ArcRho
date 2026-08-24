/* Paints the requested tab before the tab system exists.

   A tabbed page ships with one panel pre-selected in its markup, and the tab
   system only chooses the real one once its module has loaded - after the page
   has already painted, and on the Dataset Viewer after its first reads finish.
   The window opens on the wrong tab and visibly jumps.

   This is a plain classic script so a page can run it during parsing, before
   anything paints. It applies exactly what `createTabbedPage`'s `setActive`
   applies for the initial tab - the same inline `display` on the panels and the
   same `active` class on the tab buttons - so the tab system's own first call
   is a no-op and nothing moves.

   A page carrying its panels in markup loads this with `data-auto="1"` after
   those panels. A page that builds its panels in script calls
   `window.arcrhoApplyInitialTabbedPage(root)` on the fragment before inserting
   it.

   Panels are found by `data-page`, the attribute the tab buttons already carry,
   so this needs no page-id rule of its own and cannot drift from one. An
   unknown or absent tab leaves the markup exactly as authored.

   The same file owns the other half of a quiet open: holding the first paint.
   A page marks its own body `data-arcrho-page-hold`, which tabbed_page.css
   reads to hide the body's children - not the body, so the theme's background
   still paints and a dark window cannot flash white. The page calls
   `window.arcrhoRevealPage()` once its opening tab has finished loading and
   rendering, and the content appears in one step instead of assembling itself
   in front of the user.

   Two independent safety nets keep a page from staying blank: this script
   reveals on an uncaught error and after a timeout, and tabbed_page.css runs
   the same release on a pure-CSS delay, which covers even this script failing
   to load. */
(function () {
  var HOLD_ATTRIBUTE = "data-arcrho-page-hold";
  /* Long enough that an ordinary open finishes first, short enough that a
     window whose load is stuck shows its own loading state instead of
     staying dead. A load slower than this trades the single clean paint for
     feedback, which is the better bargain at that point. */
  var HOLD_WATCHDOG_MS = 6000;
  var revealed = false;
  var watchdog = 0;

  function showPage() {
    if (document.body) document.body.removeAttribute(HOLD_ATTRIBUTE);
  }

  function revealPage() {
    if (revealed) return;
    revealed = true;
    if (watchdog) {
      window.clearTimeout(watchdog);
      watchdog = 0;
    }
    // Two frames: the first lets the pending layout commit, the second paints
    // the finished page. Revealing in the same frame can still show a partly
    // measured grid.
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(showPage);
      });
    } else {
      showPage();
    }
  }

  window.arcrhoRevealPage = revealPage;
  watchdog = window.setTimeout(revealPage, HOLD_WATCHDOG_MS);
  // A page that breaks before it can report itself ready must still be visible;
  // showing a half-drawn page beats showing nothing.
  window.addEventListener("error", revealPage);
  window.addEventListener("unhandledrejection", revealPage);

  function requestedTab() {
    try {
      var params = new URLSearchParams(window.location.search || "");
      return String(params.get("tab") || params.get("initial_tab") || "").trim();
    } catch (err) {
      return "";
    }
  }

  function applyInitialTabbedPage(root, tabId) {
    var scope = root || document;
    var requested = String(tabId || requestedTab()).trim();
    if (!requested || !scope.querySelectorAll) return "";

    var panels = scope.querySelectorAll("[data-page]:not(button)");
    if (!panels.length) return "";

    var known = false;
    for (var i = 0; i < panels.length; i += 1) {
      if (panels[i].getAttribute("data-page") === requested) known = true;
    }
    // An unknown tab is the page's own business: leave its markup alone rather
    // than blanking every panel.
    if (!known) return "";

    for (var j = 0; j < panels.length; j += 1) {
      var active = panels[j].getAttribute("data-page") === requested;
      panels[j].style.display = active ? "block" : "none";
      panels[j].setAttribute("aria-hidden", active ? "false" : "true");
    }

    var buttons = scope.querySelectorAll("button[data-page]");
    for (var k = 0; k < buttons.length; k += 1) {
      var selected = buttons[k].getAttribute("data-page") === requested;
      buttons[k].classList.toggle("active", selected);
      buttons[k].setAttribute("aria-selected", selected ? "true" : "false");
    }
    return requested;
  }

  window.arcrhoApplyInitialTabbedPage = applyInitialTabbedPage;

  var self = document.currentScript;
  if (self && self.getAttribute("data-auto") === "1") applyInitialTabbedPage(document);
})();
