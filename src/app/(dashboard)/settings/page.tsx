"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { User, Save, Loader2, Palette, Globe, Camera, Image as ImageIcon, Lock, Eye, EyeOff, Trash2, AlertTriangle } from "lucide-react";
import { useTheme } from "@/lib/theme-provider";
import { useTranslation, LANGUAGES } from "@/lib/i18n";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";

export default function SettingsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Change password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useTranslation();
  const [user, setUser] = useState<any>(null);

  // Delete account state
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        setUser(user);
        setEmail(user.email || "");

        // ALWAYS read from profiles table - single source of truth
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

    if (!user) {
      setLoading(false);
      return;
    }

    // Update name in profiles table - single source of truth
    if (name) {
      const { error: nameError } = await supabase
        .from('profiles')
        .upsert({ id: user.id, name }, { onConflict: 'id' });
      
      if (nameError) {
        setError(nameError.message);
        setLoading(false);
        return;
      }
    }

    // Handle avatar upload if provided
    if (avatar) {
      try {
        // Delete old avatar from storage first if exists
        const { data: oldProfile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', user.id)
          .maybeSingle();

        if (oldProfile?.avatar_url) {
          const oldParts = oldProfile.avatar_url.split('/');
          const oldFileName = oldParts[oldParts.length - 1];
          if (oldFileName) {
            await supabase.storage.from('avatars').remove([oldFileName]);
          }
        }

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
    else if (avatar === null && avatarPreview === null) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('id', user.id)
        .maybeSingle();
      
      if (profile?.avatar_url) {
        const urlParts = profile.avatar_url.split('/');
        const fileName = urlParts[urlParts.length - 1];
        if (fileName) {
          await supabase.storage.from('avatars').remove([fileName]);
        }

        await supabase
          .from('profiles')
          .update({ avatar_url: null })
          .eq('id', user.id);
      }
    }

    setSuccess(t("settings.saved"));
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
    if (!user) return;

    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('id', user.id)
        .maybeSingle();

      if (profile?.avatar_url) {
        const urlParts = profile.avatar_url.split('/');
        const fileName = urlParts[urlParts.length - 1];

        if (fileName) {
          await supabase.storage.from('avatars').remove([fileName]);
        }
      }

      await supabase
        .from('profiles')
        .update({ avatar_url: null })
        .eq('id', user.id);

      setAvatar(null);
      setAvatarPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      console.error("Failed to remove avatar:", err);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");

    if (!user) return;

    if (!currentPassword) {
      setPasswordError(t("settings.currentPasswordRequired"));
      return;
    }
    if (!newPassword) {
      setPasswordError(t("settings.newPasswordRequired"));
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t("settings.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("settings.passwordsDontMatch"));
      return;
    }

    setPasswordLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        if (error.message.includes("Invalid login") || error.message.includes("wrong password") || error.message.includes("current password")) {
          setPasswordError(t("settings.wrongCurrentPassword"));
        } else {
          setPasswordError(error.message);
        }
        setPasswordLoading(false);
        return;
      }

      setPasswordSuccess(t("settings.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : t("settings.passwordChangeFailed"));
    }
    setPasswordLoading(false);
  }

  async function handleDeleteAccount() {
    if (deletingAccount) return;
    setDeletingAccount(true);
    setDeleteAccountError("");

    try {
      const res = await fetch("/api/user/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setDeleteAccountError(data?.error || t("settings.deleteAccountFailed"));
        setDeletingAccount(false);
        return;
      }

      try {
        await supabase.auth.signOut();
      } catch {}
      window.location.href = "/login";
    } catch {
      setDeleteAccountError(t("settings.deleteAccountFailed"));
      setDeletingAccount(false);
    }
  }

  return (
    <div className="fd-scroll h-full overflow-y-auto p-6">
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

      {/* Change Password */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10">
            <Lock size={20} className="text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">{t("settings.changePassword")}</h2>
        </div>

        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("settings.currentPassword")}
            </label>
            <div className="relative">
              <input
                type={showCurrentPassword ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring pr-10"
                placeholder={t("settings.currentPasswordPlaceholder")}
              />
              <button
                type="button"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showCurrentPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("settings.newPassword")}
            </label>
            <div className="relative">
              <input
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring pr-10"
                placeholder={t("settings.newPasswordPlaceholder")}
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t("settings.confirmPassword")}
            </label>
            <div className="relative">
              <input
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring pr-10"
                placeholder={t("settings.confirmPasswordPlaceholder")}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {passwordSuccess && <p className="text-sm text-green-500">{passwordSuccess}</p>}
          {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}

          <button
            type="submit"
            disabled={passwordLoading}
            className="flex items-center gap-2 px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {passwordLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
            {t("settings.changePasswordBtn")}
          </button>
        </form>
      </div>

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

      {/* Delete account */}
      <div className="p-6 rounded-xl border border-destructive/35 bg-destructive/5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-5 sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="shrink-0 p-2 rounded-lg bg-destructive/10">
              <AlertTriangle size={20} className="text-destructive" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-destructive">
                {t("settings.deleteAccount")}
              </h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-md leading-relaxed">
                {t("settings.deleteAccountDescription")}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setDeleteAccountError("");
              setDeleteAccountOpen(true);
            }}
            className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-destructive text-white text-sm font-medium hover:bg-destructive/90 transition-colors"
          >
            <Trash2 size={16} />
            {t("settings.deleteAccount")}
          </button>
        </div>
      </div>
    </div>

    {deleteAccountOpen && (
      <DeleteAccountDialog
        loading={deletingAccount}
        error={deleteAccountError}
        onConfirm={handleDeleteAccount}
        onCancel={() => setDeleteAccountOpen(false)}
      />
    )}
    </div>
  );
}