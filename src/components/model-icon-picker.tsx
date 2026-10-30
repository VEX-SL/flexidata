"use client";

import { useState, useRef, useEffect } from "react";
import { X, Upload, Sparkles, Zap, Crown, Heart, Star, Feather, Bot, Brain } from "lucide-react";

interface ModelIconPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (icon: string | File | null, type: "preset" | "custom") => void;
  currentIcon?: string | null;
  currentIconType?: "preset" | "custom" | null;
}

const PRESET_ICONS = [
  { id: "sparkles", icon: Sparkles, label: "Sparkles" },
  { id: "zap", icon: Zap, label: "Lightning" },
  { id: "crown", icon: Crown, label: "Crown" },
  { id: "heart", icon: Heart, label: "Heart" },
  { id: "star", icon: Star, label: "Star" },
  { id: "feather", icon: Feather, label: "Wings" },
  { id: "bot", icon: Bot, label: "Bot" },
  { id: "brain", icon: Brain, label: "Brain" },
];

export function ModelIconPicker({
  isOpen,
  onClose,
  onSelect,
  currentIcon,
  currentIconType,
}: ModelIconPickerProps) {
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

  useEffect(() => {
    if (!isOpen) {
      setCustomImage(null);
      setCustomFile(null);
    }
  }, [isOpen]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setCustomFile(file);
      setCustomImage(URL.createObjectURL(file));
    }
  }

  function handleCustomSelect() {
    fileInputRef.current?.click();
  }

  function handleConfirmCustom() {
    if (customFile) {
      onSelect(customFile, "custom");
      onClose(); // إغلاق النافذة فوراً عند الضغط على Use This
    }
  }

  function handlePresetSelect(iconId: string) {
    onSelect(iconId, "preset");
    onClose(); // إغلاق النافذة فوراً عند اختيار أيقونة جاهزة
  }

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md bg-card border border-border rounded-2xl p-6 shadow-xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-foreground">Choose Model Icon</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Preset Icons */}
        <div className="space-y-4 mb-6">
          <p className="text-sm font-medium text-muted-foreground">Preset Icons</p>
          <div className="grid grid-cols-4 gap-3">
            {PRESET_ICONS.map(({ id, icon: Icon, label }) => {
              const isSelected = currentIcon === id && currentIconType === "preset";
              return (
                <button
                  key={id}
                  onClick={() => handlePresetSelect(id)}
                  className={`relative p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 ${
                    isSelected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Icon size={24} className="text-current" />
                  <span className="text-xs text-center">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Upload */}
        <div className="space-y-4">
          <p className="text-sm font-medium text-muted-foreground">Custom Icon</p>
          
          <div className="relative">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            
            <div className="border-2 border-dashed border-border rounded-xl p-6 text-center transition-colors hover:border-primary/50 flex flex-col items-center justify-center">
              {customImage ? (
                <div className="flex flex-col items-center justify-center gap-3 w-full">
                  <img
                    src={customImage}
                    alt="Custom preview"
                    className="w-20 h-20 rounded-xl object-cover border border-border mx-auto"
                  />
                  <div className="flex gap-2 justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        setCustomImage(null);
                        setCustomFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                      className="px-3 py-1.5 rounded-lg text-sm font-medium border border-border bg-background text-foreground hover:bg-accent transition-colors"
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmCustom}
                      className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                    >
                      Use This
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleCustomSelect}
                  className="flex flex-col items-center justify-center w-full gap-2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <div className="p-3 rounded-full bg-muted flex items-center justify-center">
                    <Upload size={24} className="text-muted-foreground" />
                  </div>
                  <span className="text-sm font-medium">Upload Custom Icon</span>
                  <p className="text-xs text-muted-foreground/70">PNG, JPG up to 2MB</p>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}