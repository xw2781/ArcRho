export function createFileIconResolver(fileIconMap) {
  function normalizeName(value) {
    return String(value || "").replace(/\\/g, "/").split("/").pop() || "";
  }

  function lookupCaseInsensitive(table, key) {
    if (!key) {
      return undefined;
    }
    const directMatch = table[key] || table[key.toLowerCase()];
    if (directMatch) {
      return directMatch;
    }
    const lowerKey = key.toLowerCase();
    const match = Object.entries(table).find(([entryKey]) => entryKey.toLowerCase() === lowerKey);
    return match ? match[1] : undefined;
  }

  return function getFileIconPath(fileName, options = {}) {
    const name = normalizeName(fileName);
    if (!name) {
      return fileIconMap.defaults.file;
    }

    if (options.isDirectory) {
      return (
        lookupCaseInsensitive(fileIconMap.folderNames, name) ||
        (options.isOpen ? fileIconMap.defaults.folderOpen : fileIconMap.defaults.folder)
      );
    }

    const fileNameMatch = lookupCaseInsensitive(fileIconMap.fileNames, name);
    if (fileNameMatch) {
      return fileNameMatch;
    }

    const lowerName = name.toLowerCase();
    const compoundMatch = Object.entries(fileIconMap.compoundExtensions).find(([extension]) =>
      lowerName.endsWith(`.${extension}`)
    );
    if (compoundMatch) {
      return compoundMatch[1];
    }

    const lastDotIndex = lowerName.lastIndexOf(".");
    if (lastDotIndex > 0 && lastDotIndex < lowerName.length - 1) {
      const extension = lowerName.slice(lastDotIndex + 1);
      return fileIconMap.extensions[extension] || fileIconMap.defaults.file;
    }

    return fileIconMap.defaults.file;
  };
}
