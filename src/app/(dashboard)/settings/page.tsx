"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { User, Save, Loader2, Palette, Globe, Camera, Image as ImageIcon } from "lucide-react";
import { useTheme } from "@/lib/theme-provider";
import { useTranslation, LANGUAGES } from "@/lib/i18n";

export default function SettingsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useTranslation();
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        setUser(user);
        setEmail(user.email || "");
        setName(user.user_metadata?.name || "");

        // Fetch existing profile data (name and avatar)
        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("name, avatar_url")
            .eq("id", user.id)
            .maybeSingle();

          if (profile) {
            if (profile.name) setName(profile.name);
            if (profile.avatar_url) setAvatarPreview(profile.avatar_url);
          }
        } catch {}
      }
    });
  }, [supabase]);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    // First update the name in auth metadata if it has changed
    if (name && user) {
      const { error: nameError } = await supabase.auth.updateUser({
        data: { name },
      });

      if (nameError) {
        setError(nameError.message);
        setLoading(false);
        return;
      }

      // Also update name in profiles table so it persists across re-logins
      await supabase
        .from('profiles')
        .upsert({ id: user.id, name }, { onConflict: 'id' });
    }

    // Handle avatar upload if provided
    if (avatar && user) {
      try {
        const fileName = `${user.id}-${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(fileName, avatar, {
            cacheControl: '3600',
            upsert: true
          });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(fileName);

        // Update profile with avatar URL
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ avatar_url: publicUrl })
          .eq('id', user.id);

        if (profileError) throw profileError;
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "فشل رفع الصورة. يرجى المحاولة مرة أخرى.");
        setLoading(false);
        return;
      }
    }
    // Handle avatar removal (if user deleted avatar but didn't upload new one)
    else if (avatar === null && user && avatarPreview === null) {
      // Check if user had an avatar before - if so, explicitly set to null
      const { data: profile } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('id', user.id)
        .maybeSingle();
      
      if (profile?.avatar_url) {
        await supabase
          .from('profiles')
          .update({ avatar_url: null })
          .eq('id', user.id);
      }
    }

    setSuccess(user ? t("settings.saved") : "تم الحفظ بنجاح");
    setLoading(false);
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setAvatar(file);
      setAvatarPreview(URL.createObjectURL(file));
    }
  }

  async function handleRemoveAvatar() {
    setAvatar(null);
    setAvatarPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    // Also update profiles table to explicitly set avatar_url to null
    if (user) {
      await supabase
        .from('profiles')
        .update({ avatar_url: null })
        .eq('id', user.id);
    }
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

          <div className="flex items-center gap-4">
            {avatarPreview ? (
              <div className="relative">
                <img
                  src={avatarPreview}
                  alt="Avatar preview"
                  className="w-20 h-20 rounded-full object-cover"
                />
                <button
                  type="button"
                  onClick={handleRemoveAvatar}
                  className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                >
                  <ImageIcon size={14} />
                </button>
              </div>
            ) : (
              <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                <User size={40} />
              </div>
            )}

            <div className="space-y-2 flex-1">
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

              <div className="flex gap-2">
                <label className="cursor-pointer px-4 py-2 rounded-lg border border-border bg-background text-foreground text-sm font-medium hover:bg-muted transition-colors flex items-center gap-2">
                  <Camera size={16} />
                  {t("settings.uploadImage")}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
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