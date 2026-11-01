"use client";

import { useState, useRef, useEffect } from "react";
import { Bot, Sparkles, Zap, Crown, Heart, Star, Brain } from "lucide-react";
import { ModelIconPicker } from "./model-icon-picker";
import { WingsIcon } from "@/components/icons/WingsIcon";

interface AIAvatarProps {
  size?: number;
  className?: string;
  modelIcon?: string | null;
  modelIconType?: "preset" | "custom" | null;
  modelColor?: string | null;
  modelShape?: string | null;
  onModelIconChange?: (icon: string | File | null, type: "preset" | "custom", color?: string, shape?: string) => void;
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
    return WingsIcon;
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
  modelColor,
  modelShape,
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

  // فرض الشكل الافتراضي Soft Square (rounded-[14px]) بدقة
  const finalShape = modelShape === "circle" ? "rounded-full" : modelShape === "square" ? "rounded-none" : "rounded-[14px]";

  const colorStyle = modelColor ? { background: undefined } : { background: "linear-gradient(135deg, var(--color-primary), rgba(80,80,80,.8))" };
  const colorClass = modelColor ? `bg-gradient-to-br ${modelColor}` : "";

  return (
    <div className="relative" ref={pickerRef}>
      <button
        onClick={() => setShowPicker(!showPicker)}
        className={`shrink-0 flex items-center justify-center overflow-hidden transition-all ${finalShape} ${colorClass} ${className}`}
        style={{ width: size, height: size, ...colorStyle }}
        aria-label="Change model icon"
      >
        {modelIcon && modelIconType === "custom" ? (
          <img src={modelIcon} alt="Model icon" className="w-full h-full object-cover" />
        ) : modelIcon && modelIconType === "preset" && PresetIcon ? (
          <div className="w-full h-full flex items-center justify-center text-white">
            <PresetIcon size={size * 0.55} className="text-white" />
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white">
            <Bot size={size * 0.55} className="text-white" />
          </div>
        )}
      </button>

      {showPicker && onModelIconChange && (
        <ModelIconPicker
          isOpen={true}
          onClose={() => setShowPicker(false)}
          onSelect={(icon, type, color, shape) => {
            onModelIconChange(icon, type, color, shape);
            setShowPicker(false);
          }}
          currentIcon={modelIcon}
          currentIconType={modelIconType}
          currentColor={modelColor}
          currentShape={modelShape}
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