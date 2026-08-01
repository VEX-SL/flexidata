"use client";

import { useState, useRef } from "react";
import {
  FileText,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  Download,
  Copy,
  Pencil,
  Eye,
  EyeOff,
  Undo2,
  RotateCcw,
} from "lucide-react";
import { downloadConverted } from "@/lib/download";
import { MarkdownRenderer } from "@/components/markdown-renderer";

export interface FileEdit {
  id: string;
  filename: string;
  original: string;
  replacement: string;
  isNew?: boolean;
}

interface FileEditCardProps {
  edit: FileEdit;
  agentId: string;
  onApply: (editId: string) => void;
  onReject: (editId: string) => void;
  onEdit?: (editId: string, newCode: string) => void;
  applying?: boolean;
  applied?: boolean;
}

export function FileEditCard({
  edit,
  agentId,
  onApply,
  onReject,
  onEdit,
  applying,
  applied: initialApplied,
}: FileEditCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [showDiff, setShowDiff] = useState(true);
  const [applied, setApplied] = useState(initialApplied || false);
  const [rejected, setRejected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editCode, setEditCode] = useState(edit.replacement);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleApply() {
    setApplied(true);
    onApply(edit.id);
  }

  function handleReject() {
    setRejected(true);
    onReject(edit.id);
  }

  function handleDownload() {
    downloadConverted(edit.replacement, edit.filename);
  }

  function handleCopy() {
    navigator.clipboard.writeText(edit.replacement);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSaveEdit() {
    if (onEdit) onEdit(edit.id, editCode);
    setEditing(false);
  }

  function handleRevertEdit() {
    setEditCode(edit.replacement);
    setEditing(false);
  }

  if (applied) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-500 text-sm">
            <Check size={16} />
            <span className="font-medium">Applied to {edit.filename}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-green-500 hover:bg-green-500/10 transition-colors"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-green-500 hover:bg-green-500/10 transition-colors"
            >
              <Download size={12} />
              Download
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (rejected) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 opacity-60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <X size={16} />
            <span>Rejected — {edit.filename}</span>
          </div>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent transition-colors"
          >
            <Download size={12} />
            Download
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-accent/30 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={16} className="text-primary shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {edit.filename}
          </span>
          {edit.original.trim() && (
            <span className="text-xs text-muted-foreground shrink-0 px-1.5 py-0.5 rounded bg-muted">
              diff
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setShowDiff(!showDiff)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title={showDiff ? "Hide diff" : "Show diff"}
          >
            {showDiff ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Content */}
      {expanded && (
        <div className="p-4 space-y-3">
          {showDiff && edit.original.trim() && (
            <div>
              <div className="text-xs font-medium text-red-500/80 mb-1.5 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
                Original
              </div>
              <pre className="text-xs bg-red-500/5 border border-red-500/15 rounded-lg p-3 overflow-x-auto text-foreground/80 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed">
                {edit.original}
              </pre>
            </div>
          )}

          {editing ? (
            <div>
              <div className="text-xs font-medium text-blue-500/80 mb-1.5 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
                Editing
              </div>
              <textarea
                ref={textareaRef}
                value={editCode}
                onChange={(e) => setEditCode(e.target.value)}
                className="w-full text-xs bg-blue-500/5 border border-blue-500/15 rounded-lg p-3 overflow-x-auto text-foreground whitespace-pre-wrap font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-blue-500/30 min-h-[200px]"
                spellCheck={false}
              />
            </div>
          ) : (
            <div>
              <div className="text-xs font-medium text-green-500/80 mb-1.5 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                {edit.original.trim() ? "Updated" : "New file"}
              </div>
              <pre className="text-xs bg-green-500/5 border border-green-500/15 rounded-lg p-3 overflow-x-auto text-foreground/80 whitespace-pre-wrap max-h-96 overflow-y-auto font-mono leading-relaxed">
                {editCode}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-card">
        <button
          onClick={handleApply}
          disabled={applying || editing}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 text-white text-xs font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm"
        >
          {applying ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} strokeWidth={2.5} />
          )}
          Apply
        </button>
        <button
          onClick={handleReject}
          disabled={applying}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 disabled:opacity-50 transition-colors"
        >
          <X size={13} strokeWidth={2.5} />
          Reject
        </button>

        <div className="flex-1" />

        {editing ? (
          <>
            <button
              onClick={handleSaveEdit}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-colors shadow-sm"
            >
              <Check size={13} />
              Save
            </button>
            <button
              onClick={handleRevertEdit}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent transition-colors"
            >
              <Undo2 size={13} />
              Revert
            </button>
          </>
        ) : (
          <>
            {onEdit && (
              <button
                onClick={() => setEditing(true)}
                disabled={applying}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                title="Edit code manually"
              >
                <Pencil size={13} />
                Edit
              </button>
            )}
            <button
              onClick={handleCopy}
              disabled={applying}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {copied ? (
                <Check size={13} className="text-green-500" />
              ) : (
                <Copy size={13} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              disabled={applying}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              <Download size={13} />
              Download
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Parsing ────────────────────────────────────────────────────────── */

interface NewFileCardProps {
  edit: FileEdit;
  agentId: string;
  onApply: (editId: string) => void;
  onReject: (editId: string) => void;
  onEdit?: (editId: string, newCode: string) => void;
  applying?: boolean;
  applied?: boolean;
}

export function NewFileCard({
  edit,
  agentId,
  onApply,
  onReject,
  onEdit,
  applying,
  applied: initialApplied,
}: NewFileCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [applied, setApplied] = useState(initialApplied || false);
  const [rejected, setRejected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editCode, setEditCode] = useState(edit.replacement);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleApply() {
    setApplied(true);
    onApply(edit.id);
  }

  function handleReject() {
    setRejected(true);
    onReject(edit.id);
  }

  function handleDownload() {
    downloadConverted(edit.replacement, edit.filename);
  }

  function handleCopy() {
    navigator.clipboard.writeText(edit.replacement);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSaveEdit() {
    if (onEdit) onEdit(edit.id, editCode);
    setEditing(false);
  }

  function handleRevertEdit() {
    setEditCode(edit.replacement);
    setEditing(false);
  }

  if (applied) {
    return (
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-blue-500 text-sm">
            <Check size={16} />
            <span className="font-medium">Created {edit.filename}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-blue-500 hover:bg-blue-500/10 transition-colors"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-blue-500 hover:bg-blue-500/10 transition-colors"
            >
              <Download size={12} />
              Download
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (rejected) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 opacity-60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <X size={16} />
            <span>Rejected — {edit.filename}</span>
          </div>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent transition-colors"
          >
            <Download size={12} />
            Download
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-blue-500/25 bg-card overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-blue-500/5 border-b border-blue-500/15">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={16} className="text-blue-500 shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {edit.filename}
          </span>
          <span className="text-xs text-blue-500 shrink-0 px-1.5 py-0.5 rounded bg-blue-500/10 font-medium">
            new file
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Content */}
      {expanded && (
        <div className="p-4 space-y-3">
          {editing ? (
            <div>
              <div className="text-xs font-medium text-blue-500/80 mb-1.5 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
                Editing
              </div>
              <textarea
                ref={textareaRef}
                value={editCode}
                onChange={(e) => setEditCode(e.target.value)}
                className="w-full text-xs bg-blue-500/5 border border-blue-500/15 rounded-lg p-3 overflow-x-auto text-foreground whitespace-pre-wrap font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-blue-500/30 min-h-[200px]"
                spellCheck={false}
              />
            </div>
          ) : (
            <div>
              <div className="text-xs font-medium text-blue-500/80 mb-1.5 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
                New file content
              </div>
              <pre className="text-xs bg-blue-500/5 border border-blue-500/15 rounded-lg p-3 overflow-x-auto text-foreground/80 whitespace-pre-wrap max-h-96 overflow-y-auto font-mono leading-relaxed">
                {editCode}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-card">
        <button
          onClick={handleApply}
          disabled={applying || editing}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
        >
          {applying ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} strokeWidth={2.5} />
          )}
          Create
        </button>
        <button
          onClick={handleReject}
          disabled={applying}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 disabled:opacity-50 transition-colors"
        >
          <X size={13} strokeWidth={2.5} />
          Reject
        </button>

        <div className="flex-1" />

        {editing ? (
          <>
            <button
              onClick={handleSaveEdit}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-colors shadow-sm"
            >
              <Check size={13} />
              Save
            </button>
            <button
              onClick={handleRevertEdit}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent transition-colors"
            >
              <Undo2 size={13} />
              Revert
            </button>
          </>
        ) : (
          <>
            {onEdit && (
              <button
                onClick={() => setEditing(true)}
                disabled={applying}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                title="Edit code manually"
              >
                <Pencil size={13} />
                Edit
              </button>
            )}
            <button
              onClick={handleCopy}
              disabled={applying}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {copied ? (
                <Check size={13} className="text-green-500" />
              ) : (
                <Copy size={13} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              disabled={applying}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              <Download size={13} />
              Download
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Parsing ────────────────────────────────────────────────────────── */

export function parseFileEdits(content: string): FileEdit[] {
  const edits: FileEdit[] = [];

  // Check for NEW_FILE blocks first
  const newFileEdits = parseNewFileFormat(content);
  if (newFileEdits.length > 0) edits.push(...newFileEdits);

  // Strategy 1: Standard format with <<<<<<< ORIGINAL / ======= / >>>>>>> END
  const standardEdits = parseStandardFormat(content);
  edits.push(...standardEdits);

  // Strategy 2: Code-fenced blocks
  const fencedEdits = parseFencedFormat(content);
  edits.push(...fencedEdits);

  // Strategy 3: Malformed — [FILE_EDIT: filename] followed by code
  if (edits.length === 0) {
    const malformedEdits = parseMalformedFormat(content);
    edits.push(...malformedEdits);
  }

  return edits;
}

/**
 * Strip directory prefixes from filenames.
 * "services/cacheService.mjs" → "cacheService.mjs"
 * "src/utils/helper.ts" → "helper.ts"
 */
function normalizeFilename(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1].trim();
}

function parseNewFileFormat(content: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const regex = /\[NEW_FILE:\s*(.+?)\]\s*\n([\s\S]*?)(?=\n\[NEW_FILE:|\n\[FILE_EDIT:|\n```|\nTip:|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const filename = normalizeFilename(match[1]);
    let fileContent = match[2].trim();

    if (!filename || !fileContent) continue;

    if (isDocumentFile(filename)) {
      fileContent = cleanDocumentContent(fileContent);
      if (!fileContent.trim()) continue;
    }

    edits.push({
      id: `edit-${Date.now()}-${edits.length}`,
      filename,
      original: "",
      replacement: normalizeCodeNewlines(fileContent),
      isNew: true,
    });
  }

  return edits;
}

const DOCUMENT_EXTENSIONS = ["docx", "pdf", "md", "txt", "rtf"];

function isDocumentFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return DOCUMENT_EXTENSIONS.includes(ext);
}

/**
 * Strip trailing meta/completion lines (e.g. "تم إنشاء الملف بنجاح",
 * "Created ...", "Done!") and trailing decorative dividers (---, ===, ***)
 * from extracted document content. The model sometimes writes its chat
 * confirmation message as the last line of the file.
 */
function cleanDocumentContent(content: string): string {
  const lines = content.split("\n");
  const META_RE =
    /^(\*{1,2})?\s*(تم\s+إنشاء|تم\s+توليد|تم\s+حفظ|تم\s+رفع|Created|Generated|Saved|Done!?|Finished|Complete[d]?|Here\s+(is|are)\s+(your|the))[\s\S]*$/i;
  const DIVIDER_RE = /^\s*(?:[-*=_])\s*(?:[-*=_])\s*(?:[-*=_])\s*$/;

  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (!line) {
      end--;
      continue;
    }
    if (DIVIDER_RE.test(line) || META_RE.test(line)) {
      end--;
      continue;
    }
    break;
  }

  return lines.slice(0, end).join("\n").trim();
}

function parseStandardFormat(content: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const regex = /\[FILE_EDIT:\s*(.+?)\]\s*\n?\s*<<<<<<<\s*ORIGINAL\s*\n/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const filename = normalizeFilename(match[1]);
    const afterOriginal = content.slice(match.index + match[0].length);

    // Find ======= (not preceded by <<<<<<<)
    const eqMatch = afterOriginal.match(/\n?\s*=======\s*\n/);
    if (!eqMatch || eqMatch.index === undefined) continue;

    const original = afterOriginal.slice(0, eqMatch.index).trim();
    const afterEq = afterOriginal.slice(eqMatch.index + eqMatch[0].length);

    // Find >>>>>>> END
    const endMatch = afterEq.match(/\n?\s*>>>>>>>+\s*END/);
    if (!endMatch || endMatch.index === undefined) continue;

    let replacement = afterEq.slice(0, endMatch.index).trim();

    // Handle case where ======= appears inside replacement
    const innerEq = replacement.match(/={5,}/);
    if (innerEq && innerEq.index !== undefined) {
      replacement = replacement.slice(innerEq.index + innerEq[0].length).trim();
    }

    if (replacement) {
      edits.push({
        id: `edit-${Date.now()}-${edits.length}`,
        filename,
        original,
        replacement: normalizeCodeNewlines(replacement),
      });
    }
  }

  return edits;
}

function parseFencedFormat(content: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const fenced =
    /```[\w]*\n(\[FILE_EDIT:[\s\S]*?<<<<<<<\s*ORIGINAL[\s\S]*?>>>>>>>?\s*END)\n```/g;
  let match;

  while ((match = fenced.exec(content)) !== null) {
    const innerEdits = parseStandardFormat(match[1]);
    edits.push(...innerEdits);
  }

  return edits;
}

function parseMalformedFormat(content: string): FileEdit[] {
  const edits: FileEdit[] = [];
  // Match [FILE_EDIT: filename] followed by some content (no standard markers)
  const regex = /\[FILE_EDIT:\s*(.+?)\]\s*\n([\s\S]*?)(?=\n\n\[FILE_EDIT:|\n\nTip:|\n\n\*\*|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const filename = normalizeFilename(match[1].replace(/[:\]].*$/, ""));
    const rawContent = match[2].trim();

    if (!filename || !rawContent) continue;

    // Try to separate old/new if ======= exists
    const parts = rawContent.split(/={5,}/);
    if (parts.length >= 2) {
      edits.push({
        id: `edit-${Date.now()}-${edits.length}`,
        filename,
        original: parts[0].trim(),
        replacement: normalizeCodeNewlines(parts.slice(1).join("\n").trim()),
      });
    } else {
      // Treat entire content as the replacement (new file or update)
      edits.push({
        id: `edit-${Date.now()}-${edits.length}`,
        filename,
        original: "",
        replacement: normalizeCodeNewlines(rawContent),
      });
    }
  }

  return edits;
}

function normalizeCodeNewlines(code: string): string {
  if (code.includes("\n")) return code;

  let result = code;
  result = result.replace(/(: {4,})/g, ":\n");
  result = result.replace(
    /\s{4,}(def |class |while |if |for |try:|except |return |else:|elif |import |from )/g,
    "\n$1"
  );
  result = result.replace(/(def \w+\([^)]*\):)/g, "\n$1");
  result = result.replace(/(class \w+[^:]*:)/g, "\n$1");
  result = result.replace(/(\))(\s*def )/g, "$1\n\n$2");
  result = result.replace(/(\))(\s*class )/g, "$1\n\n$2");
  result = result.replace(
    /(:\s+)(while |if |for |try:|except|return |else:|elif )/g,
    ":\n$2"
  );
  result = result.replace(/;\s*/g, ";\n");
  result = result.replace(/\)\{/g, ") {\n");

  const lines = result.split("\n").filter((l) => l.trim());
  const result2: string[] = [];
  const indentStack: number[] = [0];
  let currentIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const isElse =
      trimmed === "else:" ||
      trimmed.startsWith("else:") ||
      trimmed === "except:" ||
      trimmed.startsWith("except ") ||
      trimmed.startsWith("elif ");
    if (
      trimmed.startsWith("def ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("if __name__")
    ) {
      currentIndent = 0;
      indentStack.length = 1;
    } else if (isElse) {
      while (indentStack.length > 1) indentStack.pop();
      currentIndent = indentStack[indentStack.length - 1];
    }
    result2.push(" ".repeat(currentIndent) + trimmed);
    if (trimmed.endsWith(":") && !isElse) {
      indentStack.push(currentIndent);
      currentIndent += 4;
    }
  }

  return result2.join("\n").trim();
}

export function stripFileEdits(content: string): string {
  let result = content;
  // Strip NEW_FILE blocks
  result = result.replace(
    /\[NEW_FILE:\s*.+?\]\s*\n[\s\S]*?(?=\n\[NEW_FILE:|\n\[FILE_EDIT:|\n```|\nTip:|$)/g,
    ""
  );
  // Strip code-fenced FILE_EDIT blocks
  result = result.replace(
    /```[\w]*\n(\[FILE_EDIT:[\s\S]*?>>>>>>>?\s*END)\n```/g,
    ""
  );
  // Strip standard FILE_EDIT blocks
  result = result.replace(
    /\[FILE_EDIT:\s*.+?\]\s*\n?\s*<<<<<<<\s*ORIGINAL\s*\n?[\s\S]*?\n?\s*(?:=======\s*\n?[\s\S]*?\n?)?>>>>>>>?\s*END/g,
    ""
  );
  // Strip malformed FILE_EDIT blocks (up to next Tip or double newline)
  result = result.replace(
    /\[FILE_EDIT:\s*.+?\]\s*\n[\s\S]*?(?=\n\n(?:Tip:|\*\*|Send me|Apply the)|$)/g,
    ""
  );
  // Strip "Tip: To apply this edit..." lines
  result = result.replace(
    /\n?\n?Tip: To apply this edit.*?(?:\n|$)/gi,
    ""
  );
  return result.trim();
}

export function hasEditIntent(content: string, documents: string[]): boolean {
  const lower = content.toLowerCase();
  const editKeywords = [
    "edit", "modify", "update", "change", "fix", "improve", "rewrite",
    "add", "delete", "remove", "refactor",
    "عدّل", "غير", "حذف", "أضف", "حسّن", "عدّل", "ارسل", "أرسل",
    "الملف", "اضف", "احذف", "تحسين", "تعديل",
  ];
  const mentionsFile = documents.some((d) => lower.includes(d.toLowerCase()));
  return mentionsFile && editKeywords.some((k) => lower.includes(k));
}
