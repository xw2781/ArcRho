let mountPageHostHandler = () => null;

export function configureDataTabPageHost(mountPageHost) {
  mountPageHostHandler = typeof mountPageHost === "function"
    ? mountPageHost
    : () => null;
}

export function mountDataTabPageHost(options = {}) {
  return mountPageHostHandler(options);
}
