const EXTENSION_MAP: Record<string, string> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  java: "java",
  "c": "c",
  cpp: "cpp",
  cs: "cs",
  go: "go",
  rust: "rs",
  rb: "rb",
  php: "php",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  markdown: "md",
  md: "md",
  plaintext: "txt",
  text: "txt",
};

export function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function getLangExtension(lang: string): string {
  return EXTENSION_MAP[lang.toLowerCase()] || lang || "txt";
}

export function getFilenameForDownload(code: string, lang: string): string {
  const ext = getLangExtension(lang);
  return `code.${ext}`;
}
