export function wireDatasetHostBridge(deps) {
  const { getTriInputsForStorage, instanceId, redrawChartSafely } = deps;

  window.addEventListener("message", (e) => {
    if (e?.data?.type === "arcrho:get-dataset-settings") {
      const settings = getTriInputsForStorage();
      window.parent.postMessage(
        {
          type: "arcrho:dataset-settings",
          requestId: e.data.requestId,
          stepId: instanceId,
          settings,
        },
        "*"
      );
      return;
    }

    if (e?.data?.type === "arcrho:tab-activated") {
      // Only redraw when THIS tab becomes active
      requestAnimationFrame(() => {
        requestAnimationFrame(redrawChartSafely);
      });
    }
  });
}
