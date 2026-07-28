const MAX_MESSAGE_LENGTH = 10_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/aac",
  "audio/m4a",
  "audio/x-m4a",
  // Code files
  "text/html",
  "text/css",
  "text/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-java",
  "text/x-c",
  "text/x-c++",
  "text/x-csharp",
  "text/x-go",
  "text/x-rust",
  "text/x-ruby",
  "text/x-php",
  "text/x-shellscript",
  "text/x-sql",
  "text/x-yaml",
  "text/yaml",
  "text/xml",
  "application/javascript",
  "application/typescript",
  "application/x-python",
  "application/java",
  "application/x-c",
  "application/x-c++",
  "application/x-csharp",
  "application/x-go",
  "application/x-rust",
  "application/x-ruby",
  "application/php",
  "application/x-shellscript",
  "application/sql",
  "application/xml",
  "application/yaml",
]);

export function validateMessage(content: unknown): {
  valid: boolean;
  error?: string;
  value?: string;
} {
  if (typeof content !== "string") {
    return { valid: false, error: "Message must be a string" };
  }
  if (content.trim().length === 0) {
    return { valid: false, error: "Message cannot be empty" };
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    return {
      valid: false,
      error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`,
    };
  }
  return { valid: true, value: content.trim() };
}

export function isValidUUID(id: unknown): id is string {
  if (typeof id !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id
  );
}

export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType.toLowerCase().split(";")[0].trim());
}

export function isAllowedFileSize(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE;
}

export function isValidEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return (
    /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email) &&
    email.length <= 320
  );
}

export function isValidPassword(password: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof password !== "string")
    return { valid: false, error: "Password must be a string" };
  if (password.length < 8)
    return { valid: false, error: "Password must be at least 8 characters" };
  if (password.length > 128)
    return { valid: false, error: "Password too long" };
  return { valid: true };
}
