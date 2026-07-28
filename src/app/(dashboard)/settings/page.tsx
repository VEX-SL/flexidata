"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { User, Save, Loader2, Palette, Globe } from "lucide-react";
import { useTheme } from "@/lib/theme-provider";
import { useTranslation, LANGUAGES } from "@/lib/i18n";

export default function SettingsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useTranslation();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setEmail(user.email || "");
        setName(user.user_metadata?.name || "");
      }
    });
  }, [supabase]);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    const { error } = await supabase.auth.updateUser({
      data: { name },
    });

    if (error) {
      setError(error.message);
    } else {
      setSuccess(t("settings.saved"));
    }
    setLoading(false);
  }

  return (
    <div className="h-full overflow-auto p-6">
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("settings.title")}</h1>
        <p className="text-muted-foreground mt-1">{t("settings.subtitle")}</p>
      </div>

      <form onSubmit={handleUpdate} className="space-y-6">
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary/10">
              <User size={20} className="text-primary" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">{t("settings.profile")}</h2>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("settings.name")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("settings.email")}
            </label>
            <input
              type="email"
              value={email}
              disabled
              className="w-full px-4 py-2 rounded-lg border border-border bg-muted text-muted-foreground"
            />
          </div>
        </div>

        {success && <p className="text-sm text-green-500">{success}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Save size={16} />
          )}
          {t("settings.save")}
        </button>
      </form>

      {/* Appearance */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10">
            <Palette size={20} className="text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">{t("settings.appearance")}</h2>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t("settings.theme")}
          </label>
          <div className="flex gap-2">
            {(["light", "dark", "system"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setTheme(opt)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  theme === opt
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`settings.theme${opt.charAt(0).toUpperCase() + opt.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Language */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10">
            <Globe size={20} className="text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">{t("settings.language")}</h2>
        </div>

        <div className="flex gap-2 flex-wrap">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => setLang(l.code)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                lang === l.code
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
    </div>
  );
}
