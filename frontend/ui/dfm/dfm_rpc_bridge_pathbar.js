import { startDfmRpcBridgeSync } from "/ui/dfm/dfm_rpc_bridge_client.js?v=20260616a";

const STYLE_ID = "dfm-rpc-bridge-pathbar-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #dfmPathBar.dfmRpcPathBar {
      display: flex;
      align-items: center;
      gap: 0;
      min-width: 0;
    }
    .dfmRpcPathText {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dfmRpcSyncBtn {
      flex: 0 0 auto;
      height: 26px;
      margin-left: 10px;
      padding: 0 10px;
      border: 1px solid #b9c4d3;
      border-radius: 6px;
      background: #fff;
      color: #1f2937;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .dfmRpcSyncBtn:hover:not(:disabled) {
      background: #eef5ff;
      border-color: #8fb1e8;
      color: #2457a6;
    }
    .dfmRpcSyncBtn:disabled {
      opacity: 0.58;
      cursor: wait;
    }
  `;
  document.head.appendChild(style);
}

export function wireDfmRpcBridgePathBar() {
  const bar = document.getElementById("dfmPathBar");
  if (!bar || bar.dataset.rpcBridgeWired === "1") return;
  ensureStyles();
  bar.dataset.rpcBridgeWired = "1";
  bar.classList.add("dfmRpcPathBar");

  const projectEl = document.getElementById("dfmPathProject");
  if (projectEl && !bar.querySelector(".dfmRpcPathText")) {
    const textWrap = document.createElement("span");
    textWrap.className = "dfmRpcPathText";
    const children = Array.from(bar.childNodes);
    for (const child of children) {
      textWrap.appendChild(child);
    }
    bar.appendChild(textWrap);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dfmRpcSyncBtn";
  button.textContent = "Sync";
  button.title = "Sync DFM through RPC bridge";
  button.addEventListener("click", () => startDfmRpcBridgeSync(button));
  bar.appendChild(button);
}
