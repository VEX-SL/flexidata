"use client";

import { useState, useRef, useEffect } from "react";
import { X, Upload, Sparkles, Zap, Crown, Heart, Star, Bot, Brain, Pen } from "lucide-react";
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
  { label: "White", value: "bg-white text-zinc-900 border border-border" },
  { label: "Gray", value: "bg-zinc-500 text-white" },
  { label: "Blue", value: "bg-blue-600 text-white" },
  { label: "Pink", value: "bg-pink-500 text-white" },
  { label: "Emerald", value: "bg-emerald-600 text-white" },
  { label: "Orange", value: "bg-orange-500 text-white" },
  { label: "Red", value: "bg-rose-600 text-white" },
];

const SHAPES = [
  { id: "rounded", label: "Soft Square", class: "rounded-[25%]" },
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
  const defaultColor = "bg-white text-zinc-900 border border-border";
  const [selectedColor, setSelectedColor] = useState(currentColor || defaultColor);
  const [selectedShape, setSelectedShape] = useState(currentShape || "rounded");
  
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

  const isCustomHex = selectedColor.startsWith("#") || (selectedColor && !COLORS.some(c => c.value === selectedColor));

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
                className={`py-2 px-3 text-xs font-medium border rounded-xl transition-all ${
                  selectedShape === shape.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {shape.label}
              </button>
            ))}
          </div>
        </div>

        {/* Solid Color Selection & Pen Custom Picker */}
        <div className="space-y-3 mb-5">
          <p className="text-sm font-medium text-muted-foreground">Solid Color</p>
          <div className="flex gap-2 flex-wrap items-center">
            {COLORS.map((col, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setSelectedColor(col.value);
                  onSelect(currentIcon || "bot", currentIconType || "preset", col.value, selectedShape);
                }}
                className={`w-8 h-8 rounded-full border-2 transition-all ${col.value} ${
                  selectedColor === col.value 
                    ? "ring-2 ring-primary ring-offset-2 border-primary scale-110" 
                    : "border-transparent hover:scale-105"
                }`}
                title={col.label}
              />
            ))}

            {/* Custom Pen Button with Tooltip */}
            <div className="relative group">
              <button
                type="button"
                className={`w-9 h-9 rounded-full border-2 flex items-center justify-center transition-all ${
                  isCustomHex
                    ? "border-primary bg-primary/10 text-primary ring-2 ring-primary/20 scale-110"
                    : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-primary/50"
                }`}
              >
                <Pen size={15} />
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block px-2 py-0.5 bg-popover text-popover-foreground text-[10px] font-medium rounded shadow-md whitespace-nowrap z-10">
                Custom
              </div>
              <input
                type="color"
                value={isCustomHex ? selectedColor : "#3b82f6"}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedColor(val);
                  onSelect(currentIcon || "bot", currentIconType || "preset", val, selectedShape);
                }}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full rounded-full"
                title="Custom Color"
              />
            </div>
          </div>

          {/* Manual Hex Code Input */}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-muted-foreground">Hex Code:</span>
            <input
              type="text"
              placeholder="#3b82f6"
              value={isCustomHex ? selectedColor : ""}
              onChange={(e) => {
                const val = e.target.value;
                setSelectedColor(val);
                if (val.startsWith("#") && (val.length === 4 || val.length === 7)) {
                  onSelect(currentIcon || "bot", currentIconType || "preset", val, selectedShape);
                }
              }}
              className="px-2.5 py-1 text-xs rounded-lg border border-border bg-background text-foreground w-32"
            />
          </div>
        </div>

        {/* Preset Icons */}
        <div className="space-y-3 mb-5">
          <p className="text-sm font-medium text-muted-foreground">Preset Icons</p>
          <div className="grid grid-cols-4 gap-2">
            {PRESET_ICONS.map(({ id, icon: Icon, label }) => {
              const isSelected = (currentIcon === id || (!currentIcon && id === "bot")) && currentIconType === "preset";
              return (
                <button
                  key={id}
                  onClick={() => {
                    onSelect(id, "preset", selectedColor, selectedShape);
                    onClose();
                  }}
                  className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 ${
                    isSelected
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