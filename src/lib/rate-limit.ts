interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.resetAt < now) store.delete(key);
    }
  }, 60_000);
}

const PRESETS = {
  chat: { limit: 30, windowSeconds: 60 },
  upload: { limit: 10, windowSeconds: 60 },
  pipeline: { limit: 20, windowSeconds: 60 },
  auth: { limit: 10, windowSeconds: 15 * 60 },
} as const;

export type RateLimitPreset = keyof typeof PRESETS;

export function checkRateLimit(
  identifier: string,
  preset: RateLimitPreset
): { allowed: boolean; remaining: number; resetAt: number } {
  const config = PRESETS[preset];
  const key = `${preset}:${identifier}`;
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;

  const entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: config.limit - 1,
      resetAt: now + windowMs,
    };
  }

  if (entry.count >= config.limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: config.limit - entry.count,
    resetAt: entry.resetAt,
  };
}

export function getClientIdentifier(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}
