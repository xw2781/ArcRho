// Single source of truth for UI state.

export const state = {
  model: null,
  dirty: new Map(),
  fileMtime: null,
  showBlanks: false,

  activeCell: null, // { r, c } or null
};

