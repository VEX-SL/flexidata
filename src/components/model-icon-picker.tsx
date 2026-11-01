"use client";

import { useState, useRef, useEffect } from "react";
import { X, Upload, Sparkles, Zap, Crown, Heart, Star, Bot, Brain } from "lucide-react";
import { WingsIcon } from "@/components/icons/WingsIcon";

interface ModelIconPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (icon: string | File | null, type: "preset" | "custom", color?: string, shape?: string) => void;
  currentIcon?: string | null;
  currentIconType?: "preset" | "custom" | null;
  currentColor?: string | null;
  currentShape?: string | null;
}

const PRESET_ICONS = [
  { id: "sparkles", icon: Sparkles, label: "Sparkles" },
  { id: "zap", icon: Zap, label: "Lightning" },
  { id: "crown", icon: Crown, label: "Crown" },
  { id: "heart", icon: Heart, label: "Heart" },
  { id: "star", icon: Star, label: "Star" },
  { id: "feather", icon: WingsIcon, label: "Wings" },
  { id: "bot", icon: Bot, label: "Bot" },
  { id: "brain", icon: Brain, label: "Brain" },
];

const COLORS = [
  { label: "Default", value: "" },
  { label: "Blue", value: "from-blue-600 to-indigo-600" },
  { label: "Purple", value: "from-purple-600 to-pink-600" },
  { label: "Emerald", value: "from-emerald-600 to-teal-600" },
  { label: "Amber", value: "from-amber-600 to-orange-600" },
  { label: "Rose", value: "from-rose-600 to-red-600" },
];

const SHAPES = [
  { id: "rounded", label: "Soft Square", class: "rounded-[14px]" },
  { id: "circle", label: "Circle", class: "rounded-full" },
  { id: "square", label: "Square", class: "rounded-none" },
];

export function ModelIconPicker({
  isOpen,
  onClose,
  onSelect,
  currentIcon,
  currentIconType,
  currentColor,
  currentShape,
}: ModelIconPickerProps) {
  const [selectedColor, setSelectedColor] = useState(currentColor || "");
  const [selectedShape, setSelectedShape] = useState(currentShape || "rounded");
  const [customImage, setCustomImage] = useState<string | null>(null);
  const [customFile, setCustomFile] = useState<File | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md bg-card border border-border rounded-2xl p-6 shadow-xl animate-slide-up max-h-[90vh] overflow-y-auto fd-scroll"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Customize AI Avatar</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Shape Selection */}
        {/* Shape Selection */}
        <div className="space-y-3 mb-5">
          <p className="text-sm font-medium text-muted-foreground">Avatar Shape</p>
          <div className="grid grid-cols-3 gap-2">
            {SHAPES.map((shape) => (
              <button
                key={shape.id}
                type="button"
                onClick={() => {
                  setSelectedShape(shape.id);
                  onSelect(currentIcon || "bot", currentIconType || "preset", selectedColor, shape.id);
                }}
                className={`py-2 px-3 text-xs font-medium border rounded-xl transition-all ${selectedShape === shape.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
              >
                {shape.label}
              </button>
            ))}
          </div>
        </div>

        {/* Color Selection */}
        <div className="space-y-3 mb-5">
          <p className="text-sm font-medium text-muted-foreground">Gradient Color</p>
          <div className="flex gap-2 flex-wrap">
            {COLORS.map((col, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setSelectedColor(col.value);
                  onSelect(currentIcon || "bot", currentIconType || "preset", col.value, selectedShape);
                }}
                className={`w-8 h-8 rounded-full border-2 transition-all bg-gradient-to-br ${col.value || "from-primary to-primary/80"
                  } ${selectedColor === col.value ? "ring-2 ring-primary ring-offset-2 border-white" : "border-transparent"}`}
                title={col.label}
              />
            ))}
          </div>
        </div>

        {/* Color Selection */}
        <div className="space-y-3 mb-5">
          <p className="text-sm font-medium text-muted-foreground">Gradient Color</p>
          <div className="flex gap-2 flex-wrap">
            {COLORS.map((col, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setSelectedColor(col.value)}
                className={`w-8 h-8 rounded-full border-2 transition-all bg-gradient-to-br ${col.value || "from-primary to-primary/80"
                  } ${selectedColor === col.value ? "ring-2 ring-primary ring-offset-2 border-white" : "border-transparent"}`}
                title={col.label}
              />
            ))}
          </div>
        </div>

        {/* Preset Icons */}
        <div className="space-y-3 mb-5">
          <p className="text-sm font-medium text-muted-foreground">Preset Icons</p>
          <div className="grid grid-cols-4 gap-2">
            {PRESET_ICONS.map(({ id, icon: Icon, label }) => {
              const isSelected = currentIcon === id && currentIconType === "preset";
              return (
                <button
                  key={id}
                  onClick={() => {
                    onSelect(id, "preset", selectedColor, selectedShape);
                    onClose();
                  }}
                  className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 ${isSelected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:bg-accent hover:text-foreground"
                    }`}
                >
                  <Icon size={22} className="text-current" />
                  <span className="text-[11px] text-center">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Upload */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">Custom Icon</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                onSelect(file, "custom", selectedColor, selectedShape);
                onClose();
              }
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full border-2 border-dashed border-border rounded-xl p-4 text-center hover:border-primary/50 flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Upload size={18} />
            <span className="text-sm font-medium">Upload Custom Icon</span>
          </button>
        </div>
      </div>
    </div>
  );
}