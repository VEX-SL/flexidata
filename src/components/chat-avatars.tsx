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
    // تصميم الأجنحة المظبوط تماماً والمتناسق
    return ({ size = 24, className = "" }: { size?: number; className?: string }) => (
      <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 948 767" fill="currentColor" className={className} aria-hidden="true">
        <path d="M546 640 L552 633 L553 633 L557 629 L558 629 L563 625 L567 623 L569 623 L572 621 L574 621 L578 619 L581 619 L582 618 L600 618 L601 619 L606 619 L607 620 L610 620 L611 621 L614 621 L615 622 L618 622 L619 623 L622 623 L623 624 L626 624 L627 625 L634 625 L635 626 L646 626 L647 625 L653 625 L654 624 L662 623 L663 622 L668 621 L668 620 L664 621 L663 620 L654 620 L653 619 L648 619 L647 618 L644 618 L640 616 L637 616 L636 615 L634 615 L633 614 L631 614 L624 611 L621 611 L620 610 L617 610 L616 609 L611 609 L610 608 L591 608 L590 609 L586 609 L585 610 L577 612 L563 620 L550 633Z M279 620 L279 621 L282 621 L283 622 L285 622 L289 624 L293 624 L294 625 L301 625 L302 626 L314 626 L315 625 L321 625 L322 624 L325 624 L326 623 L329 623 L330 622 L333 622 L334 621 L337 621 L338 620 L341 620 L342 619 L345 619 L346 618 L365 618 L366 619 L370 619 L371 620 L376 621 L386 626 L388 628 L392 630 L402 640 L401 637 L397 633 L397 632 L383 619 L368 611 L362 610 L361 609 L357 609 L356 608 L337 608 L336 609 L327 610 L326 611 L324 611 L323 612 L321 612 L314 615 L311 615 L310 616 L304 617 L303 618 L300 618 L299 619 L294 619 L293 620Z M732 592 L731 591 L730 592 L728 592 L727 593 L723 593 L722 594 L710 594 L709 595 L701 595 L700 594 L687 594 L686 593 L673 592 L672 591 L664 590 L663 589 L660 589 L659 588 L656 588 L655 587 L651 587 L650 586 L646 586 L645 585 L641 585 L640 584 L635 584 L634 583 L628 583 L627 582 L606 582 L605 583 L599 583 L598 584 L587 586 L581 589 L579 589 L567 595 L558 602 L557 602 L544 614 L544 615 L537 624 L530 638 L530 640 L527 647 L527 650 L526 651 L526 655 L525 656 L525 663 L524 664 L524 681 L525 682 L525 689 L526 689 L526 671 L527 670 L528 661 L530 657 L530 654 L534 646 L534 644 L537 640 L539 635 L541 633 L543 629 L547 625 L547 624 L554 617 L555 617 L560 612 L561 612 L566 608 L578 602 L580 602 L587 599 L590 599 L591 598 L595 598 L596 597 L618 597 L619 598 L630 599 L631 600 L635 600 L636 601 L640 601 L641 602 L644 602 L645 603 L649 603 L650 604 L654 604 L655 605 L659 605 L660 606 L665 606 L666 607 L691 607 L692 606 L697 606 L698 605 L701 605 L708 602 L711 602Z M217 592 L237 602 L240 602 L247 605 L250 605 L251 606 L256 606 L257 607 L281 607 L282 606 L287 606 L288 605 L292 605 L293 604 L298 604 L299 603 L302 603 L303 602 L307 602 L308 601 L312 601 L313 600 L317 600 L318 599 L322 599 L323 598 L329 598 L330 597 L352 597 L353 598 L357 598 L358 599 L361 599 L365 601 L368 601 L380 607 L389 614 L390 614 L403 627 L405 631 L410 637 L417 652 L417 654 L419 658 L419 661 L420 662 L420 665 L421 666 L421 672 L422 673 L422 690 L422 688 L423 687 L423 673 L424 672 L424 670 L423 669 L423 659 L422 658 L422 654 L421 653 L421 649 L419 645 L419 642 L411 625 L409 623 L407 619 L403 615 L403 614 L392 603 L391 603 L387 599 L386 599 L381 595 L367 588 L365 588 L358 585 L354 585 L353 584 L350 584 L349 583 L345 583 L344 582 L318 582 L317 583 L307 584 L306 585 L297 586 L296 587 L293 587 L292 588 L288 588 L287 589 L284 589 L283 590 L280 590 L279 591 L274 591 L273 592 L268 592 L267 593 L260 593 L259 594 L245 594 L244 595 L241 595 L240 594 L226 594 L225 593Z" fillRule="evenodd" clipRule="evenodd" />
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