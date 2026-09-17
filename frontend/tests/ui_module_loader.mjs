// Resolve the browser's /ui imports when real modules are exercised under Node.
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/ui/")) return nextResolve(new URL(`..${specifier.split("?")[0]}`, import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
