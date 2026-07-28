"use client";

interface AIAvatarProps {
  size?: number;
  className?: string;
}

export function AIAvatar({ size = 28, className = "" }: AIAvatarProps) {
  return (
    <div
      className={`shrink-0 flex items-center justify-center rounded-xl ${className}`}
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, var(--color-primary), rgba(139,92,246,.8))",
      }}
    >
      <svg width={size * 0.46} height={size * 0.46} fill="none" viewBox="0 0 24 24">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="white" />
      </svg>
    </div>
  );
}

export function UserAvatar({ size = 28, className = "" }: AIAvatarProps) {
  return (
    <div
      className={`shrink-0 bg-primary/10 border border-primary/20 flex items-center justify-center rounded-xl ${className}`}
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

export function ThinkingDots() {
  return (
    <div className="flex gap-1.5 items-center py-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
    </div>
  );
}

export function StreamingCursor() {
  return <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-middle rounded-sm" />;
}
