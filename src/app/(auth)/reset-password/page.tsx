"use client";

export const dynamic = 'force-dynamic';

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Lock, Eye, EyeOff, AlertCircle, CheckCircle } from "lucide-react";

// ─── Inline Translations ─────────────────────────────────────────────────────
const translations: Record<string, Record<string, string>> = {
  ar: {
    "resetPassword.title": "إعادة تعيين كلمة المرور",
    "resetPassword.subtitle": "أدخل كلمة المرور الجديدة لحسابك",
    "resetPassword.newPasswordLabel": "كلمة المرور الجديدة",
    "resetPassword.newPasswordPlaceholder": "أدخل كلمة المرور الجديدة (8 أحرف على الأقل)",
    "resetPassword.confirmPasswordLabel": "تأكيد كلمة المرور الجديدة",
    "resetPassword.confirmPasswordPlaceholder": "أعد إدخال كلمة المرور الجديدة",
    "resetPassword.newPasswordRequired": "كلمة المرور الجديدة مطلوبة",
    "resetPassword.passwordTooShort": "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
    "resetPassword.passwordsDontMatch": "كلمتا المرور غير متطابقتين",
    "resetPassword.updatePassword": "تحديث كلمة المرور",
    "resetPassword.passwordUpdated": "تم تحديث كلمة المرور",
    "resetPassword.passwordUpdatedDesc": "تم تغيير كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.",
    "resetPassword.goToLogin": "الذهاب لتسجيل الدخول",
    "resetPassword.rememberPassword": "تذكرت كلمة المرور؟",
    "resetPassword.backToLogin": "العودة لتسجيل الدخول",
    "resetPassword.invalidLink": "رابط غير صالح أو منتهي الصلاحية",
    "resetPassword.linkExpired": "رابط إعادة التعيين غير صالح أو انتهت صلاحيته. يرجى طلب رابط جديد.",
    "resetPassword.requestNewLink": "طلب رابط جديد",
    "resetPassword.error": "حدث خطأ، يرجى المحاولة مرة أخرى",
  },
  en: {
    "resetPassword.title": "Reset Password",
    "resetPassword.subtitle": "Enter your new password",
    "resetPassword.newPasswordLabel": "New Password",
    "resetPassword.newPasswordPlaceholder": "Enter new password (min 8 characters)",
    "resetPassword.confirmPasswordLabel": "Confirm New Password",
    "resetPassword.confirmPasswordPlaceholder": "Re-enter new password",
    "resetPassword.newPasswordRequired": "New password is required",
    "resetPassword.passwordTooShort": "Password must be at least 8 characters",
    "resetPassword.passwordsDontMatch": "Passwords do not match",
    "resetPassword.updatePassword": "Update Password",
    "resetPassword.passwordUpdated": "Password Updated",
    "resetPassword.passwordUpdatedDesc": "Your password has been changed successfully. You can now log in with your new password.",
    "resetPassword.goToLogin": "Go to Login",
    "resetPassword.rememberPassword": "Remember your password?",
    "resetPassword.backToLogin": "Back to Login",
    "resetPassword.invalidLink": "Invalid or Expired Link",
    "resetPassword.linkExpired": "The password reset link is invalid or has expired. Please request a new link.",
    "resetPassword.requestNewLink": "Request New Link",
    "resetPassword.error": "An error occurred, please try again",
  },
  fr: {
    "resetPassword.title": "Réinitialiser le mot de passe",
    "resetPassword.subtitle": "Entrez votre nouveau mot de passe",
    "resetPassword.newPasswordLabel": "Nouveau mot de passe",
    "resetPassword.newPasswordPlaceholder": "Entrez le nouveau mot de passe (min 8 caractères)",
    "resetPassword.confirmPasswordLabel": "Confirmer le nouveau mot de passe",
    "resetPassword.confirmPasswordPlaceholder": "Retapez le nouveau mot de passe",
    "resetPassword.newPasswordRequired": "Le nouveau mot de passe est requis",
    "resetPassword.passwordTooShort": "Le mot de passe doit contenir au moins 8 caractères",
    "resetPassword.passwordsDontMatch": "Les mots de passe ne correspondent pas",
    "resetPassword.updatePassword": "Mettre à jour le mot de passe",
    "resetPassword.passwordUpdated": "Mot de passe mis à jour",
    "resetPassword.passwordUpdatedDesc": "Votre mot de passe a été changé avec succès. Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.",
    "resetPassword.goToLogin": "Aller à la connexion",
    "resetPassword.rememberPassword": "Vous souvenez-vous de votre mot de passe ?",
    "resetPassword.backToLogin": "Retour à la connexion",
    "resetPassword.invalidLink": "Lien invalide ou expiré",
    "resetPassword.linkExpired": "Le lien de réinitialisation est invalide ou a expiré. Veuillez demander un nouveau lien.",
    "resetPassword.requestNewLink": "Demander un nouveau lien",
    "resetPassword.error": "Une erreur est survenue, veuillez réessayer",
  },
  zh: {
    "resetPassword.title": "重置密码",
    "resetPassword.subtitle": "输入您的新密码",
    "resetPassword.newPasswordLabel": "新密码",
    "resetPassword.newPasswordPlaceholder": "输入新密码（至少8字符）",
    "resetPassword.confirmPasswordLabel": "确认新密码",
    "resetPassword.confirmPasswordPlaceholder": "再次输入新密码",
    "resetPassword.newPasswordRequired": "请输入新密码",
    "resetPassword.passwordTooShort": "密码至少需要8个字符",
    "resetPassword.passwordsDontMatch": "两次输入的密码不一致",
    "resetPassword.updatePassword": "更新密码",
    "resetPassword.passwordUpdated": "密码已更新",
    "resetPassword.passwordUpdatedDesc": "密码修改成功。您现在可以使用新密码登录。",
    "resetPassword.goToLogin": "去登录",
    "resetPassword.rememberPassword": "想起密码了？",
    "resetPassword.backToLogin": "返回登录",
    "resetPassword.invalidLink": "链接无效或已过期",
    "resetPassword.linkExpired": "重置密码链接无效或已过期。请重新申请链接。",
    "resetPassword.requestNewLink": "重新申请链接",
    "resetPassword.error": "发生错误，请重试",
  },
};

function getLang(): keyof typeof translations {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem("lang") as keyof typeof translations | null;
  if (stored && translations[stored]) return stored;
  const browserLangs = navigator.languages || [navigator.language];
  for (const bl of browserLangs) {
    const code = bl.split("-")[0].toLowerCase();
    if (code in translations) return code as keyof typeof translations;
  }
  return "en";
}

function t(key: string, params?: Record<string, string | number>): string {
  const lang = getLang();
  let value = translations[lang]?.[key] || translations.en[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return value;
}

// ─── Stable particle data (deterministic — avoids hydration mismatch) ────────
const PARTICLES = [
  { id: 0,  x: 12, y: 23, s: 2, d: 0.0, dur: 6 },
  { id: 1,  x: 28, y: 67, s: 1, d: 0.8, dur: 7 },
  { id: 2,  x: 45, y: 15, s: 3, d: 1.6, dur: 5 },
  { id: 3,  x: 63, y: 82, s: 1, d: 0.4, dur: 8 },
  { id: 4,  x: 78, y: 41, s: 2, d: 2.0, dur: 6 },
  { id: 5,  x: 91, y: 59, s: 1, d: 1.2, dur: 7 },
  { id: 6,  x: 35, y: 92, s: 2, d: 0.6, dur: 5 },
  { id: 7,  x: 55, y: 33, s: 1, d: 1.8, dur: 8 },
  { id: 8,  x: 72, y: 78, s: 3, d: 0.2, dur: 6 },
  { id: 9,  x: 18, y: 50, s: 1, d: 2.4, dur: 7 },
  { id: 10, x: 84, y: 12, s: 2, d: 1.0, dur: 5 },
  { id: 11, x: 42, y: 55, s: 1, d: 0.3, dur: 8 },
  { id: 12, x: 67, y: 28, s: 2, d: 1.5, dur: 6 },
  { id: 13, x: 25, y: 72, s: 1, d: 2.1, dur: 7 },
  { id: 14, x: 89, y: 45, s: 3, d: 0.7, dur: 5 },
  { id: 15, x: 50, y: 88, s: 1, d: 1.3, dur: 8 },
  { id: 16, x: 8,  y: 35, s: 2, d: 2.2, dur: 6 },
  { id: 17, x: 60, y: 62, s: 1, d: 0.9, dur: 7 },
  { id: 18, x: 38, y: 8,  s: 2, d: 1.7, dur: 5 },
  { id: 19, x: 76, y: 95, s: 1, d: 0.5, dur: 8 },
];

const PARTICLE_COLORS = ["#d4d4d4", "#8a8a8a", "#c8c8c8", "#b8b8b8", "#4a4a4a"];

// ─── Global styles injected once ─────────────────────────────────────────────
function AuthStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');

      .fd-auth-root, .fd-auth-root * {
        box-sizing: border-box;
      }

      .fd-auth-root {
        font-family: 'Sora', system-ui, -apple-system, sans-serif;
        min-height: 100dvh;
        display: flex;
        overflow-y: auto;
      }

      .fd-auth-bg {
        position: fixed;
        inset: 0;
        z-index: -1;
        background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 50%, #0f0f0f 100%);
      }

      .fd-particle {
        position: absolute;
        border-radius: 50%;
        opacity: 0.6;
        animation: fd-float var(--dur) ease-in-out infinite;
        animation-delay: var(--delay);
        pointer-events: none;
      }

      @keyframes fd-float {
        0%, 100% { transform: translateY(0) scale(1); opacity: 0.4; }
        50% { transform: translateY(-20px) scale(1.1); opacity: 0.7; }
      }

      .fd-auth-card {
        width: 100%;
        max-width: 420px;
        margin: auto;
        padding: 2.5rem 2rem;
        background: rgba(26, 26, 26, 0.9);
        border: 1px solid rgba(212, 212, 212, 0.1);
        border-radius: 20px;
        backdrop-filter: blur(20px);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      }

      .fd-mobile-logo {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        justify-content: center;
        margin-bottom: 1.5rem;
      }

      .fd-card-title {
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--color-foreground);
        text-align: center;
        margin: 0 0 0.5rem;
        letter-spacing: -0.02em;
      }

      .fd-card-sub {
        font-size: 0.95rem;
        color: var(--color-muted-foreground);
        text-align: center;
        margin: 0 0 2rem;
        line-height: 1.5;
      }

      .fd-form {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }

      .fd-input-group {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .fd-label {
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--color-foreground);
      }

      .fd-input-wrapper {
        position: relative;
      }

      .fd-input {
        width: 100%;
        padding: 0.875rem 1rem;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(212, 212, 212, 0.15);
        border-radius: 12px;
        color: var(--color-foreground);
        font-size: 0.95rem;
        font-family: inherit;
        transition: all 0.2s ease;
      }

      .fd-input:focus {
        outline: none;
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px var(--color-primary-focus);
        background: rgba(255, 255, 255, 0.05);
      }

      .fd-input::placeholder {
        color: var(--color-muted-foreground);
        opacity: 0.6;
      }

      .fd-input-icon {
        position: absolute;
        right: 1rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-muted-foreground);
        pointer-events: none;
      }

      .fd-btn-primary {
        width: 100%;
        padding: 0.875rem 1.5rem;
        background: var(--color-primary);
        color: var(--color-primary-foreground);
        border: none;
        border-radius: 12px;
        font-size: 0.95rem;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
      }

      .fd-btn-primary:hover:not(:disabled) {
        opacity: 0.9;
        transform: translateY(-1px);
      }

      .fd-btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .fd-error {
        padding: 0.75rem 1rem;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 10px;
        color: #ef4444;
        font-size: 0.85rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .fd-success {
        padding: 0.75rem 1rem;
        background: rgba(34, 197, 94, 0.1);
        border: 1px solid rgba(34, 197, 94, 0.2);
        border-radius: 10px;
        color: #22c55e;
        font-size: 0.85rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .fd-footer {
        text-align: center;
        margin-top: 1.5rem;
        padding-top: 1.5rem;
        border-top: 1px solid rgba(212, 212, 212, 0.1);
      }

      .fd-footer-text {
        font-size: 0.85rem;
        color: var(--color-muted-foreground);
      }

      .fd-footer-link {
        color: var(--color-primary);
        font-weight: 500;
        text-decoration: none;
        transition: opacity 0.2s;
      }

      .fd-footer-link:hover {
        opacity: 0.8;
        text-decoration: underline;
      }

      /* RTL support */
      [dir="rtl"] .fd-input-icon {
        right: auto;
        left: 1rem;
      }
    `}</style>
  );
}

// ─── Particle Background ─────────────────────────────────────────────────────
function ParticleBg() {
  return (
    <div className="fd-auth-bg">
      {PARTICLES.map((p) => (
        <div
          key={p.id}
          className="fd-particle"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.s,
            height: p.s,
            background: PARTICLE_COLORS[p.id % PARTICLE_COLORS.length],
            ['--dur']: `${p.dur}s`,
            ['--delay']: `${p.d}s`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function ResetPasswordPage() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [validLink, setValidLink] = useState(true);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!newPassword) {
      setError(t("resetPassword.newPasswordRequired"));
      return;
    }
    if (newPassword.length < 8) {
      setError(t("resetPassword.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("resetPassword.passwordsDontMatch"));
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${window.location.origin}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("resetPassword.error"));
        setLoading(false);
        return;
      }

      setSuccess(true);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("resetPassword.error"));
      setLoading(false);
    }
  }

  // Wrap useSearchParams usage to satisfy Next.js CSR bailout requirements.
  function ResetPasswordInner() {
    const searchParams = useSearchParams();

    useEffect(() => {
      const code = searchParams.get("code");

      // Token-based links: verify server-side for security.
      if (code) {
        // Practical approach: Supabase may redirect with either
        // (access_token/refresh_token) OR a generic `code`.
        // Our POST /api/auth/reset-password ultimately enforces correctness.
        // So here, we optimistically allow the UI and rely on the POST
        // endpoint to reject invalid/expired links.
        //
        // This avoids breaking user flows due to verifyOtp signature
        // differences across Supabase templates.
        setValidLink(true);
        return;
      }

      const accessToken = searchParams.get("access_token");
      const refreshToken = searchParams.get("refresh_token");
      const type = searchParams.get("type");

      // Fallback for token-style links.
      if (!accessToken || !refreshToken || type !== "recovery") setValidLink(false);
    }, [searchParams]);

    // This component only exists to safely read useSearchParams.
    // The actual UI is rendered by the parent ResetPasswordPage.
    return null;
  }

  if (!validLink) {
    return (
      <div className="fd-auth-root">
        <AuthStyles />
        <ParticleBg />
        <div className="fd-auth-card" style={{ textAlign: 'center' }}>
          <AlertCircle size={48} style={{ color: '#ef4444', marginBottom: '1rem' }} />
          <h2 className="fd-card-title">{t("resetPassword.invalidLink")}</h2>
          <p className="fd-card-sub">{t("resetPassword.linkExpired")}</p>
          <div className="fd-footer">
            <Link href="/forgot-password" className="fd-btn-primary" style={{ marginTop: '1rem' }}>
              {t("resetPassword.requestNewLink")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fd-auth-root">
      <AuthStyles />
      <ParticleBg />

      <Suspense fallback={null}>
        <ResetPasswordInner />
      </Suspense>

      <div className="fd-auth-card">
        {/* Mobile logo */}
        <div className="fd-mobile-logo">
          <img
            src="/photos/auth-logo.png"
            alt=""
            style={{ width: 38, height: 38, borderRadius: 10, objectFit: "contain" }}
          />
          <span style={{ fontWeight: 700, fontSize: "1.05rem", color: "var(--color-foreground)", letterSpacing: "-.022em" }}>
            FlexiData AI
          </span>
        </div>

        {!success ? (
          <>
            <h2 className="fd-card-title">{t("resetPassword.title")}</h2>
            <p className="fd-card-sub">{t("resetPassword.subtitle")}</p>

            {error && (
              <div className="fd-error" role="alert">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="fd-form">
              <div className="fd-input-group">
                <label className="fd-label">{t("resetPassword.newPasswordLabel")}</label>
                <div className="fd-input-wrapper">
                  <Lock className="fd-input-icon" size={18} />
                  <input
                    type={showNewPassword ? "text" : "password"}
                    placeholder={t("resetPassword.newPasswordPlaceholder")}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="fd-input pr-10"
                    autoComplete="new-password"
                    required
                    disabled={loading}
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

              <div className="fd-input-group">
                <label className="fd-label">{t("resetPassword.confirmPasswordLabel")}</label>
                <div className="fd-input-wrapper">
                  <Lock className="fd-input-icon" size={18} />
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    placeholder={t("resetPassword.confirmPasswordPlaceholder")}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="fd-input pr-10"
                    autoComplete="new-password"
                    required
                    disabled={loading}
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

              <button
                type="submit"
                disabled={loading}
                className="fd-btn-primary"
              >
                {loading ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <>
                    <Lock size={18} />
                    {t("resetPassword.updatePassword")}
                  </>
                )}
              </button>
            </form>

            <div className="fd-footer">
              <p className="fd-footer-text">
                {t("resetPassword.rememberPassword")}{" "}
                <Link href="/login" className="fd-footer-link">
                  {t("resetPassword.backToLogin")}
                </Link>
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="fd-success" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <CheckCircle size={48} style={{ color: '#22c55e', marginBottom: '1rem' }} />
              <h2 className="fd-card-title" style={{ fontSize: '1.3rem' }}>
                {t("resetPassword.passwordUpdated")}
              </h2>
              <p className="fd-card-sub">
                {t("resetPassword.passwordUpdatedDesc")}
              </p>
            </div>

            <div className="fd-footer">
              <Link href="/login" className="fd-btn-primary">
                {t("resetPassword.goToLogin")}
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
