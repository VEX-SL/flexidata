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
  triggerDownload(blob, filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download content as a real binary file for .docx / .pdf targets by
 * converting the markdown/text content server-side. Falls back to a plain
 * text download if conversion fails.
 */
export async function downloadConverted(content: string, filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext !== "docx" && ext !== "pdf") {
    downloadText(content, filename);
    return;
  }

  const operation = ext === "docx" ? "markdown-to-docx" : "markdown-to-pdf";
  try {
    const res = await fetch("/api/files/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, text: content, filename }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "Conversion failed");
    }
    downloadBlob(await res.blob(), filename);
  } catch (err) {
    console.error("[DownloadConvert] failed, falling back to text:", err);
    downloadText(content, filename);
  }
}

export function getLangExtension(lang: string): string {
  return EXTENSION_MAP[lang.toLowerCase()] || lang || "txt";
}

export function getFilenameForDownload(code: string, lang: string): string {
  const ext = getLangExtension(lang);
  return `code.${ext}`;
}
