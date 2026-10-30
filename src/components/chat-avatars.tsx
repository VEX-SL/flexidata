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
  const icons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    sparkles: Sparkles,
    zap: Zap,
    crown: Crown,
    heart: Heart,
    star: Star,
    feather: Feather,
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
            <PresetIcon size={size * 0.5} className="text-white" />
          </div>
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              background: "linear-gradient(135deg, var(--color-primary), rgba(80,80,80,.8))",
            }}
          >
            <Bot size={size * 0.5} className="text-white" />
          </div>
        )}
      </button>

      {showPicker && onModelIconChange && (
        <ModelIconPicker
          isOpen={true}
          onClose={() => setShowPicker(false)}
          onSelect={(icon, type) => {
            onModelIconChange(icon, type);
            setShowPicker(false); // إغلاق النافذة فوراً عند الاختيار
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
  const content = src ? (
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
      className={`shrink-0 bg-primary/15 border border-primary/20 flex items-center justify-center rounded-[14px] ${className}`}
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
        className="relative group cursor-pointer"
        aria-label="Go to settings"
      >
        {content}
        <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" />
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

export function StreamingCursor() {
  return <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-middle rounded-sm" />;
}