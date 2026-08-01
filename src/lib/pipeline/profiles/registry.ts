import type {
  ExtractionProfile,
  ProfileInfo,
  ProfilePlugin,
} from "../types";
import { invoicePlugin } from "./invoice";
import { receiptPlugin } from "./receipt";
import { resumePlugin } from "./resume";
import { contractPlugin } from "./contract";
import { fallbackPlugin } from "./fallback";

/**
 * ProfileManager — the plugin registry.
 *
 * Adding a new document type = register a new plugin here. No other part of
 * the pipeline needs to change.
 */
export class ProfileManager {
  private plugins: Map<string, ProfilePlugin> = new Map();

  constructor(plugins: ProfilePlugin[]) {
    for (const plugin of plugins) {
      if (!this.plugins.has(plugin.info.id)) {
        this.plugins.set(plugin.info.id, plugin);
      }
    }
  }

  static builtin(): ProfileManager {
    return new ProfileManager([
      invoicePlugin,
      receiptPlugin,
      resumePlugin,
      contractPlugin,
      fallbackPlugin,
    ]);
  }

  /** Register a plugin at runtime (e.g. a user-created profile). */
  register(plugin: ProfilePlugin): void {
    this.plugins.set(plugin.info.id, plugin);
  }

  list(): ProfileInfo[] {
    return Array.from(this.plugins.values())
      .filter((p) => p.info.enabled)
      .map((p) => p.info)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  get(id: string): ExtractionProfile | null {
    const plugin = this.plugins.get(id);
    if (!plugin || !plugin.info.enabled) return null;
    return plugin.build();
  }

  /** Resolve an unknown/unsupported id to the fallback profile. */
  getOrFallback(id: string): ExtractionProfile {
    return this.get(id) ?? this.get("unknown") ?? fallbackPlugin.build();
  }

  /** Profiles usable by the classifier (fallback excluded). */
  candidates(): ExtractionProfile[] {
    return Array.from(this.plugins.values())
      .filter((p) => p.info.enabled && p.info.id !== "unknown")
      .map((p) => p.build());
  }

  /** Profiles used by rule-based classification. */
  all(): ExtractionProfile[] {
    return Array.from(this.plugins.values())
      .filter((p) => p.info.enabled)
      .map((p) => p.build());
  }
}

let instance: ProfileManager | null = null;

export function getProfileManager(): ProfileManager {
  if (!instance) {
    instance = ProfileManager.builtin();
  }
  return instance;
}
