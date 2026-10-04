// Exercises the shared appearance window against the real DFM tables.
module.exports = async function checkTableAppearance(win, { evaluate, click, until, verify }) {
  const average = '.arTableFontControls[data-font-group="dfm-averages"]';
  const baseline = await evaluate(win, () => ({
    ratio: getComputedStyle(document.querySelector(".ratioMainTable td")).fontWeight,
    selected: getComputedStyle(document.querySelector(".ratioSelectedTable td")).fontWeight,
    average: getComputedStyle(document.querySelector(".ratioSummaryTable td")).fontWeight,
  }));
  async function open() {
    await click(win, ".ratioMainTable td.ratioCell", { button: "right" });
    verify(await evaluate(win, () => document.querySelector("#dfmRatioMenu [data-table-colors]").textContent === "Table Appearance…"), "Context menu uses the broader appearance label");
    await click(win, "#dfmRatioMenu [data-table-colors]");
    await until(win, () => !!document.querySelector('.arTableColorsWindow[aria-label="Table Appearance"]'));
  }
  await open();
  verify(await evaluate(win, () => {
    const controls = document.querySelector('[data-font-group="dfm-averages"]');
    const style = getComputedStyle(document.querySelector(".ratioSummaryTable td"));
    const family = controls.querySelector('[data-font-property="family"]');
    const size = controls.querySelector('[data-font-property="size"]');
    return family.value === style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "")
      && Number(size.value) === parseFloat(style.fontSize)
      && !family.classList.contains("isCustom") && !size.classList.contains("isCustom")
      && !JSON.parse(localStorage.getItem("arcrho_table_colors") || "{}").fonts;
  }), "Font fields show the current table style without creating overrides");
  await click(win, `${average} [data-font-property="bold"]`);
  verify(await evaluate(win, () => getComputedStyle(document.querySelector(".ratioSummaryTable td")).fontWeight === "700"), "Average Formulas can be made bold");
  verify(await evaluate(win, original => getComputedStyle(document.querySelector(".ratioMainTable td")).fontWeight === original.ratio
    && getComputedStyle(document.querySelector(".ratioSelectedTable td")).fontWeight === original.selected, baseline), "Section bold leaves the triangle and selected table unchanged");
  await click(win, `${average} [data-font-property="italic"]`);
  await evaluate(win, () => {
    const controls = document.querySelector('[data-font-group="dfm-averages"]');
    for (const [key, value] of [["family", "Consolas"], ["size", "18"]]) {
      const input = controls.querySelector(`[data-font-property="${key}"]`);
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  verify(await evaluate(win, () => {
    const style = getComputedStyle(document.querySelector(".ratioSummaryTable td"));
    return style.fontFamily.includes("Consolas") && style.fontSize === "18px" && style.fontStyle === "italic" && style.fontWeight === "700";
  }), "Family, size, bold and italic combine on the chosen section");
  verify(await evaluate(win, () => {
    const style = getComputedStyle(document.querySelector(".dfmSummaryLabelText"));
    return parseFloat(style.maxHeight) >= 2 * parseFloat(style.lineHeight) - 0.1;
  }), "Larger fonts retain room for both summary-label lines");
  await click(win, '.arTableColorsRow[data-component="cell-border"] [data-property="border"]');
  await click(win, '.arTableColorsPreset[aria-label="Red"]');
  verify(await evaluate(win, () => {
    const cell = document.querySelector(".ratioMainTable td.na:not(:last-child)");
    return getComputedStyle(cell).borderRightColor === "rgb(185, 28, 28)";
  }), "Border color customization continues to reach N/A cells");
  await click(win, '.arTableColorsWindow [data-action="close"]');
  await open();
  verify(await evaluate(win, () => {
    const prefs = JSON.parse(localStorage.getItem("arcrho_table_colors"));
    return prefs.fonts["dfm-averages"].bold && prefs.fonts["dfm-averages"].family === "Consolas"
      && document.querySelector('[data-font-group="dfm-averages"] [data-font-property="bold"]').getAttribute("aria-pressed") === "true";
  }), "Reopening restores section font preferences alongside colors");
  await click(win, `${average} .arTableFontReset`);
  verify(await evaluate(win, original => {
    const prefs = JSON.parse(localStorage.getItem("arcrho_table_colors"));
    return !prefs.fonts?.["dfm-averages"] && prefs.components["cell-border"].border === "#b91c1c"
      && getComputedStyle(document.querySelector(".ratioSummaryTable td")).fontWeight === original.average;
  }, baseline), "Section font reset restores defaults without clearing border colors");
  await evaluate(win, () => {
    const controls = document.querySelector('[data-font-group="tables"]');
    for (const [key, value] of [["family", "Georgia"], ["size", "16"]]) {
      const input = controls.querySelector(`[data-font-property="${key}"]`);
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  verify(await evaluate(win, () => {
    const controls = document.querySelector('[data-font-group="dfm-averages"]');
    return controls.querySelector('[data-font-property="family"]').value === "Georgia"
      && controls.querySelector('[data-font-property="size"]').value === "16"
      && !JSON.parse(localStorage.getItem("arcrho_table_colors")).fonts?.["dfm-averages"];
  }), "Section boxes display inherited font and size without storing local overrides");
  await evaluate(win, () => {
    const input = document.querySelector('[data-font-group="dfm-averages"] [data-font-property="size"]');
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  verify(await evaluate(win, () => document.querySelector('[data-font-group="dfm-averages"] [data-font-property="size"]').value === "16"), "Clearing an inherited field restores its effective value");
  await click(win, '.arTableFontControls[data-font-group="tables"] [data-font-property="bold"]');
  await click(win, `${average} [data-font-property="bold"]`);
  verify(await evaluate(win, () => getComputedStyle(document.querySelector(".ratioMainTable td")).fontWeight === "700"
    && getComputedStyle(document.querySelector(".ratioSummaryTable td")).fontWeight === "400"), "A normal section font overrides broad All Tables bold");
  await click(win, '.arTableColorsWindow [data-action="reset-all"]');
  verify(await evaluate(win, () => {
    const prefs = JSON.parse(localStorage.getItem("arcrho_table_colors"));
    return !prefs.fonts && !Object.keys(prefs.components).length;
  }), "Reset all clears both typography and colors");
  await click(win, '.arTableColorsWindow [data-action="close"]');
};
