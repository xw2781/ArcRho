# File Icons

This folder contains a small, app-ready file icon package based on Material Icon
Theme SVG assets.

## Contents

- `icons/`: vendored SVG icon assets.
- `file-icon-map.json`: filename, extension, compound-extension, and folder mappings.
- `fileIconResolver.js`: dependency-free resolver factory.
- `folder-preview.html`: local picker for comparing replacement folder icons.
- `folder-candidates/`: candidate SVGs for replacing `icons/folder-base.svg`.
- `LICENSE.material-icon-theme`: upstream MIT license.

## Browser/Electron Usage

```js
import { createFileIconResolver } from "/ui/arcode/shared/file-icons/fileIconResolver.js";

const iconMap = await fetch("/ui/arcode/shared/file-icons/file-icon-map.json").then((response) =>
  response.json()
);
const getFileIconPath = createFileIconResolver(iconMap);

const iconPath = getFileIconPath("notebook.ipynb");
// icons/jupyter.svg
```

Resolve order:

1. Exact filenames, such as `package.json`, `README.md`, and `.gitignore`.
2. Compound extensions, such as `.test.tsx` and `.d.ts`.
3. Normal extensions, such as `.py`, `.json`, `.html`, `.js`, and `.ipynb`.
4. Folder names, when called with `{ isDirectory: true }`.
5. Default file or folder icon.

Source: https://github.com/material-extensions/vscode-material-icon-theme
