import { startDfmRpcBridgeSync } from "/ui/method_pages/dfm/dfm_rpc_bridge_client.js?v=20260716a";

const STYLE_ID = "dfm-rpc-bridge-tabbar-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dfmTabBar .dfmRpcSyncBtn {
      flex: 0 0 auto;
      height: 24px;
      min-width: 56px;
      margin: 0 2px 3px auto;
      padding: 0 10px;
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      background: #fff;
      color: #1f2937;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      align-self: flex-end;
      box-sizing: border-box;
    }
    .dfmTabBar .dfmRpcSyncBtn:hover:not(:disabled) {
      background: #eef5ff;
      border-color: #8fb1e8;
      color: #2457a6;
    }
    .dfmTabBar .dfmRpcSyncBtn:disabled {
      opacity: 0.58;
      cursor: wait;
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
  button.textContent = "Sync";
  button.title = "Sync DFM through RPC bridge";
  button.addEventListener("click", () => startDfmRpcBridgeSync(button));
  tabBar.appendChild(button);
}
