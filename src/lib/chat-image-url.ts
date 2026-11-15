export const CHAT_IMAGE_API_PATH = "/api/chat-image";

const IMAGE_ATTACHMENT_RE = /\[IMAGE_ATTACHMENT:[ \t]*([^\]\n]+)\][ \t]*\r?\n?/g;

/**
 * Resolve the Storage object path for both authenticated API URLs and legacy
 * public Supabase URLs.
 */
export function getChatImageStoragePath(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith("chat-images/")) return raw;

  try {
    const url = new URL(raw, "http://localhost");
    const apiPath = url.searchParams.get("path");
    if (apiPath?.startsWith("chat-images/")) return apiPath;

    const storageMarkers = [
      "/storage/v1/object/public/files/",
      "/storage/v1/object/sign/files/",
      "/object/public/files/",
      "/object/sign/files/",
    ];

    for (const marker of storageMarkers) {
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex !== -1) {
        return decodeURIComponent(
          url.pathname.slice(markerIndex + marker.length)
        );
      }
    }
  } catch {
    return null;
  }

  return null;
}

/** Convert a stored attachment URL into its authenticated proxy URL. */
export function toChatImageApiUrl(value: string): string {
  if (value.startsWith(CHAT_IMAGE_API_PATH)) return value;
  const storagePath = getChatImageStoragePath(value);
  if (!storagePath) return value;
  return `${CHAT_IMAGE_API_PATH}?path=${encodeURIComponent(storagePath)}`;
}

/**
 * Sanitize image markers before returning chat history to the browser. This
 * keeps legacy public Storage URLs server-side while preserving their names.
 */
export function normalizeChatImageAttachmentUrls(content: string): string {
  return content.replace(
    IMAGE_ATTACHMENT_RE,
    (_marker: string, payload: string) => {
      const raw = payload.trim();
      const pipeIndex = raw.indexOf("|");
      const storedUrl = (
        pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw
      ).trim();
      const fileName = pipeIndex >= 0 ? raw.slice(pipeIndex + 1).trim() : "";
      const apiUrl = toChatImageApiUrl(storedUrl);
      const suffix = fileName ? ` | ${fileName}` : "";
      return `[IMAGE_ATTACHMENT: ${apiUrl}${suffix}]`;
    }
  );
}
