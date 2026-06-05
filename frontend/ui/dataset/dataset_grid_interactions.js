import { getTopLeftRangeCell, writeTextToClipboard } from "/ui/shared/table_selection.js";
import { getDisplayDatasetModel } from "/ui/dataset/dataset_render.js";

export function wireDatasetGridInteractions(deps) {
  const { state, renderTable, renderActiveCellUI } = deps;

  wireArrowKeyNavigation();
  wireRectSelectionAndCopy();

  function wireArrowKeyNavigation() {
    if (window.__arcRhoArrowNavWired) return;
    window.__arcRhoArrowNavWired = true;

    document.addEventListener("keydown", (e) => {
      const isArrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
      if (!isArrow) return;

      // Don't steal keys while typing / selecting in controls
      if (isTypingTarget(e.target)) return;

      const model = getDisplayDatasetModel();
      if (!model) return;

      const maxR = (model.origin_labels?.length || 0) - 1;
      const maxC = (model.dev_labels?.length || 0) - 1;
      if (maxR < 0 || maxC < 0) return;

      // If no active cell yet, pick (0,0)
      if (!state.activeCell) {
        state.activeCell = { r: 0, c: 0 };
      }

      const prev = { ...state.activeCell };
      let { r, c } = state.activeCell;

      if (e.key === "ArrowUp") r--;
      if (e.key === "ArrowDown") r++;
      if (e.key === "ArrowLeft") c--;
      if (e.key === "ArrowRight") c++;

      r = Math.max(0, Math.min(maxR, r));
      c = Math.max(0, Math.min(maxC, c));

      // Shift+Arrow: remember anchor (the cell where extending started)
      if (e.shiftKey) {
        if (!state._shiftAnchor) state._shiftAnchor = { ...prev };
      }

      // Ctrl+Arrow: jump to edge of row/column
      if (e.ctrlKey) {
        if (e.key === "ArrowUp") r = 0;
        if (e.key === "ArrowDown") r = maxR;
        if (e.key === "ArrowLeft") c = 0;
        if (e.key === "ArrowRight") c = maxC;
      }

      state.activeCell = { r, c };

      if (e.shiftKey) {
        // Extend selection from anchor to current active cell
        const a = state._shiftAnchor || { ...prev };
        state.selRanges = [normalizeRange(a.r, a.c, r, c)];
        applySelectionFromState();
      } else {
        // Plain/Ctrl arrows: collapse selection, clear anchor
        state._shiftAnchor = null;
        state.selRanges = [normalizeRange(r, c, r, c)];
        applySelectionFromState();
      }

      renderActiveCellUI();

      const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
      const wrap = document.getElementById("tableWrap");
      if (td && wrap) {
        const tdRect = td.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();

        const stickyLeft = (() => {
          const firstCol = wrap.querySelector("tbody th, tbody td:first-child");
          if (!firstCol) return 0;
          const fr = firstCol.getBoundingClientRect();
          return Math.max(0, fr.width);
        })();
        const stickyTop = (() => {
          const header = wrap.querySelector("thead th");
          if (!header) return 0;
          const hr = header.getBoundingClientRect();
          return Math.max(0, hr.height);
        })();

        // How far the cell edges are from the visible (non-sticky) area
        const leftDelta = tdRect.left - (wrapRect.left + stickyLeft);
        const rightDelta = tdRect.right - wrapRect.right;
        const topDelta = tdRect.top - (wrapRect.top + stickyTop);
        const bottomDelta = tdRect.bottom - wrapRect.bottom;

        if (leftDelta < 0) wrap.scrollLeft += leftDelta;
        else if (rightDelta > 0) wrap.scrollLeft += rightDelta;

        if (topDelta < 0) wrap.scrollTop += topDelta;
        else if (bottomDelta > 0) wrap.scrollTop += bottomDelta;
      }

      e.preventDefault();
    });
  }

  function normalizeRange(r0, c0, r1, c1) {
    return {
      r0: Math.min(r0, r1),
      r1: Math.max(r0, r1),
      c0: Math.min(c0, c1),
      c1: Math.max(c0, c1),
    };
  }

  function rcFromTd(td) {
    const r = Number(td?.dataset?.r);
    const c = Number(td?.dataset?.c);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    return { r, c };
  }

  function isTypingTarget(t) {
    if (!t) return false;
    return !!(
      t.closest
        ? t.closest("input, textarea, select, option, button, [contenteditable='true']")
        : (t.matches && t.matches("input, textarea, select, option, button, [contenteditable='true']"))
    ) || !!t.isContentEditable;
  }

  function clearSelectionClasses() {
    document.querySelectorAll("#tableWrap td.sel").forEach(el => el.classList.remove("sel"));
    document.querySelectorAll("#tableWrap th.activeRow").forEach(el => el.classList.remove("activeRow"));
    document.querySelectorAll("#tableWrap th.activeCol").forEach(el => el.classList.remove("activeCol"));
  }

  function applyRangeClasses(range, add = true) {
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
        if (!td) continue;
        td.classList.toggle("sel", add);
      }
    }
  }

  function applySelectionFromState() {
    clearSelectionClasses();
    const ranges = state.selRanges || [];
    for (const rg of ranges) applyRangeClasses(rg, true);

    // re-apply after re-render
    renderActiveCellUI();

    // highlight row/col headers for all selected ranges
    for (const rg of ranges) {
      for (let r = rg.r0; r <= rg.r1; r++) {
        const th = document.querySelector(`#tableWrap th.rowhdr[data-r="${r}"]`);
        if (th) th.classList.add("activeRow");
      }
      for (let c = rg.c0; c <= rg.c1; c++) {
        const th = document.querySelector(`#tableWrap th.colhdr[data-c="${c}"]`);
        if (th) th.classList.add("activeCol");
      }
    }

    // mark active cell stronger
    if (state.activeCell) {
      const { r, c } = state.activeCell;
      const td = document.querySelector(`#tableWrap td[data-r="${r}"][data-c="${c}"]`);
      if (td) td.classList.add("active");
    }
  }

  function setActiveCell(r, c) {
    // If focus is still on a form control (select/input), arrow keys will be ignored.
    // Blur it when user starts interacting with the grid.
    const ae = document.activeElement;
    if (ae && isTypingTarget(ae)) {
      try { ae.blur(); } catch {}
    }

    state.activeCell = { r, c };
    renderActiveCellUI();
  }

  function buildTsvFromRange(range) {
    const model = getDisplayDatasetModel();
    if (!model) return "";
    const vals = model.values || [];
    const out = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const row = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const v = vals?.[r]?.[c];
        row.push(v == null ? "" : String(v));
      }
      out.push(row.join("\t"));
    }
    return out.join("\n");
  }

  async function copyActiveRangeToClipboard() {
    const ranges = Array.isArray(state.selRanges) ? state.selRanges : [];
    let text = "";
    if (ranges.length === 1) {
      text = buildTsvFromRange(ranges[0]);
    } else if (ranges.length > 1) {
      const cell = getTopLeftRangeCell(ranges);
      const value = cell ? getDisplayDatasetModel()?.values?.[cell.r]?.[cell.c] : "";
      text = value == null ? "" : String(value);
    } else if (state.activeCell) {
      const { r, c } = state.activeCell;
      const value = getDisplayDatasetModel()?.values?.[r]?.[c];
      text = value == null ? "" : String(value);
    }
    await writeTextToClipboard(text);
  }

  function getTableRowStepPx(wrap) {
    const td = wrap?.querySelector("tbody td[data-r][data-c]");
    if (!td) return 20;
    const cs = getComputedStyle(td);
    const h = td.getBoundingClientRect().height;
    const mt = parseFloat(cs.marginTop || "0") || 0;
    const mb = parseFloat(cs.marginBottom || "0") || 0;
    const step = h + mt + mb;
    return Number.isFinite(step) && step > 0 ? step : 20;
  }

  function getTableColStepPx(wrap) {
    const td = wrap?.querySelector("tbody td[data-r][data-c]");
    if (!td) return 90;
    const cs = getComputedStyle(td);
    const w = td.getBoundingClientRect().width;
    const ml = parseFloat(cs.marginLeft || "0") || 0;
    const mr = parseFloat(cs.marginRight || "0") || 0;
    const step = w + ml + mr;
    return Number.isFinite(step) && step > 0 ? step : 90;
  }

  function clampScrollLeft(wrap, left) {
    return Math.max(0, Math.min(left, wrap.scrollWidth - wrap.clientWidth));
  }

  function clampScrollTop(wrap, top) {
    return Math.max(0, Math.min(top, wrap.scrollHeight - wrap.clientHeight));
  }

  function snapTableScrollToGrid(wrap) {
    if (!wrap) return;

    let targetLeft = wrap.scrollLeft;
    let targetTop = wrap.scrollTop;

    if (targetLeft > 0) {
      const colStep = getTableColStepPx(wrap);
      if (colStep > 0) {
        targetLeft = clampScrollLeft(wrap, Math.round(targetLeft / colStep) * colStep);
      }
    }
    if (targetTop > 0) {
      const rowStep = getTableRowStepPx(wrap);
      if (rowStep > 0) {
        targetTop = clampScrollTop(wrap, Math.round(targetTop / rowStep) * rowStep);
      }
    }

    wrap.scrollTo({
      left: targetLeft,
      top: targetTop,
      behavior: "smooth",
    });
  }

  function wireTableScrollSnapAfterIdle(wrap) {
    if (!wrap || wrap.__arcRhoSnapWired) return;
    wrap.__arcRhoSnapWired = true;

    let snapTimer = null;
    let wheelActiveTimer = null;
    let wheelActive = false;

    const scheduleSnap = () => {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        if (wheelActive) return;
        snapTableScrollToGrid(wrap);
      }, 120);
    };

    wrap.addEventListener("scroll", scheduleSnap, { passive: true });

    // Pause snap while wheel is active (e.g. Logitech MX Master thumb wheel)
    wrap.addEventListener("wheel", () => {
      wheelActive = true;
      if (wheelActiveTimer) clearTimeout(wheelActiveTimer);
      wheelActiveTimer = setTimeout(() => {
        wheelActive = false;
        scheduleSnap();
      }, 120);
    }, { passive: true });
  }

  function wireTableScrollArrowButtons(wrap) {
    if (!wrap) return;
    const host = document.getElementById("tableWrapHost");
    const upBtn = document.getElementById("tableScrollUpBtn");
    const downBtn = document.getElementById("tableScrollDownBtn");
    const leftBtn = document.getElementById("tableScrollLeftBtn");
    const rightBtn = document.getElementById("tableScrollRightBtn");
    if (!host || !upBtn || !downBtn || !leftBtn || !rightBtn) return;
    if (host.__arcRhoScrollArrowWired) {
      updateArrowState();
      return;
    }
    host.__arcRhoScrollArrowWired = true;

    function updateArrowState() {
      const canVert = wrap.scrollHeight - wrap.clientHeight > 1;
      const canHorz = wrap.scrollWidth - wrap.clientWidth > 1;
      host.classList.toggle("has-v-scroll", canVert);
      host.classList.toggle("has-h-scroll", canHorz);
      upBtn.disabled = !canVert || wrap.scrollTop <= 0;
      downBtn.disabled = !canVert || wrap.scrollTop >= (wrap.scrollHeight - wrap.clientHeight - 1);
      leftBtn.disabled = !canHorz || wrap.scrollLeft <= 0;
      rightBtn.disabled = !canHorz || wrap.scrollLeft >= (wrap.scrollWidth - wrap.clientWidth - 1);
    }

    function scrollOneRow(dir) {
      const next = clampScrollTop(wrap, wrap.scrollTop + dir * getTableRowStepPx(wrap));
      wrap.scrollTo({ top: next, behavior: "auto" });
      snapTableScrollToGrid(wrap);
    }
    function scrollOneCol(dir) {
      const next = clampScrollLeft(wrap, wrap.scrollLeft + dir * getTableColStepPx(wrap));
      wrap.scrollTo({ left: next, behavior: "auto" });
      snapTableScrollToGrid(wrap);
    }

    upBtn.addEventListener("click", () => scrollOneRow(-1));
    downBtn.addEventListener("click", () => scrollOneRow(1));
    leftBtn.addEventListener("click", () => scrollOneCol(-1));
    rightBtn.addEventListener("click", () => scrollOneCol(1));

    wrap.addEventListener("scroll", updateArrowState, { passive: true });
    window.addEventListener("resize", updateArrowState);
    requestAnimationFrame(updateArrowState);
  }

  function wireRectSelectionAndCopy() {
    if (window.__arcRhoRectSelWired) return;
    window.__arcRhoRectSelWired = true;

    // state containers
    if (!Array.isArray(state.selRanges)) state.selRanges = [];
    state.dragSel = null;    // {anchor:{r,c}, cur:{r,c}, append:boolean}
    window.__arcRhoDatasetCopyActiveGridSelection = copyActiveRangeToClipboard;
    window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;

    const wrap = document.getElementById("tableWrap");
    if (!wrap) return;

    wireTableScrollSnapAfterIdle(wrap);
    wireTableScrollArrowButtons(wrap);

    // start drag
    wrap.addEventListener("mousedown", (e) => {
      // left button only
      if (e.button !== 0) return;
      if (isTypingTarget(e.target)) return;

      // NEW: leave dropdown/input focus when interacting with grid
      const ae = document.activeElement;
      if (ae && isTypingTarget(ae)) {
        try { ae.blur(); } catch {}
      }

      const td = e.target.closest('td[data-r][data-c]');
      if (!td) return;

      e.preventDefault(); // stop text selection

      const rc = rcFromTd(td);
      if (!rc) return;
      window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;

      // Toggle: click the already-active cell to deselect
      if (state.activeCell && state.activeCell.r === rc.r && state.activeCell.c === rc.c) {
        state.activeCell = null;
        state.selRanges = [];
        state.dragSel = null;
        clearSelectionClasses();
        renderActiveCellUI();
        return;
      }

      const append = !!e.ctrlKey;

      // if not appending, replace selection
      if (!append) state.selRanges = [];

      state.dragSel = {
        anchor: { r: rc.r, c: rc.c },
        cur: { r: rc.r, c: rc.c },
        append,
        lastApplied: null,
      };

      const rg = normalizeRange(rc.r, rc.c, rc.r, rc.c);
      state.selRanges.push(rg);

      setActiveCell(rc.r, rc.c);
      applySelectionFromState();
    });

    // drag over (use mouseover to avoid heavy mousemove)
    wrap.addEventListener("mouseover", (e) => {
      if (!state.dragSel) return;

      const td = e.target.closest('td[data-r][data-c]');
      if (!td) return;

      const rc = rcFromTd(td);
      if (!rc) return;

      const { anchor } = state.dragSel;
      state.dragSel.cur = { r: rc.r, c: rc.c };

      // update last range only
      const lastIdx = (state.selRanges?.length || 0) - 1;
      if (lastIdx < 0) return;

      state.selRanges[lastIdx] = normalizeRange(anchor.r, anchor.c, rc.r, rc.c);

      setActiveCell(rc.r, rc.c);
      applySelectionFromState();
    });

    // end drag anywhere
    document.addEventListener("mouseup", () => {
      state.dragSel = null;
    });

    // Click row header -> select entire row
    // Click row header -> select / deselect entire row
    wrap.addEventListener("click", (e) => {
      const th = e.target.closest("th.rowhdr[data-r]");
      if (!th) return;
      const r = Number(th.dataset.r);
      const model = getDisplayDatasetModel();
      if (!model) return;
      window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;
      const vals = Array.isArray(model.values) ? model.values : [];
      let maxCols = 0;
      for (const row of vals) {
        if (Array.isArray(row)) maxCols = Math.max(maxCols, row.length);
      }
      const maxC = (maxCols || (model.dev_labels?.length || 0)) - 1;
      if (maxC < 0) return;

      const rowRange = normalizeRange(r, 0, r, maxC);
      // Toggle: if this row is already fully selected, deselect it
      const idx = (state.selRanges || []).findIndex(
        rg => rg.r0 === rowRange.r0 && rg.r1 === rowRange.r1 && rg.c0 === rowRange.c0 && rg.c1 === rowRange.c1
      );
      if (idx >= 0) {
        state.selRanges.splice(idx, 1);
        if (state.activeCell?.r === r) {
          state.activeCell = null;
        }
      } else {
        if (!e.ctrlKey) state.selRanges = [];
        state.selRanges.push(rowRange);
        state.activeCell = { r, c: 0 };
      }
      state._shiftAnchor = null;
      renderActiveCellUI();
      applySelectionFromState();
    });

    // Click column header -> select / deselect entire column
    wrap.addEventListener("click", (e) => {
      const th = e.target.closest("th.colhdr[data-c]");
      if (!th) return;
      const c = Number(th.dataset.c);
      const model = getDisplayDatasetModel();
      if (!model) return;
      window.__arcRhoCopyActiveGridSelection = copyActiveRangeToClipboard;
      const maxR = (model.origin_labels?.length || 0) - 1;
      if (maxR < 0) return;

      const colRange = normalizeRange(0, c, maxR, c);
      // Toggle: if this column is already fully selected, deselect it
      const idx = (state.selRanges || []).findIndex(
        rg => rg.r0 === colRange.r0 && rg.r1 === colRange.r1 && rg.c0 === colRange.c0 && rg.c1 === colRange.c1
      );
      if (idx >= 0) {
        state.selRanges.splice(idx, 1);
        if (state.activeCell?.c === c) {
          state.activeCell = null;
        }
      } else {
        if (!e.ctrlKey) state.selRanges = [];
        state.selRanges.push(colRange);
        state.activeCell = { r: 0, c };
      }
      state._shiftAnchor = null;
      renderActiveCellUI();
      applySelectionFromState();
    });

    // Ctrl+C copy
    document.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;

      const isCopy = (e.key === "c" || e.key === "C") && e.ctrlKey;
      if (!isCopy) return;

      if (!state.selRanges || !state.selRanges.length) return;
      if (window.__arcRhoCopyActiveGridSelection !== copyActiveRangeToClipboard) return;

      e.preventDefault();
      copyActiveRangeToClipboard();
    });
  }

  return {
    applySelectionFromState,
    copyActiveRangeToClipboard,
  };
}
