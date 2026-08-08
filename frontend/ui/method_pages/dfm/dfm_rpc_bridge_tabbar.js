import { startDfmRpcBridgeSync } from "/ui/method_pages/dfm/dfm_rpc_bridge_client.js?v=20260807b";

const STYLE_ID = "dfm-rpc-bridge-tabbar-style";

const SYNC_ICON_SVG = `
    <svg class="dfmRpcSyncIcon" width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
      <path d="M21 3v5h-5"/>
    </svg>
  `;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dfmTabBar .dfmRpcSyncBtn {
      flex: 0 0 auto;
      position: relative;
      height: 24px;
      width: 28px;
      margin: 0 2px 3px auto;
      padding: 0;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: #475569;
      cursor: pointer;
      align-self: flex-end;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .dfmTabBar .dfmRpcSyncBtn .dfmRpcSyncIcon {
      flex: 0 0 auto;
      transition: transform 0.35s ease;
    }
    .dfmTabBar .dfmRpcSyncBtn:hover:not(:disabled) .dfmRpcSyncIcon {
      transform: rotate(180deg);
    }
    @keyframes dfmRpcSyncIconSpin {
      to { transform: rotate(360deg); }
    }
    .dfmTabBar .dfmRpcSyncBtn:disabled .dfmRpcSyncIcon {
      animation: dfmRpcSyncIconSpin 1s linear infinite;
    }
    .dfmTabBar .dfmRpcSyncBtn:hover:not(:disabled) {
      background: #e4edf9;
      color: #2457a6;
    }
    .dfmTabBar .dfmRpcSyncBtn:disabled {
      cursor: wait;
    }
    .dfmTabBar .dfmRpcSyncBtn:disabled .dfmRpcSyncIcon {
      opacity: 0.58;
    }
    .dfmTabBar .dfmRpcSyncBtn::after {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 7px);
      right: 0;
      padding: 4px 9px;
      border-radius: 5px;
      background: #1f2937;
      color: #f1f5f9;
      font-size: 11.5px;
      font-weight: 400;
      line-height: 1.35;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.28);
      opacity: 0;
      transform: translateY(-3px);
      pointer-events: none;
      transition: opacity 0.12s ease, transform 0.12s ease;
      z-index: 60;
    }
    .dfmTabBar .dfmRpcSyncBtn::before {
      content: "";
      position: absolute;
      top: calc(100% - 3px);
      right: 9px;
      border: 5px solid transparent;
      border-bottom-color: #1f2937;
      opacity: 0;
      transform: translateY(-3px);
      pointer-events: none;
      transition: opacity 0.12s ease, transform 0.12s ease;
      z-index: 60;
    }
    .dfmTabBar .dfmRpcSyncBtn:hover::after,
    .dfmTabBar .dfmRpcSyncBtn:hover::before {
      opacity: 1;
      transform: none;
      transition-delay: 0.35s;
    }
    .dfmTabBar .dfmRpcSyncBtn:disabled::after {
      content: "Syncing with ResQ Server\\2026";
    }
  `;
  document.head.appendChild(style);
}

export function wireDfmRpcBridgeTabBar() {
  const tabBar = document.querySelector(".dfmTabBar");
  if (!tabBar || tabBar.dataset.rpcBridgeWired === "1") return;
  ensureStyles();
  tabBar.dataset.rpcBridgeWired = "1";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dfmRpcSyncBtn";
  button.innerHTML = SYNC_ICON_SVG;
  button.setAttribute("aria-label", "Sync");
  button.dataset.tooltip = "Sync DFM with ResQ Server";
  button.addEventListener("click", () => startDfmRpcBridgeSync(button));
  tabBar.appendChild(button);
}
