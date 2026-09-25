/* Draws only the rows of a long table that are in view, with a spacer row
   above and below standing in for the rest, so a table of many thousand rows
   opens, switches tabs and scrolls as fast as a short one.

   The scroll host keeps its native wheel, keyboard and horizontal scrolling,
   but its vertical scrollbar gives way to a lane of its own beside the host.
   Dragging that lane's thumb leaves the table where it is and shows the label
   of the row the view will land on; the rows follow once the thumb is let go.

   The host's parent must lay the host and the lane out side by side (a flex
   row); the lane is added there. Each row the page draws carries its own grid
   position, since its place in the body no longer says which row it is. */

const OVERSCAN_ROWS = 12;
const FALLBACK_ROW_PX = 24;
const MIN_THUMB_PX = 32;
const ARROW_STEP_ROWS = 3;
const ARROW_REPEAT_DELAY_MS = 300;
const ARROW_REPEAT_MS = 50;

function laneMarkup() {
  return `<button class="arVirtualLaneArrow" type="button" data-step="-1" tabindex="-1" aria-hidden="true"></button>
    <div class="arVirtualLaneTrack">
      <div class="arVirtualLaneThumb"></div>
      <div class="arVirtualLaneHint" hidden></div>
    </div>
    <button class="arVirtualLaneArrow" type="button" data-step="1" tabindex="-1" aria-hidden="true"></button>
    <div class="arVirtualLaneCorner"></div>`;
}

export function createVirtualRows({ host, body, onRender = null }) {
  const table = body.closest("table");
  const lane = document.createElement("div");
  lane.className = "arVirtualLane";
  lane.hidden = true;
  lane.innerHTML = laneMarkup();
  host.after(lane);
  const track = lane.querySelector(".arVirtualLaneTrack");
  const thumb = lane.querySelector(".arVirtualLaneThumb");
  const hint = lane.querySelector(".arVirtualLaneHint");
  const corner = lane.querySelector(".arVirtualLaneCorner");

  let data = null;
  let rowPx = FALLBACK_ROW_PX;
  let rendered = { start: -1, end: -1 };
  let lockedHead = null;
  let drag = null;
  let frame = 0;

  const headPx = () => table.tHead?.offsetHeight || 0;
  const viewPx = () => Math.max(0, host.clientHeight - headPx());
  const visible = () => host.clientHeight > 0;

  function spacer(px) {
    return px > 0
      ? `<tr class="arVirtualSpacer" aria-hidden="true"><td colspan="${data.columnCount}" style="height:${px}px"></td></tr>`
      : "";
  }

  function windowAt(scrollTop) {
    const first = Math.floor(scrollTop / rowPx);
    const count = Math.ceil((viewPx() || rowPx * 30) / rowPx);
    // Snap to whole blocks of the overscan, so a small scroll redraws nothing.
    const start = Math.max(0, Math.floor(first / OVERSCAN_ROWS) * OVERSCAN_ROWS - OVERSCAN_ROWS);
    const end = Math.min(data.rowCount, first + count + OVERSCAN_ROWS * 2);
    return { start, end };
  }

  function draw(start, end, extra = []) {
    let rows = "";
    for (let r = start; r < end; r += 1) rows += data.rowMarkup(r);
    body.innerHTML = spacer(start * rowPx) + rows + extra.map((r) => data.rowMarkup(r)).join("")
      + spacer((data.rowCount - end) * rowPx);
  }

  // The columns size to the rows on screen, so they are held at the widths
  // they take with the widest rows drawn, rather than shifting on each scroll.
  function lockColumnWidths() {
    const headRow = table.tHead?.rows?.[0];
    if (!headRow || headRow === lockedHead || !visible()) return;
    const { start, end } = windowAt(host.scrollTop);
    draw(start, end, (data.widthRows || []).filter((r) => r < start || r >= end));
    const measured = body.querySelector("tr:not(.arVirtualSpacer)")?.offsetHeight;
    if (measured) rowPx = measured;
    const widths = Array.from(headRow.cells).map((th) => {
      const style = getComputedStyle(th);
      const edges = style.boxSizing === "border-box" ? 0
        : ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((sum, key) => sum + parseFloat(style[key]), 0);
      return th.getBoundingClientRect().width - edges;
    });
    Array.from(headRow.cells).forEach((th, index) => {
      th.style.minWidth = `${widths[index]}px`;
    });
    lockedHead = headRow;
    rendered = { start: -1, end: -1 };
  }

  function render(force = false) {
    if (!data) return;
    lockColumnWidths();
    const next = windowAt(host.scrollTop);
    if (force || next.start !== rendered.start || next.end !== rendered.end) {
      draw(next.start, next.end);
      rendered = next;
      onRender?.();
    }
    syncLane();
  }

  function scheduleRender() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  function thumbGeometry() {
    const trackPx = track.clientHeight;
    const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight);
    const size = Math.min(trackPx, Math.max(MIN_THUMB_PX, trackPx * (host.clientHeight / Math.max(1, host.scrollHeight))));
    return { trackPx, maxScroll, size, room: Math.max(0, trackPx - size) };
  }

  function placeThumb(top, size) {
    thumb.style.height = `${size}px`;
    thumb.style.transform = `translateY(${top}px)`;
  }

  function syncLane() {
    if (!data || drag) return;
    corner.style.height = `${Math.max(0, host.offsetHeight - host.clientHeight - host.clientTop * 2)}px`;
    const { maxScroll, size, room } = thumbGeometry();
    placeThumb(maxScroll ? (room * host.scrollTop) / maxScroll : 0, size);
  }

  function scrollByRows(rows) {
    host.scrollTop += rows * rowPx;
  }

  // Keeps row r in view below the sticky header and draws it now, so the
  // caller can find its cells straight away.
  function scrollToRow(r) {
    if (!data) return;
    const top = r * rowPx;
    if (top < host.scrollTop) host.scrollTop = top;
    else if (top + rowPx > host.scrollTop + viewPx()) host.scrollTop = top + rowPx - viewPx();
    render();
  }

  /* The lane: the thumb moves alone while dragged and the rows follow on
     release; a click on the track pages, an arrow steps a few rows and
     repeats while held, and the wheel over the lane scrolls the host. */
  thumb.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !data) return;
    event.preventDefault();
    const { maxScroll, size, room } = thumbGeometry();
    const startTop = maxScroll ? (room * host.scrollTop) / maxScroll : 0;
    drag = { pointerId: event.pointerId, startY: event.clientY, startTop, top: startTop, size, room, maxScroll };
    thumb.setPointerCapture(event.pointerId);
    lane.classList.add("isDragging");
  });
  thumb.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.top = Math.min(drag.room, Math.max(0, drag.startTop + event.clientY - drag.startY));
    placeThumb(drag.top, drag.size);
    const target = drag.room ? (drag.top / drag.room) * drag.maxScroll : 0;
    const label = data.rowLabel?.(Math.min(data.rowCount - 1, Math.floor(target / rowPx)));
    hint.hidden = !label;
    if (label) {
      hint.textContent = label;
      hint.style.transform = `translateY(${drag.top + drag.size / 2}px)`;
    }
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const target = drag.room ? (drag.top / drag.room) * drag.maxScroll : 0;
    drag = null;
    hint.hidden = true;
    lane.classList.remove("isDragging");
    host.scrollTop = target;
    render();
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target !== track) return;
    const below = event.clientY > thumb.getBoundingClientRect().bottom;
    host.scrollTop += (below ? 1 : -1) * Math.max(rowPx, viewPx() - rowPx);
  });

  let repeatTimer = 0;
  const stopRepeat = () => {
    clearTimeout(repeatTimer);
    clearInterval(repeatTimer);
    repeatTimer = 0;
  };
  lane.querySelectorAll(".arVirtualLaneArrow").forEach((arrow) => {
    const step = Number(arrow.dataset.step) * ARROW_STEP_ROWS;
    arrow.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      scrollByRows(step);
      stopRepeat();
      repeatTimer = setTimeout(() => {
        repeatTimer = setInterval(() => scrollByRows(step), ARROW_REPEAT_MS);
      }, ARROW_REPEAT_DELAY_MS);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((type) => arrow.addEventListener(type, stopRepeat));
  });

  lane.addEventListener("wheel", (event) => {
    event.preventDefault();
    host.scrollTop += event.deltaY;
  }, { passive: false });

  host.addEventListener("scroll", () => {
    if (!data) return;
    syncLane();
    scheduleRender();
  }, { passive: true });
  // A tab shown again, or a window resized, changes how many rows fit.
  new ResizeObserver(() => {
    if (data) render();
  }).observe(host);

  /* Hands the table over: rowCount rows of columnCount cells (the label
     included), rowMarkup(r) for row r, rowLabel(r) for the drag hint, and
     widthRows, the rows whose figures run widest, drawn once to size the
     columns. The page draws the header itself before calling this. */
  function show({ rowCount, columnCount, rowMarkup, rowLabel = null, widthRows = [] }) {
    data = { rowCount, columnCount, rowMarkup, rowLabel, widthRows };
    host.classList.add("arVirtualRowsActive");
    lane.hidden = false;
    render(true);
  }

  // Back to a table the page draws whole.
  function hide() {
    if (!data) return;
    data = null;
    lockedHead = null;
    rendered = { start: -1, end: -1 };
    host.classList.remove("arVirtualRowsActive");
    lane.hidden = true;
  }

  return { show, hide, scrollToRow, isActive: () => !!data, rowCount: () => data?.rowCount ?? 0 };
}
