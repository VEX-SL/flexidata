"use client";

import { useState, useRef, useEffect } from "react";
import { Bot, Sparkles, Zap, Crown, Heart, Star, Feather, Brain } from "lucide-react";
import { ModelIconPicker } from "./model-icon-picker";

interface AIAvatarProps {
  size?: number;
  className?: string;
  modelIcon?: string | null;
  modelIconType?: "preset" | "custom" | null;
  onModelIconChange?: (icon: string | File | null, type: "preset" | "custom") => void;
}

interface UserAvatarProps {
  size?: number;
  className?: string;
  src?: string | null;
  alt?: string;
  onClick?: () => void;
}

function getPresetIcon(iconId: string) {
  if (iconId === "feather") {
    // إرجاع الأجنحة المخصصة بناءً على طلبك
    return ({ size = 24, className = "" }: { size?: number; className?: string }) => (
      <svg width={size} height={size} viewBox="0 0 512 512" fill="currentColor" className={className}>
        <path d="M256 448c-32-64-96-128-160-160-48-24-96-48-96-96 0-64 48-128 128-128 32 0 64 16 96 48 32-32 64-48 96-48 80 0 128 64 128 128 0 48-48 72-96 96-64 32-128 96-160 160z" opacity="0.1" />
        <path d="M458.2 165c-28.5-14.2-65.7-32.5-108.2-57-31.2-18.1-66.2-39.2-94-63.9-27.8 24.7-62.8 45.8-94 63.9-42.5 24.5-79.7 42.8-108.2 57C23.6 182.2 6.6 199.3 6.6 226c0 53.6 42.2 98.4 99.4 127.3 54.5 27.2 120 62.5 150 112.7 30-50.2 95.5-85.5 150-112.7 57.2-28.9 99.4-73.7 99.4-127.3 0-26.7-17-43.8-47.2-61z" stroke="currentColor" strokeWidth="24" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }

  const icons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    sparkles: Sparkles,
    zap: Zap,
    crown: Crown,
    heart: Heart,
    star: Star,
    brain: Brain,
  };
  return icons[iconId] || Bot;
}

export function AIAvatar({
  size = 28,
  className = "",
  modelIcon,
  modelIconType,
  onModelIconChange,
}: AIAvatarProps) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setShowPicker(false);
      }
    }
    if (showPicker) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPicker]);

  const PresetIcon = modelIcon && modelIconType === "preset" ? getPresetIcon(modelIcon) : null;

  return (
    <div className="relative" ref={pickerRef}>
      <button
        onClick={() => setShowPicker(!showPicker)}
        className={`shrink-0 flex items-center justify-center rounded-[14px] overflow-hidden transition-all ${className}`}
        style={{ width: size, height: size }}
        aria-label="Change model icon"
      >
        {modelIcon && modelIconType === "custom" ? (
          <img
            src={modelIcon}
            alt="Model icon"
            className="w-full h-full object-cover"
          />
        ) : modelIcon && modelIconType === "preset" && PresetIcon ? (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              background: "linear-gradient(135deg, var(--color-primary), rgba(80,80,80,.8))",
            }}
          >
            <PresetIcon size={size * 0.55} className="text-white" />
          </div>
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              background: "linear-gradient(135deg, var(--color-primary), rgba(80,80,80,.8))",
            }}
          >
            <Bot size={size * 0.55} className="text-white" />
          </div>
        )}
      </button>

      {showPicker && onModelIconChange && (
        <ModelIconPicker
          isOpen={true}
          onClose={() => setShowPicker(false)}
          onSelect={(icon, type) => {
            onModelIconChange(icon, type);
            setShowPicker(false);
          }}
          currentIcon={modelIcon}
          currentIconType={modelIconType}
        />
      )}
    </div>
  );
}

export function UserAvatar({
  size = 28,
  className = "",
  src,
  alt = "Profile",
  onClick,
}: UserAvatarProps) {
  const content = src && src.trim() !== "" ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className={`shrink-0 rounded-[14px] object-cover border border-border ${className}`}
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className={`shrink-0 bg-primary/15 border border-primary/25 flex items-center justify-center rounded-[14px] ${className}`}
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="relative cursor-pointer focus:outline-none"
        aria-label="Go to settings"
      >
        {content}
      </button>
    );
  }

  return content;
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

export function StreamingContextMarker() {
  return null;
}

export function StreamingCursor() {
  return <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-middle rounded-sm" />;
}