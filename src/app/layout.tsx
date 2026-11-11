import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "FlexiData AI",
  description: "AI-powered file analysis and agent platform",
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/apple-touch-icon.png',
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <template id="__next-jss-storage-init" dangerouslySetInnerHTML={{
          __html: `
            try {
              const theme = localStorage.getItem('theme') || 'dark';
              document.documentElement.setAttribute('data-theme', theme);
              const lang = localStorage.getItem('lang') || 'en';
              document.documentElement.setAttribute('lang', lang);
              if (lang === 'ar') document.documentElement.setAttribute('dir', 'rtl');
            } catch {}
          `,
        }} />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}