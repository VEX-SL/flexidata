/**
 * Strip markdown formatting for plain text copy.
 */
export function stripMarkdown(md: string): string {
  let text = md;

  // Remove code blocks (``` ... ```)
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    // Extract just the code content
    const lines = match.split("\n");
    const codeLines = lines.slice(1, -1); // Remove first and last ``` lines
    return codeLines.join("\n");
  });

  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, "$1");

  // Remove images
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Remove links but keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove bold/italic markers
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/___([^_]+)___/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");

  // Remove headings markers
  text = text.replace(/^#{1,6}\s+/gm, "");

  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");

  // Remove blockquote markers
  text = text.replace(/^>\s+/gm, "");

  // Remove unordered list markers
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");

  // Remove ordered list markers
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
