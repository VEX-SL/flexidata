"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Mail, AlertCircle, CheckCircle } from "lucide-react";

// ─── Inline Translations ─────────────────────────────────────────────────────
const translations: Record<string, Record<string, string>> = {
  ar: {
    "forgotPassword.title": "نسيت كلمة المرور؟",
    "forgotPassword.subtitle": "أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة تعيين كلمة المرور",
    "forgotPassword.emailLabel": "البريد الإلكتروني",
    "forgotPassword.emailPlaceholder": "example@domain.com",
    "forgotPassword.emailRequired": "البريد الإلكتروني مطلوب",
    "forgotPassword.invalidEmail": "بريد إلكتروني غير صالح",
    "forgotPassword.sendLink": "إرسال رابط إعادة التعيين",
    "forgotPassword.checkEmail": "تحقق من بريدك الإلكتروني",
    "forgotPassword.sentTo": "أرسلنا رابط إعادة التعيين إلى {{email}}",
    "forgotPassword.checkSpam": "إذا لم تجد الرسالة، تحقق من مجلد السبام (Spam).",
    "forgotPassword.rememberPassword": "تذكرت كلمة المرور؟",
    "forgotPassword.backToLogin": "العودة لتسجيل الدخول",
    "forgotPassword.error": "حدث خطأ، يرجى المحاولة مرة أخرى",
  },
  en: {
    "forgotPassword.title": "Forgot Password?",
    "forgotPassword.subtitle": "Enter your email and we'll send you a password reset link",
    "forgotPassword.emailLabel": "Email",
    "forgotPassword.emailPlaceholder": "example@domain.com",
    "forgotPassword.emailRequired": "Email is required",
    "forgotPassword.invalidEmail": "Invalid email address",
    "forgotPassword.sendLink": "Send Reset Link",
    "forgotPassword.checkEmail": "Check Your Email",
    "forgotPassword.sentTo": "We've sent a password reset link to {{email}}",
    "forgotPassword.checkSpam": "If you don't see the email, check your spam folder.",
    "forgotPassword.rememberPassword": "Remember your password?",
    "forgotPassword.backToLogin": "Back to Login",
    "forgotPassword.error": "An error occurred, please try again",
  },
  fr: {
    "forgotPassword.title": "Mot de passe oublié ?",
    "forgotPassword.subtitle": "Entrez votre email et nous vous enverrons un lien de réinitialisation",
    "forgotPassword.emailLabel": "Email",
    "forgotPassword.emailPlaceholder": "exemple@domaine.com",
    "forgotPassword.emailRequired": "L'email est requis",
    "forgotPassword.invalidEmail": "Adresse email invalide",
    "forgotPassword.sendLink": "Envoyer le lien de réinitialisation",
    "forgotPassword.checkEmail": "Vérifiez votre email",
    "forgotPassword.sentTo": "Nous avons envoyé un lien de réinitialisation à {{email}}",
    "forgotPassword.checkSpam": "Si vous ne voyez pas l'email, vérifiez vos spams.",
    "forgotPassword.rememberPassword": "Vous souvenez-vous de votre mot de passe ?",
    "forgotPassword.backToLogin": "Retour à la connexion",
    "forgotPassword.error": "Une erreur est survenue, veuillez réessayer",
  },
  zh: {
    "forgotPassword.title": "忘记密码？",
    "forgotPassword.subtitle": "输入您的邮箱，我们将发送重置密码链接",
    "forgotPassword.emailLabel": "邮箱",
    "forgotPassword.emailPlaceholder": "example@domain.com",
    "forgotPassword.emailRequired": "邮箱不能为空",
    "forgotPassword.invalidEmail": "邮箱格式不正确",
    "forgotPassword.sendLink": "发送重置链接",
    "forgotPassword.checkEmail": "请检查您的邮箱",
    "forgotPassword.sentTo": "我们已发送重置链接到 {{email}}",
    "forgotPassword.checkSpam": "如果没收到邮件，请检查垃圾箱。",
    "forgotPassword.rememberPassword": "想起密码了？",
    "forgotPassword.backToLogin": "返回登录",
    "forgotPassword.error": "发生错误，请重试",
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
        font-weight: 700,
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
        justify-content: center;
      }

      .fd-success .fd-success-content {
        width: 100%;
        text-align: center;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
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
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [sentEmail, setSentEmail] = useState("");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!email.trim()) {
      setError(t("forgotPassword.emailRequired"));
      return;
    }

    // Simple email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError(t("forgotPassword.invalidEmail"));
      return;
    }

    setLoading(true);
    setSentEmail(email);

    try {
      const res = await fetch(`${window.location.origin}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: `${window.location.origin}/auth/reset-password` }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("forgotPassword.error"));
        setLoading(false);
        return;
      }

      setSuccess(true);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("forgotPassword.error"));
      setLoading(false);
    }
  }

  return (
    <div className="fd-auth-root">
      <AuthStyles />
      <ParticleBg />

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
            <h2 className="fd-card-title">{t("forgotPassword.title")}</h2>
            <p className="fd-card-sub">{t("forgotPassword.subtitle")}</p>

            {error && (
              <div className="fd-error" role="alert">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="fd-form">
              <div className="fd-input-group">
                <label className="fd-label">{t("forgotPassword.emailLabel")}</label>
                <div className="fd-input-wrapper">
                  <Mail className="fd-input-icon" size={18} />
                  <input
                    type="email"
                    placeholder={t("forgotPassword.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="fd-input"
                    autoComplete="email"
                    required
                    disabled={loading}
                  />
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
                    <Mail size={18} />
                    {t("forgotPassword.sendLink")}
                  </>
                )}
              </button>
            </form>

            <div className="fd-footer">
              <p className="fd-footer-text">
                {t("forgotPassword.rememberPassword")}{" "}
                <Link href="/login" className="fd-footer-link">
                  {t("forgotPassword.backToLogin")}
                </Link>
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="fd-success" style={{ marginBottom: '1.5rem' }}>
              <CheckCircle size={48} style={{ color: '#22c55e', marginBottom: '1rem' }} />
              <div className="fd-success-content">
                <h2 className="fd-card-title" style={{ fontSize: '1.3rem' }}>
                  {t("forgotPassword.checkEmail")}
                </h2>
                <p className="fd-card-sub">
                  {t("forgotPassword.sentTo", { email: sentEmail })}
                </p>
                <p
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--color-muted-foreground)',
                    marginTop: '0.25rem',
                    lineHeight: 1.6,
                  }}
                >
                  {t("forgotPassword.checkSpam")}
                </p>
              </div>
            </div>

            <div className="fd-footer">
              <p className="fd-footer-text">
                {t("forgotPassword.rememberPassword")}{" "}
                <Link href="/login" className="fd-footer-link">
                  {t("forgotPassword.backToLogin")}
                </Link>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
