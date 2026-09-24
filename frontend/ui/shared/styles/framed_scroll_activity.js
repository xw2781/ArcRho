/* Drives the active thumb of the framed scroll surface in
   `framed_scrollbars.css`: `isScrolling` while a surface scrolls, and
   `isScrollbarHover` while the pointer is over one of its scrollbar lanes.

   Wire it once on a document. It listens at the root, so a framed surface a
   page renders later needs nothing of its own. */

const SCROLL_IDLE_MS = 550;
const MIN_LANE_PX = 16;

function framedHost(target) {
  return target instanceof Element ? target.closest(".ar-framed-scroll") : null;
}

function overScrollbarLane(host, event) {
  const rect = host.getBoundingClientRect();
  const verticalWidth = Math.max(0, host.offsetWidth - host.clientWidth);
  const horizontalHeight = Math.max(0, host.offsetHeight - host.clientHeight);
  const overVertical = host.scrollHeight > host.clientHeight
    && verticalWidth > 0
    && event.clientX >= rect.right - Math.max(verticalWidth, MIN_LANE_PX);
  const overHorizontal = host.scrollWidth > host.clientWidth
    && horizontalHeight > 0
    && event.clientY >= rect.bottom - Math.max(horizontalHeight, MIN_LANE_PX);
  return overVertical || overHorizontal;
}

export function wireFramedScrollActivity(root = document) {
  const idleTimers = new WeakMap();
  let hovered = null;
  const leave = () => {
    hovered?.classList.remove("isScrollbarHover");
    hovered = null;
  };
  // Scroll events do not bubble, so listen in the capture phase.
  root.addEventListener("scroll", (event) => {
    const host = event.target;
    if (!(host instanceof Element) || !host.classList.contains("ar-framed-scroll")) return;
    host.classList.add("isScrolling");
    clearTimeout(idleTimers.get(host));
    idleTimers.set(host, setTimeout(() => host.classList.remove("isScrolling"), SCROLL_IDLE_MS));
  }, { capture: true, passive: true });
  root.addEventListener("pointermove", (event) => {
    const host = framedHost(event.target);
    if (hovered !== host) leave();
    hovered = host;
    host?.classList.toggle("isScrollbarHover", overScrollbarLane(host, event));
  }, { passive: true });
  root.addEventListener("pointerout", (event) => {
    if (!event.relatedTarget) leave();
  }, { passive: true });
}
