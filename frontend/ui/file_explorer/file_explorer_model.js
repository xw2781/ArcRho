const HOME_FILE_TYPE_LABELS = Object.freeze({
  arcnb: "ArcRho Notebook",
  arcwf: "ArcRho Workflow",
  bat: "Windows Batch File",
  bmp: "Bitmap Image",
  cjs: "JavaScript File",
  cmd: "Windows Command Script",
  csv: "CSV File",
  doc: "Microsoft Word 97-2003 Document",
  docx: "Microsoft Word Document",
  gif: "GIF Image",
  htm: "HTML Document",
  html: "HTML Document",
  ipynb: "Jupyter Notebook",
  jpeg: "JPEG Image",
  jpg: "JPEG Image",
  js: "JavaScript File",
  json: "JSON File",
  jsonl: "JSON Lines File",
  md: "Markdown File",
  mjs: "JavaScript File",
  parquet: "Parquet File",
  pdf: "PDF Document",
  png: "PNG Image",
  ppt: "Microsoft PowerPoint 97-2003 Presentation",
  pptx: "Microsoft PowerPoint Presentation",
  ps1: "PowerShell Script",
  py: "Python File",
  r: "R Script",
  rtf: "Rich Text Format",
  sql: "SQL File",
  svg: "SVG Image",
  tif: "TIFF Image",
  tiff: "TIFF Image",
  ts: "TypeScript File",
  tsv: "TSV File",
  txt: "Text Document",
  xls: "Microsoft Excel 97-2003 Worksheet",
  xlsb: "Microsoft Excel Binary Worksheet",
  xlsm: "Microsoft Excel Macro-Enabled Worksheet",
  xlsx: "Microsoft Excel Worksheet",
  xml: "XML Document",
  yaml: "YAML File",
  yml: "YAML File",
  zip: "Compressed (zipped) Folder",
});

const HOME_FILE_SIZE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);

export const FILE_EXPLORER_FAVORITES_SCHEMA_VERSION = 1;

function trimmedText(value) {
  return String(value ?? "").trim();
}

function pathSegments(value) {
  return trimmedText(value).split(/[\\/]+/u).filter(Boolean);
}

function pathSeparator(value, fallback = "/") {
  const match = trimmedText(value).match(/[\\/]/u);
  return match?.[0] || fallback;
}

export function homeFolderPathKey(value) {
  const source = trimmedText(value);
  if (!source) return "";

  if (/^[\\/]{2}/u.test(source)) {
    return `unc:${pathSegments(source).join("\\").toLowerCase()}`;
  }

  const driveMatch = source.match(/^([A-Za-z]:)(.*)$/u);
  if (driveMatch) {
    const segments = pathSegments(driveMatch[2]);
    return `${driveMatch[1].toLowerCase()}\\${segments.join("\\").toLowerCase()}`;
  }

  const absolutePrefix = source.startsWith("/") ? "/" : "";
  return `${absolutePrefix}${pathSegments(source).join("/")}`.toLowerCase();
}

function basenameFromPath(value) {
  const segments = pathSegments(value);
  return segments[segments.length - 1] || "";
}

/**
 * Produces a human-readable default name without relying on Node's path APIs.
 * The helper is safe to use in both the browser renderer and Node tests.
 */
export function defaultHomeFolderNickname(pathLike) {
  const source = trimmedText(pathLike);
  if (!source) return "Folder";

  const driveMatch = source.match(/^([A-Za-z]:)(.*)$/u);
  if (driveMatch) {
    const segments = pathSegments(driveMatch[2]);
    return segments[segments.length - 1] || driveMatch[1].toUpperCase();
  }

  const segments = pathSegments(source);
  if (segments.length) return segments[segments.length - 1];
  if (source.startsWith("/")) return "/";
  return "Folder";
}

/**
 * Migrates legacy string shortcuts and normalizes persisted shortcut objects.
 * The first occurrence of a path wins so saved order and nicknames are stable.
 */
export function normalizeHomeFolderShortcuts(value) {
  const inputs = Array.isArray(value) ? value : [value];
  const shortcuts = [];
  const seenPaths = new Set();

  for (const input of inputs) {
    const objectInput = input && typeof input === "object" && !Array.isArray(input)
      ? input
      : null;
    const folderPath = trimmedText(
      typeof input === "string"
        ? input
        : objectInput?.path ?? objectInput?.folderPath ?? objectInput?.folder_path,
    );
    const pathKey = homeFolderPathKey(folderPath);
    if (!folderPath || !pathKey || seenPaths.has(pathKey)) continue;

    const explicitNickname = trimmedText(
      objectInput?.nickname ?? objectInput?.label ?? objectInput?.name,
    );
    seenPaths.add(pathKey);
    shortcuts.push({
      path: folderPath,
      nickname: explicitNickname || defaultHomeFolderNickname(folderPath),
    });
  }

  return shortcuts;
}

export function normalizeHomeFoldersDocument(value) {
  const folders = Array.isArray(value)
    ? value
    : (value && typeof value === "object" && !Array.isArray(value) ? value.folders : []);
  return {
    version: FILE_EXPLORER_FAVORITES_SCHEMA_VERSION,
    folders: normalizeHomeFolderShortcuts(folders),
  };
}

/**
 * Returns the parent while treating drive, UNC-share, and POSIX roots as hard
 * boundaries. An empty string means the supplied path has no browsable parent.
 */
export function parentFolderPath(pathLike) {
  const source = trimmedText(pathLike);
  if (!source) return "";

  if (/^[\\/]{2}/u.test(source)) {
    const separator = source.startsWith("\\") ? "\\" : "/";
    const segments = pathSegments(source);
    if (segments.length <= 2) return "";
    return `${separator}${separator}${segments.slice(0, -1).join(separator)}`;
  }

  const driveMatch = source.match(/^([A-Za-z]:)(.*)$/u);
  if (driveMatch) {
    const drive = driveMatch[1];
    const remainder = driveMatch[2];
    const absolute = /^[\\/]/u.test(remainder);
    const separator = pathSeparator(remainder, "\\");
    const segments = pathSegments(remainder);
    if (!segments.length) return "";
    if (segments.length === 1) return absolute ? `${drive}${separator}` : drive;
    const joined = segments.slice(0, -1).join(separator);
    return absolute ? `${drive}${separator}${joined}` : `${drive}${joined}`;
  }

  if (source.startsWith("/")) {
    const segments = pathSegments(source);
    if (!segments.length) return "";
    if (segments.length === 1) return "/";
    return `/${segments.slice(0, -1).join("/")}`;
  }

  const separator = pathSeparator(source, "/");
  const segments = pathSegments(source);
  return segments.length > 1 ? segments.slice(0, -1).join(separator) : "";
}

function normalizeSize(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeModifiedTime(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isDirectoryEntry(value) {
  const kind = trimmedText(value?.kind ?? value?.entryType).toLowerCase();
  return value?.isDirectory === true || kind === "directory" || kind === "folder";
}

/**
 * Normalizes an Electron folder-listing entry while allowing older listings
 * that omit file size and modified-time metadata.
 */
export function normalizeHomeFileEntry(value) {
  if (value == null) return null;
  const input = typeof value === "string" ? { path: value } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const filePath = trimmedText(input.path ?? input.fullPath ?? input.filePath);
  const name = trimmedText(input.name) || basenameFromPath(filePath);
  if (!filePath && !name) return null;

  const isDirectory = isDirectoryEntry(input);
  const explicitFile = input.isFile;
  const isFile = !isDirectory && (explicitFile == null ? true : explicitFile === true);
  const size = isDirectory ? null : normalizeSize(input.size ?? input.sizeBytes ?? input.byteSize);
  const mtimeMs = normalizeModifiedTime(
    input.mtimeMs
      ?? input.modifiedMs
      ?? input.modifiedTime
      ?? input.modifiedAt
      ?? input.dateModified
      ?? input.lastModified,
  );

  return {
    name,
    path: filePath || name,
    isDirectory,
    isFile,
    size,
    mtimeMs,
  };
}

export function normalizeHomeFileEntries(value) {
  const inputs = Array.isArray(value) ? value : [value];
  return inputs.map(normalizeHomeFileEntry).filter(Boolean);
}

function extensionFromPath(pathLike) {
  const name = basenameFromPath(pathLike).toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex + 1);
}

export function getHomeFileTypeLabel(entryOrPath) {
  if (entryOrPath && typeof entryOrPath === "object" && isDirectoryEntry(entryOrPath)) {
    return "File folder";
  }
  const pathLike = typeof entryOrPath === "object"
    ? entryOrPath.name || entryOrPath.path
    : entryOrPath;
  const extension = extensionFromPath(pathLike);
  if (!extension) return "File";
  return HOME_FILE_TYPE_LABELS[extension] || `${extension.toUpperCase()} File`;
}

export function formatHomeFileSize(sizeLike) {
  const size = normalizeSize(sizeLike);
  if (size == null) return "";
  if (size < 1024) return `${Math.round(size)} B`;

  let unitIndex = 0;
  let scaledSize = size;
  while (scaledSize >= 1024 && unitIndex < HOME_FILE_SIZE_UNITS.length - 1) {
    scaledSize /= 1024;
    unitIndex += 1;
  }
  const rounded = scaledSize >= 10
    ? Math.round(scaledSize)
    : Math.round(scaledSize * 10) / 10;
  return `${rounded} ${HOME_FILE_SIZE_UNITS[unitIndex]}`;
}

export function formatHomeFileDate(value, locale) {
  const mtimeMs = normalizeModifiedTime(value);
  if (mtimeMs == null) return "";
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(new Date(mtimeMs));
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(mtimeMs));
  }
}

function compareNames(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareOptionalNumbers(left, right) {
  const leftMissing = left == null || !Number.isFinite(left);
  const rightMissing = right == null || !Number.isFinite(right);
  if (leftMissing && rightMissing) return { comparison: 0, missing: true };
  if (leftMissing) return { comparison: 1, missing: true };
  if (rightMissing) return { comparison: -1, missing: true };
  return { comparison: left - right, missing: false };
}

/**
 * Filters by name, path, or type and returns a normalized, stable ordering.
 * Folders remain before files in both ascending and descending directions.
 */
export function filterAndSortHomeFileEntries(value, options = {}) {
  const settings = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const entries = normalizeHomeFileEntries(value);
  const query = trimmedText(settings.query ?? settings.search ?? settings.filter).toLowerCase();
  const requestedSort = trimmedText(settings.sortKey ?? settings.sortBy ?? settings.key).toLowerCase();
  const sortBy = requestedSort === "modified" || requestedSort === "modifiedat" || requestedSort === "mtimems"
    ? "date"
    : (["name", "date", "type", "size"].includes(requestedSort) ? requestedSort : "name");
  const requestedDirection = trimmedText(
    settings.sortDirection ?? settings.direction ?? settings.order,
  ).toLowerCase();
  const direction = requestedDirection === "desc" || requestedDirection === "descending" ? -1 : 1;

  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!query) return true;
      return [entry.name, entry.path, getHomeFileTypeLabel(entry)]
        .some((candidate) => String(candidate || "").toLowerCase().includes(query));
    })
    .sort((leftItem, rightItem) => {
      const left = leftItem.entry;
      const right = rightItem.entry;
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;

      let comparison = 0;
      let missingValueComparison = false;
      if (sortBy === "date") {
        const result = compareOptionalNumbers(left.mtimeMs, right.mtimeMs);
        comparison = result.comparison;
        missingValueComparison = result.missing;
      } else if (sortBy === "size") {
        const result = compareOptionalNumbers(left.size, right.size);
        comparison = result.comparison;
        missingValueComparison = result.missing;
      } else if (sortBy === "type") {
        comparison = compareNames(getHomeFileTypeLabel(left), getHomeFileTypeLabel(right));
      } else {
        comparison = compareNames(left.name, right.name);
      }

      if (comparison) return missingValueComparison ? comparison : comparison * direction;
      const nameComparison = compareNames(left.name, right.name);
      if (nameComparison) return nameComparison * direction;
      return leftItem.index - rightItem.index;
    })
    .map(({ entry }) => entry);
}
