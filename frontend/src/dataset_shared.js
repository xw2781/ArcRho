export function injectDatasetMarkup(container) {
  if (!container) return null;
  if (container.querySelector("#topFrame")) return container;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<div class="panel" id="topFrame">
    <div class="topFrameGrid">
      <div class="topField">
        <label class="small" for="projectSelect">Project Name</label>
        <div class="projectSelectWrap">
          <input id="projectSelect" autocomplete="off" />
          <div id="projectDropdown" class="projectDropdown"></div>
        </div>
      </div>

      <div class="topField">
        <label class="small" for="pathInput">Reserving Class</label>
        <input id="pathInput" />
      </div>

      <div class="topField">
        <label class="small" for="triInput">Dataset Name</label>
        <div class="datasetSelectWrap">
          <input id="triInput" autocomplete="off" />
          <div id="datasetDropdown" class="datasetDropdown"></div>
        </div>
      </div>

      
    </div>
  </div>

  <div class="row">

    <!-- Right side -->
    <div class="right">

      <!-- Top row: formula + parameter strip on same line -->
      <div class="topRow">
        <!-- formula bar panel -->
        <div class="panel" id="fxPanel">
          <div class="fxbar-top small">
            <b id="cellRef">Formula</b>
            <span id="cellMeta"></span>
          </div>
          <input id="formulaBar" placeholder="" />
        </div>

        <!-- parameter strip -->
        <div class="panel" id="datasetTopBar">
          <div class="topbar-grid">
            <!-- Col 1: Cumulative / Transposed / Development / Calendar -->
            <div class="topbar-left" style="grid-column: 1; grid-row: 1 / span 2;">
              <label class="chk"><span>Cumulative:</span> <input id="cumulativeChk" type="checkbox" /></label>
              <label class="chk"><span>Transposed:</span> <input id="transposedChk" type="checkbox" /></label>
              <label class="rad">
                <input type="radio" name="timeMode" value="development" checked />
                <span>Development</span>
              </label>
              <label class="rad">
                <input type="radio" name="timeMode" value="calendar" />
                <span>Calendar</span>
              </label>
            </div>

            <!-- Col 2: Labels -->
            <div class="topbar-label-stack" style="grid-column: 2; grid-row: 1 / span 2;">
              <div class="topbar-label"><span class="lbl">Origin Length:</span></div>
              <div class="topbar-label"><span class="lbl">Development Length:</span></div>
            </div>

            <!-- Col 3: Inputs -->
            <div class="topbar-input-stack" style="grid-column: 3; grid-row: 1 / span 2;">
              <div class="topbar-input"><select id="originLenSelect"></select></div>
              <div class="topbar-input"><select id="devLenSelect"></select></div>
            </div>

            <!-- Col 4: Remaining -->
            <div class="topbar-right-stack" style="grid-column: 4; grid-row: 1 / span 2;">
              <div class="topbar-right">
                <div class="field linkField">
                  <label class="linkToggle">
                    <input id="linkLenChk" type="checkbox" />
                    <span class="linkIcon" aria-hidden="true">&#128279;</span>
                    <span class="linkText">Link Period Length</span>
                    <span class="linkTip" role="tooltip">Keep Origin Length and Development Length the same</span>
                  </label>
                </div>
              </div>
              <div class="topbar-right">
                <div class="field">
                  <span class="lbl">Decimal Places:</span>
                  <input id="decimalPlaces" type="number" min="0" max="6" value="1" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Triangle -->
      <div class="panel" id="triPanel">
        <div class="panelInner">
          <div class="small" id="tableMeta" style="margin-bottom:6px;"></div>
          <div id="tableWrap"></div>
        </div>
      </div>

      <!-- Chart -->
      <div class="panel" id="chartPanel">
        <div class="panelInner">
          <div class="small"><b>Development Curves</b></div>
          <div class="chartRow">
            <div class="chartCanvasWrap">
              <canvas id="devChart"></canvas>
            </div>
            <div id="devChartLegend" class="chartLegend" aria-label="Legend"></div>
          </div>
        </div>
      </div>

    </div>

  </div>

  <div id="hiddenControls" style="display:none;">
    <div class="small" id="dsMeta"></div>
    <button id="saveBtn">Save</button>
    <button id="toggleBlankBtn">Show blanks</button>
    <pre id="log"></pre>
  </div>

  <div id="ctxMenu" class="ctx-menu" style="display:none;">
    <div class="ctx-menu-inner">
      <button class="ctx-item" data-action="copy_value">Copy value</button>
      <button class="ctx-item" data-action="copy_formula">Copy formula</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-action="clear">Clear</button>
      <button class="ctx-item" data-action="select_all">Select all</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-action="export_data">Export data</button>
    </div>
  </div>

  <!-- Same-folder JS entrypoint (no /static) -->
  <!--  -->`;
  while (wrapper.firstElementChild) {
    container.appendChild(wrapper.firstElementChild);
  }
  return container;
}
