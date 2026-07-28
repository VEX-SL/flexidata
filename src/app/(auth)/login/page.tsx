"use client";

import { useState, Suspense, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

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

const PARTICLE_COLORS = ["#818CF8", "#A78BFA", "#38BDF8", "#C4B5FD", "#818CF8"];

// ─── Global styles injected once ─────────────────────────────────────────────
function AuthStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');

      /* 1. ضبط حساب الأبعاد لجميع العناصر داخل الحاوية لتجنب تمدد الـ padding */
      .fd-auth-root, .fd-auth-root * {
        box-sizing: border-box;
      }

      .fd-auth-root {
        font-family: 'Sora', system-ui, -apple-system, sans-serif;
        min-height: 100dvh;
        display: flex;
        overflow-y: auto;
      }

      /* 2. إلغاء التمرير تماماً للشاشات الكبيرة (اللابتوب فما فوق) */
      @media (min-width: 1024px) {
        .fd-auth-root {
          height: 100dvh;
          overflow: hidden;
        }
      }

      /* ── Brand panel ─────────────────── */
      .fd-brand {
        display: none;
        flex-direction: column;
        position: sticky;
        top: 0;
        overflow: hidden;
        width: 54%;
        height: 100dvh;
        flex-shrink: 0;
        background: #06060F;
      }

      @media (min-width: 1024px) { .fd-brand { display: flex; } }

      [data-theme="light"] .fd-brand { background: #ECEBFF; }

      .fd-orb {
        position: absolute;
        width: 720px; height: 720px;
        top: 50%; left: -140px;
        transform: translateY(-50%);
        background: radial-gradient(circle,
          rgba(99,102,241,.38) 0%,
          rgba(139,92,246,.18) 36%,
          transparent 68%
        );
        border-radius: 50%;
        filter: blur(52px);
        animation: fd-orb-breathe 6s ease-in-out infinite;
        pointer-events: none;
      }

      [data-theme="light"] .fd-orb {
        background: radial-gradient(circle,
          rgba(99,102,241,.22) 0%,
          rgba(139,92,246,.10) 36%,
          transparent 68%
        );
      }

      .fd-ring {
        position: absolute;
        border-radius: 50%;
        top: 50%; left: 50%;
        pointer-events: none;
      }
      .fd-ring-a {
        width: 360px; height: 360px;
        border: 1px solid rgba(129,140,248,.20);
        transform: translate(-50%,-50%);
        animation: fd-ring-spin 24s linear infinite;
      }
      .fd-ring-b {
        width: 560px; height: 560px;
        border: 1px solid rgba(129,140,248,.09);
        transform: translate(-50%,-50%);
        animation: fd-ring-spin 38s linear infinite reverse;
      }
      .fd-ring-c {
        width: 190px; height: 190px;
        border: 1px solid rgba(167,139,250,.28);
        transform: translate(-50%,-50%);
        animation: fd-ring-spin 14s linear infinite;
      }

      .fd-particle {
        position: absolute;
        border-radius: 50%;
        pointer-events: none;
        animation: fd-twinkle var(--pdur) ease-in-out infinite var(--pdel);
      }

      /* ── Brand content ───────────────── */
      .fd-brand-content {
        position: relative;
        z-index: 10;
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: 100%;
        padding: 4rem;
      }

      .fd-logo-mark {
        width: 50px; height: 50px;
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        border-radius: 13px;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 8px 28px rgba(99,102,241,.45);
        margin-bottom: 1.1rem;
        flex-shrink: 0;
      }

      .fd-brand-wordmark {
        font-size: 1.45rem;
        font-weight: 700;
        letter-spacing: -.025em;
        color: #F0F0FF;
        margin-bottom: 2.75rem;
      }
      [data-theme="light"] .fd-brand-wordmark { color: #1E1B4B; }

      .fd-hero-h1 {
        font-size: clamp(2rem, 3vw, 2.9rem);
        font-weight: 800;
        line-height: 1.07;
        letter-spacing: -.038em;
        color: #F0F0FF;
        margin: 0 0 1.4rem;
      }
      [data-theme="light"] .fd-hero-h1 { color: #1E1B4B; }

      .fd-shimmer {
        background: linear-gradient(90deg, #818CF8, #A78BFA, #60A5FA, #818CF8);
        background-size: 300% auto;
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: fd-text-shimmer 4.5s linear infinite;
      }

      .fd-hero-sub {
        font-size: 1.02rem;
        line-height: 1.78;
        color: #94A3B8;
        max-width: 390px;
        margin: 0 0 2.5rem;
        font-weight: 400;
      }
      [data-theme="light"] .fd-hero-sub { color: #4B5563; }

      .fd-pill {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 12px 17px;
        border-radius: 13px;
        background: rgba(129,140,248,.07);
        border: 1px solid rgba(129,140,248,.14);
        color: #CBD5E1;
        font-size: .875rem;
        font-weight: 500;
        margin-bottom: 9px;
        transition: background .2s, border-color .2s;
        animation: fd-fade-up .6s ease both;
      }
      [data-theme="light"] .fd-pill {
        background: rgba(99,102,241,.06);
        border-color: rgba(99,102,241,.15);
        color: #374151;
      }
      .fd-pill:hover {
        background: rgba(129,140,248,.13);
        border-color: rgba(129,140,248,.28);
      }

      /* ── Form side ───────────────────── */
      .fd-form-side {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 2rem 1.5rem;
        background: var(--color-background);
        min-height: 100dvh;
      }

      /* 3. إلغاء تمدد الارتفاع للشاشات الكبيرة على جهة الفورم ليتطابق مع الشاشة */
      @media (min-width: 1024px) {
        .fd-form-side {
          min-height: auto;
          height: 100dvh;
        }
      }

      .fd-card {
        width: 100%;
        max-width: 418px;
        animation: fd-fade-up .5s ease both;
      }

      .fd-card-inner {
        padding: 2.5rem;
        border-radius: 22px;
        background: rgba(255,255,255,.03);
        border: 1px solid rgba(129,140,248,.14);
        backdrop-filter: blur(20px);
      }
      [data-theme="light"] .fd-card-inner {
        background: rgba(255,255,255,.96);
        border-color: rgba(99,102,241,.12);
        box-shadow: 0 24px 56px rgba(99,102,241,.08), 0 4px 14px rgba(0,0,0,.04);
      }

      /* Mobile logo (hidden on desktop because brand panel shows) */
      .fd-mobile-logo {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 2rem;
      }
      @media (min-width: 1024px) { .fd-mobile-logo { display: none; } }

      .fd-card-title {
        font-size: 1.6rem;
        font-weight: 700;
        letter-spacing: -.025em;
        color: var(--color-foreground);
        margin: 0 0 .35rem;
      }

      .fd-card-sub {
        font-size: .9rem;
        color: var(--color-muted-foreground);
        margin: 0 0 1.75rem;
      }

      /* ── Inputs ──────────────────────── */
      .fd-input {
        width: 100%;
        padding: 13px 15px;
        border-radius: 11px;
        font-size: .95rem;
        font-family: inherit;
        background: rgba(255,255,255,.05);
        border: 1px solid rgba(129,140,248,.20);
        color: var(--color-foreground);
        transition: border-color .2s, background .2s, box-shadow .2s;
        outline: none;
        box-sizing: border-box;
        margin-bottom: 11px;
        display: block;
      }
      [data-theme="light"] .fd-input {
        background: rgba(238,242,255,.6);
        border-color: rgba(99,102,241,.18);
      }
      .fd-input::placeholder { color: var(--color-muted-foreground); }
      .fd-input:focus {
        border-color: rgba(129,140,248,.55);
        background: rgba(129,140,248,.07);
        box-shadow: 0 0 0 3px rgba(129,140,248,.10);
      }
      [data-theme="light"] .fd-input:focus { background: rgba(238,242,255,.92); }

      /* ── Primary button ──────────────── */
      .fd-btn-primary {
        width: 100%;
        padding: 14px;
        border-radius: 11px;
        font-size: .95rem;
        font-weight: 600;
        font-family: inherit;
        color: #fff;
        border: none;
        cursor: pointer;
        background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%);
        position: relative;
        overflow: hidden;
        transition: transform .2s, box-shadow .2s, opacity .2s;
        margin-top: 4px;
        margin-bottom: 1.5rem;
      }
      .fd-btn-primary::after {
        content: '';
        position: absolute; inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,.12), transparent);
        border-radius: inherit;
        pointer-events: none;
      }
      .fd-btn-primary:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 12px 32px rgba(99,102,241,.45);
      }
      .fd-btn-primary:active:not(:disabled) { transform: translateY(0); }
      .fd-btn-primary:disabled { opacity: .6; cursor: not-allowed; }

      /* ── Divider ─────────────────────── */
      .fd-divider {
        display: flex; align-items: center; gap: 12px;
        margin-bottom: 1.2rem;
      }
      .fd-divider-line {
        flex: 1; height: 1px;
        background: rgba(129,140,248,.15);
      }
      [data-theme="light"] .fd-divider-line { background: rgba(99,102,241,.15); }
      .fd-divider-text {
        font-size: .78rem;
        color: var(--color-muted-foreground);
        white-space: nowrap;
      }

      /* ── OAuth buttons ───────────────── */
      .fd-btn-oauth {
        width: 100%;
        padding: 12px;
        border-radius: 11px;
        font-size: .9rem;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        background: rgba(255,255,255,.04);
        border: 1px solid rgba(129,140,248,.18);
        color: var(--color-foreground);
        transition: background .2s, border-color .2s, transform .2s;
        margin-bottom: 9px;
      }
      [data-theme="light"] .fd-btn-oauth {
        background: rgba(238,242,255,.5);
        border-color: rgba(99,102,241,.2);
      }
      .fd-btn-oauth:hover {
        background: rgba(129,140,248,.10);
        border-color: rgba(129,140,248,.35);
        transform: translateY(-1px);
      }

      /* ── Error ───────────────────────── */
      .fd-error {
        padding: 11px 15px;
        border-radius: 10px;
        background: rgba(239,68,68,.10);
        border: 1px solid rgba(239,68,68,.22);
        color: #FCA5A5;
        font-size: .875rem;
        margin-bottom: 1rem;
        animation: fd-fade-up .3s ease;
      }
      [data-theme="light"] .fd-error { background: rgba(239,68,68,.06); color: #DC2626; }

      /* ── Footer ──────────────────────── */
      .fd-footer-txt {
        text-align: center;
        font-size: .875rem;
        color: var(--color-muted-foreground);
        margin-top: 1.5rem;
      }
      .fd-footer-txt a {
        color: #818CF8; font-weight: 600;
        text-decoration: none; transition: color .15s;
      }
      .fd-footer-txt a:hover { color: #A78BFA; text-decoration: underline; }

      /* ── Keyframes ───────────────────── */
      @keyframes fd-orb-breathe {
        0%, 100% { transform: translateY(-50%) scale(1);    opacity: .85; }
        50%       { transform: translateY(-50%) scale(1.13); opacity: 1;   }
      }
      @keyframes fd-ring-spin {
        to { transform: translate(-50%,-50%) rotate(360deg); }
      }
      @keyframes fd-twinkle {
        0%, 100% { opacity: .28; transform: scale(1); }
        50%       { opacity: .85; transform: scale(1.45); }
      }
      @keyframes fd-text-shimmer {
        0%   { background-position: 0% center; }
        100% { background-position: 300% center; }
      }
      @keyframes fd-fade-up {
        from { opacity: 0; transform: translateY(14px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      @media (prefers-reduced-motion: reduce) {
        .fd-orb, .fd-ring-a, .fd-ring-b, .fd-ring-c,
        .fd-shimmer, .fd-particle { animation: none !important; }
      }
    `}</style>
  );
}

// ─── Brand Panel ─────────────────────────────────────────────────────────────
function BrandPanel() {
  return (
    <div className="fd-brand">
      <video
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.13, zIndex: 0 }}
        autoPlay muted loop playsInline
      >
        <source src="/videos/auth-bg.mp4" type="video/mp4" />
      </video>

      <div className="fd-orb" />
      <div className="fd-ring fd-ring-a" />
      <div className="fd-ring fd-ring-b" />
      <div className="fd-ring fd-ring-c" />

      {PARTICLES.map(p => (
        <div
          key={p.id}
          className="fd-particle"
          style={{
            left: `${p.x}%`, top: `${p.y}%`,
            width: `${p.s + 1}px`, height: `${p.s + 1}px`,
            background: PARTICLE_COLORS[p.id % PARTICLE_COLORS.length],
            "--pdur": `${p.dur}s`,
            "--pdel": `${p.d}s`,
          } as React.CSSProperties}
        />
      ))}

      <div className="fd-brand-content">
        <img
          src="/photos/auth-logo.png"
          alt="FlexiData AI"
          className="fd-logo-mark"
          style={{ objectFit: "contain", width: 50, height: 50 }}
        />

        <div className="fd-brand-wordmark">FlexiData AI</div>

        <h1 className="fd-hero-h1">
          Your files,<br />
          <span className="fd-shimmer">finally understood.</span>
        </h1>

        <p className="fd-hero-sub">
          Upload documents, ask questions, and get intelligent answers powered by AI — from PDFs to spreadsheets.
        </p>

        <div>
          {[
            { icon: "doc", text: "Parses PDF, Word, Excel, images & more" },
            { icon: "agent", text: "Create AI agents trained on your documents" },
            { icon: "multi", text: "Multi-provider AI with automatic failover" },
          ].map((f, i) => (
            <div key={i} className="fd-pill" style={{ animationDelay: `${0.1 + i * 0.15}s` }}>
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                {f.icon === "doc" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                )}
                {f.icon === "agent" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <circle cx="12" cy="5" r="2" />
                    <path d="M12 7v4" />
                    <line x1="8" y1="16" x2="8" y2="16" />
                    <line x1="16" y1="16" x2="16" y2="16" />
                  </svg>
                )}
                {f.icon === "multi" && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                )}
              </span>
              {f.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}

// ─── Login Form ───────────────────────────────────────────────────────────────
function LoginForm() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const router       = useRouter();
  const searchParams = useSearchParams();
  const redirectTo   = searchParams.get("redirectTo") || "/dashboard";
  const supabase     = createClient();

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setError(error.message); setLoading(false); return; }
    router.push(redirectTo);
    router.refresh();
  }

  async function handleOAuth(provider: "google" | "github") {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${redirectTo}` },
    });
    if (error) setError(error.message);
  }

  return (
    <div className="fd-card-inner">
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

      <h2 className="fd-card-title">Welcome back</h2>
      <p className="fd-card-sub">Sign in to your workspace</p>

      {/* OAuth */}
      <button type="button" className="fd-btn-oauth" onClick={() => handleOAuth("google")}>
        <GoogleIcon /> Continue with Google
      </button>
      <button type="button" className="fd-btn-oauth" onClick={() => handleOAuth("github")}>
        <GitHubIcon /> Continue with GitHub
      </button>

      {/* Divider */}
      <div className="fd-divider" style={{ margin: "1.2rem 0" }}>
        <div className="fd-divider-line" />
        <span className="fd-divider-text">or continue with email</span>
        <div className="fd-divider-line" />
      </div>

      {/* Error */}
      {error && <div className="fd-error" role="alert">{error}</div>}

      {/* Email form */}
      <form onSubmit={handleEmailLogin}>
        <input
          type="email"
          placeholder="Email address"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="fd-input"
        />
        <div style={{ position: "relative" }}>
          <input
            type={showPass ? "text" : "password"}
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="fd-input"
            style={{ paddingRight: "42px" }}
          />
          <button
            type="button"
            onClick={() => setShowPass(!showPass)}
            style={{
              position: "absolute",
              right: "12px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--color-muted-foreground)",
              padding: "4px",
              display: "flex",
              alignItems: "center",
            }}
            tabIndex={-1}
          >
            {showPass ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M14.12 14.12a3 3 0 11-4.24-4.24" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        <button type="submit" disabled={loading} className="fd-btn-primary">
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </form>

      <p className="fd-footer-txt">
        No account yet?{" "}
        <Link href="/signup">Create one free</Link>
      </p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function LoginPage() {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.setAttribute("dir", "ltr");
  }, []);

  return (
    <>
      <AuthStyles />
      <div className="fd-auth-root">
        <BrandPanel />
        <main className="fd-form-side">
          <div className="fd-card">
            <Suspense>
              <LoginForm />
            </Suspense>
          </div>
        </main>
      </div>
    </>
  );
}