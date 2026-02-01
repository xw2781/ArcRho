const params = new URL(import.meta.url).search;
const ratiosUrl = new URL("./dfm_ratios.js", import.meta.url);
ratiosUrl.search = params;

const { initDfmRatios } = await import(ratiosUrl.toString());
initDfmRatios();
