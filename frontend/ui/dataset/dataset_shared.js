export function injectDatasetMarkup(container) {
  if (!container) return null;
  if (container.querySelector("#topFrame")) return container;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<button
    id="clearCacheReloadBtn"
    type="button"
    title="Clear Cache and Reload"
    aria-label="Clear Cache and Reload"
  >&#x21bb;</button>
  <!-- Tab bar -->
  <div class="dsTabBar">
    <button class="dsTab" data-page="details" type="button">Details</button>
    <button class="dsTab active" data-page="data" type="button">Data</button>
    <button class="dsTab" data-page="chart" type="button">Chart</button>
    <button class="dsTab" data-page="notes" type="button">Notes</button>
    <button class="dsTab" data-page="auditLog" type="button">Audit Log</button>
  </div>

  <!-- Details tab page -->
  <div id="dsDetailsPage" style="display:none;">
    <div class="panel dsDetailsFrame" id="topFrame">
      <div class="topFrameGrid">
        <div class="topField">
          <label class="small" for="projectSelect">Project Name</label>
          <div class="projectSelectWrap">
            <input id="projectSelect" autocomplete="off" />
            <button id="projectTreeBtn" type="button" class="projectTreeBtn" title="Browse project folders" aria-label="Browse project folders">
              ...
            </button>
            <div id="projectDropdown" class="projectDropdown"></div>
          </div>
        </div>

        <div class="topField">
          <label class="small" for="pathInput">Reserving Class</label>
          <div class="reservingClassWrap">
            <input id="pathInput" />
            <button id="pathTreeBtn" type="button" class="pathTreeBtn" title="Browse reserving classes" aria-label="Browse reserving classes">...</button>
          </div>
        </div>

      </div>
    </div>

    <div class="dsDetailsPanel">
      <div class="dsDetailsGrid">
        <div class="dsDetailLabel">
          <label class="small" for="dsDetailName">Name</label>
        </div>
        <div class="dsDetailInput">
          <div class="dsDetailNameWrap">
            <input id="dsDetailName" autocomplete="off" />
            <span id="dsDetailNameWarning" class="dsDetailNameWarning" role="tooltip" aria-live="polite" hidden></span>
          </div>
        </div>

        <div class="dsDetailLabel">
          <label class="small" for="triInput">Dataset Type</label>
        </div>
        <div class="dsDetailInput">
          <div class="datasetSelectWrap">
            <input id="triInput" autocomplete="off" />
            <button id="datasetTreeBtn" type="button" class="datasetTreeBtn" title="Browse dataset types" aria-label="Browse dataset types">...</button>
            <div id="datasetDropdown" class="datasetDropdown"></div>
          </div>
        </div>

        <div class="dsDetailLabel">
          <label class="small" id="dsFormulaLabel" for="dsDetailFormulaBox">Formula</label>
        </div>
        <div class="dsDetailInput">
          <div id="dsDetailFormulaBox" class="dsDetailFormulaBox" role="group" aria-labelledby="dsFormulaLabel"></div>
          <textarea id="dsDetailFormula" autocomplete="off" readonly rows="1" tabindex="-1" aria-hidden="true"></textarea>
        </div>

        <div class="dsDetailLabel">
          <label class="small" id="dsPrecedentsTitle">Precedents</label>
        </div>
        <div class="dsDetailInput">
          <div class="dsDatasetChipBox">
            <div id="dsPrecedentsList" class="dsDatasetChipList" aria-live="polite"></div>
          </div>
        </div>

        <div class="dsDetailLabel">
          <label class="small" id="dsDependentsTitle">Dependents</label>
        </div>
        <div class="dsDetailInput">
          <div class="dsDatasetChipBox">
            <div id="dsDependentsList" class="dsDatasetChipList" aria-live="polite"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Data tab page: parameter strip + formula bar + triangle table -->
  <div id="dsDataPage">
    <!-- parameter strip -->
    <div class="topRow">
      <div class="panel" id="datasetTopBar">
        <div class="topbar-grid">
          <!-- Col 1: Cumulative / Transposed / Development / Calendar -->
          <div class="topbar-left" style="grid-column: 1; grid-row: 1 / span 2;">
            <label class="chk"><span>Cumulative:</span> <input id="cumulativeChk" type="checkbox" checked /></label>
            <label class="chk"><span>Transposed:</span> <input id="transposedChk" type="checkbox" /></label>
            <div class="timeModeFrame" role="group" aria-label="Time mode">
              <label class="rad">
                <input type="radio" name="timeMode" value="development" checked />
                <span>Development</span>
              </label>
              <label class="rad">
                <input type="radio" name="timeMode" value="calendar" />
                <span>Calendar</span>
              </label>
            </div>
          </div>

          <!-- Col 2: Labels -->
          <div class="topbar-label-stack" style="grid-column: 2; grid-row: 1 / span 2;">
            <div class="topbar-label"><span class="lbl">Origin Length:</span></div>
            <div class="topbar-label"><span class="lbl">Development Length:</span></div>
          </div>

          <!-- Col 3: Inputs -->
          <div class="topbar-input-stack" style="grid-column: 3; grid-row: 1 / span 2;">
            <div class="topbar-input">
              <div id="originLenWrap" class="lenSelectWrap">
                <button
                  id="originLenDisplay"
                  class="lenSelectDisplay"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  aria-controls="originLenDropdown"
                >
                  <span class="lenSelectValue">12</span>
                  <span class="lenSelectCaret" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </span>
                </button>
                <div id="originLenDropdown" class="datasetDropdown lenDropdown" role="listbox" aria-label="Origin Length options"></div>
                <select id="originLenSelect" class="lenSelectNative" tabindex="-1" aria-hidden="true"></select>
              </div>
            </div>
            <div class="topbar-input">
              <div id="devLenWrap" class="lenSelectWrap">
                <button
                  id="devLenDisplay"
                  class="lenSelectDisplay"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  aria-controls="devLenDropdown"
                >
                  <span class="lenSelectValue">12</span>
                  <span class="lenSelectCaret" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </span>
                </button>
                <div id="devLenDropdown" class="datasetDropdown lenDropdown" role="listbox" aria-label="Development Length options"></div>
                <select id="devLenSelect" class="lenSelectNative" tabindex="-1" aria-hidden="true"></select>
              </div>
            </div>
          </div>

          <!-- Col 4: Number formatting labels -->
          <div class="topbar-format-label-stack" style="grid-column: 4; grid-row: 1 / span 2;">
            <div class="topbar-label"><span class="lbl">Number Format:</span></div>
            <div class="topbar-label"><span class="lbl">Decimal Places:</span></div>
          </div>

          <!-- Col 5: Number formatting inputs -->
          <div class="topbar-format-input-stack" style="grid-column: 5; grid-row: 1 / span 2;">
            <div class="topbar-input">
              <div id="numberFormatWrap" class="numberFormatWrap">
                <input id="numberFormatSelect" type="text" value="0,000" aria-label="Number Format" aria-controls="numberFormatDropdown" aria-expanded="false" autocomplete="off" />
                <button id="numberFormatDropdownBtn" class="numberFormatDropdownBtn" type="button" aria-label="Show Number Format presets" aria-controls="numberFormatDropdown" aria-expanded="false">
                  <span class="lenSelectCaret" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </span>
                </button>
                <div id="numberFormatDropdown" class="datasetDropdown numberFormatDropdown" role="listbox" aria-label="Number Format presets"></div>
              </div>
            </div>
            <div class="topbar-input">
              <div id="decimalPlacesWrap" class="decimalPlacesWrap">
                <input id="decimalPlaces" type="number" min="0" max="6" value="1" aria-label="Decimal Places" />
                <div class="decimalPlacesStepper">
                  <button id="decimalPlacesUpBtn" class="decimalPlacesStepBtn" type="button" aria-label="Increase Decimal Places">
                    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                      <path d="M4.5 9.5 8 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </button>
                  <button id="decimalPlacesDownBtn" class="decimalPlacesStepBtn" type="button" aria-label="Decrease Decimal Places">
                    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Col 6: Link toggle -->
          <div class="topbar-link-stack" style="grid-column: 6; grid-row: 1;">
            <div class="field linkField">
              <label class="linkToggle">
                <input id="linkLenChk" type="checkbox" checked />
                <span class="linkIcon" aria-hidden="true">&#128279;</span>
                <span class="linkText">Link Period Length</span>
                <span class="linkTip" role="tooltip">Keep Origin Length and Development Length the same</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Triangle -->
    <div class="panel" id="triPanel">
      <div id="tableWrapHost">
        <div id="tableWrap"></div>
        <button id="tableScrollUpBtn" class="tableScrollArrow" type="button" title="Scroll up" aria-label="Scroll up">
          <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true"><path d="M4.5 10.5 8 7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        </button>
        <button id="tableScrollDownBtn" class="tableScrollArrow" type="button" title="Scroll down" aria-label="Scroll down">
          <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true"><path d="M4.5 5.5 8 9l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        </button>
        <button id="tableScrollLeftBtn" class="tableScrollArrow" type="button" title="Scroll left" aria-label="Scroll left">
          <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true"><path d="M10.5 4.5 7 8l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        </button>
        <button id="tableScrollRightBtn" class="tableScrollArrow" type="button" title="Scroll right" aria-label="Scroll right">
          <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true"><path d="M5.5 4.5 9 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        </button>
      </div>
    </div>
  </div>

  <!-- Chart tab page -->
  <div id="dsChartPage" style="display:none;">
    <div class="right">
      <div class="panel" id="chartPanel">
        <div class="panelInner">
          <div class="chartHeader">
            <span class="small"><b id="chartTitle">Development Curves</b></span>
            <div class="chartToggle" id="chartModeToggle">
              <button class="chartToggleBtn active" data-mode="byCol" title="By Column (Dev Period)">By Column</button>
              <button class="chartToggleBtn" data-mode="byRow" title="By Row (Origin)">By Row</button>
            </div>
          </div>
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

  <!-- Notes tab page -->
  <div id="dsNotesPage" style="display:none;">
    <div class="dsNotesEditorWrap">
      <div class="notesFormatToolbar" id="dsNotesFormatToolbar" data-notes-format-toolbar>
        <label class="notesFormatGroup" title="Font family">
          <span class="notesFormatLabel">Font</span>
          <select class="notesFormatSelect notesFormatFontFamily" data-notes-style="font-family">
            <option value="">Default</option>
            <option value="'Segoe UI', Tahoma, sans-serif">Segoe UI</option>
            <option value="Calibri, 'Segoe UI', sans-serif">Calibri</option>
            <option value="'Consolas', 'Courier New', monospace">Consolas</option>
            <option value="'Georgia', serif">Georgia</option>
          </select>
        </label>
        <label class="notesFormatGroup" title="Font size">
          <span class="notesFormatLabel">Size</span>
          <input
            class="notesFormatInput notesFormatFontSize"
            type="number"
            min="8"
            max="48"
            step="1"
            value="13"
            data-notes-style="font-size"
          />
        </label>
        <label class="notesFormatGroup notesFormatColorGroup" title="Text color">
          <span class="notesFormatLabel">Color</span>
          <input class="notesFormatColor" type="color" value="#1c2433" data-notes-style="color" />
        </label>
        <span class="notesFormatDivider" aria-hidden="true"></span>
        <button type="button" class="notesFormatToggle" data-notes-toggle="bold" aria-pressed="false" title="Bold">B</button>
        <button type="button" class="notesFormatToggle notesFormatToggleItalic" data-notes-toggle="italic" aria-pressed="false" title="Italic">I</button>
        <button type="button" class="notesFormatToggle" data-notes-toggle="underline" aria-pressed="false" title="Underline">U</button>
        <button type="button" class="notesFormatToggle" data-notes-toggle="strike" aria-pressed="false" title="Strikethrough">S</button>
      </div>
      <div class="dsNotesInputWrap" id="dsNotesInputWrap">
        <pre id="dsNotesDecor" aria-hidden="true"></pre>
        <textarea
          id="dsNotesInput"
          placeholder="Enter notes..."
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
        ></textarea>
      </div>
      <div class="dsNotesToolbar" id="dsNotesToolbar">
        <div class="dsNotesActions">
          <span id="dsNotesSaveState" class="small dsNotesSaveState">Not saved</span>
          <button id="dsNotesSaveBtn" type="button">Save Notes</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Audit Log tab page -->
  <div id="dsAuditLogPage" style="display:none;">
    <div class="datasetAuditLogWrap">
      <table class="datasetAuditLogTable" aria-label="Dataset audit log">
        <colgroup>
          <col>
          <col>
          <col>
          <col>
        </colgroup>
        <thead>
          <tr>
            <th>Event Date</th>
            <th>Action</th>
            <th>Change Info</th>
            <th>User</th>
          </tr>
        </thead>
        <tbody id="datasetAuditLogBody"></tbody>
      </table>
      <div id="datasetAuditLogEmpty" class="dsPlaceholderText">No audit entries yet.</div>
    </div>
  </div>

  <div id="datasetSaveBar" class="datasetSaveBar" hidden>
    <button id="datasetSaveBtn" class="datasetPrimaryBtn" type="button">Save</button>
    <button id="datasetCancelBtn" class="datasetSecondaryBtn" type="button">Cancel</button>
  </div>

  <div id="hiddenControls" style="display:none;">
    <div class="small" id="dsMeta"></div>
    <button id="saveBtn">Save</button>
    <button id="toggleBlankBtn">Show blanks</button>
    <pre id="log"></pre>
  </div>

  <div id="datasetCancelConfirmOverlay" class="datasetCancelConfirmOverlay" hidden>
    <div class="datasetCancelConfirmBox" role="dialog" aria-modal="true" aria-labelledby="datasetCancelConfirmTitle">
      <button id="datasetCancelConfirmClose" class="datasetCancelConfirmClose" type="button" aria-label="Close">x</button>
      <div id="datasetCancelConfirmTitle" class="datasetCancelConfirmTitle">Cancel changes?</div>
      <div id="datasetCancelConfirmMessage" class="datasetCancelConfirmMessage">
        Unsaved dataset changes will be discarded.
      </div>
      <div class="datasetCancelConfirmActions">
        <button id="datasetCancelConfirmYes" class="datasetPrimaryBtn" type="button">Yes</button>
        <button id="datasetCancelConfirmNo" class="datasetSecondaryBtn" type="button">Cancel</button>
      </div>
    </div>
  </div>

  <div id="datasetRecalcOverlay" class="datasetRecalcOverlay" hidden>
    <div class="datasetRecalcBox" role="dialog" aria-modal="true" aria-labelledby="datasetRecalcTitle">
      <button id="datasetRecalcClose" class="datasetCancelConfirmClose" type="button" aria-label="Close">x</button>
      <div id="datasetRecalcTitle" class="datasetRecalcTitle">Calculated Dataset Refresh</div>
      <div id="datasetRecalcSummary" class="datasetRecalcSummary"></div>
      <div id="datasetRecalcList" class="datasetRecalcList" aria-live="polite"></div>
      <div class="datasetCancelConfirmActions">
        <button id="datasetRecalcOk" class="datasetPrimaryBtn is-clean" type="button">OK</button>
      </div>
    </div>
  </div>

  <div id="ctxMenu" class="ctx-menu" style="display:none;">
    <div class="ctx-menu-inner">
      <button class="ctx-item" data-action="copy_value">Copy value</button>
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
