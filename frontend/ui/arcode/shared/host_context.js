export const shell = {};

export function registerShellApi(api = {}) {
  Object.assign(shell, api);
  return shell;
}

export const $ = (id) => document.getElementById(id);

export function getHostApi() {
  return window.ADAHost || null;
}
