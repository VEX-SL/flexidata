"use client";

import {
  File,
  FileText,
  FileImage,
  FileAudio,
  FileVideo,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileJson,
  Presentation,
  type LucideIcon,
} from "lucide-react";

/* ── Extension → category ────────────────────────────────────────────────────
 * Comprehensive lists. Anything not matched falls back to a plain page icon.
 */

const IMAGE_EXT = new Set([
  // common
  "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "png", "apng", "gif", "webp",
  "avif", "svg", "svgz", "bmp", "dib", "tif", "tiff", "ico", "cur", "icns",
  "heic", "heif", "heifs", "heics", "hif", "jxl", "qoi",
  // raw / camera
  "raw", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng", "orf",
  "rw2", "rwl", "raf", "pef", "srw", "3fr", "fff", "iiq", "k25", "kdc", "mef",
  "mos", "mrw", "ptx", "r3d", "rwz", "x3f",
  // other / scientific / vector
  "jp2", "j2k", "jpx", "jpm", "mj2", "j2c", "psd", "psb", "xcf", "exr", "hdr",
  "dds", "tga", "icb", "vda", "vst", "wbmp", "pbm", "pgm", "ppm", "pnm",
  "xbm", "xpm", "fits", "fit", "fts", "jxr", "hdp", "wdp",
]);

const PDF_EXT = new Set(["pdf"]);

const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "mdx", "rmd", "tex", "latex", "log", "nfo",
  "epub", "mobi", "azw", "azw3", "fb2", "djvu", "djv", "chm", "wpd", "wps",
  "abw", "readme", "rtf", "doc", "docx", "dot", "dotx", "odt", "ott", "pages",
]);

const SPREADSHEET_EXT = new Set([
  "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "csv", "tsv", "ods",
  "ots", "numbers", "gnumeric", "sxc",
]);

const PRESENTATION_EXT = new Set([
  "ppt", "pptx", "pps", "ppsx", "pot", "potx", "odp", "otp", "key",
]);

const AUDIO_EXT = new Set([
  "mp3", "wav", "wave", "ogg", "oga", "opus", "flac", "aac", "m4a", "m4b",
  "m4p", "wma", "aiff", "aif", "aifc", "amr", "awb", "mid", "midi", "ac3",
  "eac3", "au", "snd", "ra", "ram", "mka", "wv", "tta", "dsf", "dff", "ape",
  "tak", "spx", "3ga", "caf", "weba",
]);

const VIDEO_EXT = new Set([
  "mp4", "m4v", "webm", "avi", "mov", "qt", "mkv", "mks", "flv", "f4v", "wmv",
  "asf", "mpeg", "mpg", "mpe", "m2v", "mpv", "m2ts", "mts", "ts", "vob",
  "ogv", "3gp", "3g2", "rm", "rmvb", "divx", "xvid", "h264", "h265", "hevc",
  "av1", "mjpeg", "mjpe", "yuv", "dv", "wtv", "mxf", "roq", "nsv", "fli",
  "flc",
]);

const ARCHIVE_EXT = new Set([
  "zip", "zipx", "rar", "r5", "7z", "tar", "gz", "gzip", "tgz", "bz2",
  "bzip2", "xz", "txz", "lz", "lzma", "lzo", "z", "zst", "tzst", "iso", "img",
  "dmg", "cab", "arj", "ace", "jar", "war", "ear", "apk", "ipa", "deb", "rpm",
  "pkg", "msix", "appx", "xar", "cpio", "shar", "lha", "lzh", "sit", "sitx",
]);

const CODE_EXT = new Set([
  // web
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "html", "htm",
  "xhtml", "shtml", "css", "scss", "sass", "less", "styl", "vue", "svelte",
  "astro", "elm",
  // data / config
  "xml", "xsd", "xsl", "xslt", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "config", "properties", "env", "dotenv", "editorconfig", "gitignore",
  "gitattributes", "htaccess",
  // languages
  "py", "pyw", "pyi", "pyx", "ipynb", "java", "c", "h", "cc", "cpp", "cxx",
  "hpp", "hh", "hxx", "cs", "csx", "go", "rs", "rb", "rake", "gemspec", "php",
  "phtml", "swift", "kt", "kts", "gradle", "scala", "sc", "clj", "cljs",
  "cljc", "edn", "ex", "exs", "erl", "hrl", "hs", "lhs", "lua", "pl", "pm",
  "r", "jl", "dart", "zig", "nim", "v", "sv", "vhd", "vhdl", "asm", "s", "f",
  "f90", "f95", "for", "cob", "cbl", "pas", "pp", "lisp", "el", "scm", "ss",
  "rkt", "ml", "mli", "fs", "fsi", "fsx", "vb", "vbs", "bas",
  // shells
  "bat", "cmd", "ps1", "psm1", "sh", "bash", "zsh", "fish", "ksh", "csh",
  "tcsh", "awk", "sed",
  // build / query / schema
  "dockerfile", "makefile", "mk", "cmake", "ninja", "bazel", "bzl", "groovy",
  "gvy", "tcl", "sql", "plsql", "psql", "mysql", "pgsql", "tsql", "graphql",
  "gql", "proto", "thrift", "avsc", "wasm", "wat",
  // templates
  "coffee", "litcoffee", "hbs", "handlebars", "mustache", "ejs", "pug", "jade",
  "haml", "slim", "twig", "liquid", "njk", "jinja", "jinja2", "j2", "erb",
  "razor", "cshtml", "vbhtml", "aspx", "ascx", "jsp", "jspx", "asp", "cfm",
  "cfml", "sml",
]);

const JSON_EXT = new Set(["json", "json5", "jsonc", "jsonl", "ndjson", "geojson", "topojson"]);

export type FileCategory =
  | "image"
  | "pdf"
  | "text"
  | "spreadsheet"
  | "presentation"
  | "audio"
  | "video"
  | "archive"
  | "code"
  | "json"
  | "unknown";

export function getFileExtension(fileName: string): string {
  const clean = (fileName || "").split(/[\\/]/).pop() || "";
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) return "";
  return clean.slice(dot + 1).toLowerCase();
}

export function getFileCategory(fileName: string): FileCategory {
  const lower = (fileName || "").toLowerCase();
  const ext = getFileExtension(lower);

  if (IMAGE_EXT.has(ext)) return "image";
  if (PDF_EXT.has(ext)) return "pdf";
  if (SPREADSHEET_EXT.has(ext)) return "spreadsheet";
  if (PRESENTATION_EXT.has(ext)) return "presentation";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (JSON_EXT.has(ext)) return "json";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";

  // Extension-less special names
  if (lower === "dockerfile" || lower === "makefile" || lower === "readme") return "code";

  return "unknown";
}

const CATEGORY_ICON: Record<FileCategory, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  text: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  code: FileCode,
  json: FileJson,
  unknown: File, // plain page icon
};

const CATEGORY_COLOR: Record<FileCategory, string> = {
  image: "text-emerald-500",
  pdf: "text-red-500",
  text: "text-sky-500",
  spreadsheet: "text-green-600",
  presentation: "text-orange-500",
  audio: "text-violet-500",
  video: "text-pink-500",
  archive: "text-amber-500",
  code: "text-blue-500",
  json: "text-yellow-500",
  unknown: "text-muted-foreground",
};

export interface FileIconProps {
  fileName?: string;
  size?: number;
  className?: string;
  colored?: boolean;
}

/**
 * Modern file-type icon. Chooses an icon from the file extension and falls back
 * to a plain page icon for unknown types.
 */
export function FileTypeIcon({
  fileName = "",
  size = 16,
  className = "",
  colored = true,
}: FileIconProps) {
  const category = getFileCategory(fileName);
  const Icon = CATEGORY_ICON[category] || File;
  const colorClass = colored ? CATEGORY_COLOR[category] : "";

  return (
    <Icon
      size={size}
      strokeWidth={1.8}
      className={`shrink-0 ${colorClass} ${className}`}
      aria-hidden="true"
    />
  );
}

/** All recognized extensions, useful for <input accept="..."> attributes. */
export const SUPPORTED_FILE_EXTENSIONS = Array.from(
  new Set([
    ...IMAGE_EXT,
    ...PDF_EXT,
    ...TEXT_EXT,
    ...SPREADSHEET_EXT,
    ...PRESENTATION_EXT,
    ...AUDIO_EXT,
    ...VIDEO_EXT,
    ...ARCHIVE_EXT,
    ...CODE_EXT,
    ...JSON_EXT,
  ])
);

export const SUPPORTED_FILE_ACCEPT = SUPPORTED_FILE_EXTENSIONS.map(
  (ext) => `.${ext}`
).join(",");
