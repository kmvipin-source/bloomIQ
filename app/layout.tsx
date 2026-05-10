import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter } from "next/font/google";
import "./globals.css";
import PWARegister from "@/components/PWARegister";
import AuthHealer from "@/components/AuthHealer";
import TwoFactorNudge from "@/components/TwoFactorNudge";
import Toaster from "@/components/Toaster";
import IdleSignOut from "@/components/IdleSignOut";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import PostHogProvider from "@/components/PostHogProvider";

// Premium-clean fonts. Inter is the workhorse; we load common weights
// and let the @theme block in globals.css name it as --font-sans.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "BloomIQ — Smart assessments aligned with Bloom's Taxonomy",
  description:
    "Teachers generate Bloom-aligned MCQs from any content. Students take timed assessments. Everyone sees thinking-level performance, not just scores.",
  applicationName: "BloomIQ",
  appleWebApp: {
    capable: true,
    title: "BloomIQ",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.svg", type: "image/svg+xml", sizes: "192x192" },
      { url: "/icon-512.svg", type: "image/svg+xml", sizes: "512x512" },
    ],
    apple: [{ url: "/icon-192.svg" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#10b981",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning on <html> is required because the inline
    // script mutates data-theme + data-mode BEFORE React renders. Without
    // it, React logs a hydration mismatch warning on every page load.
    // We also keep it on <body> (added in a separate fix) because some
    // browser extensions inject attributes there.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* The pre-hydration init script. Must run synchronously before
            paint to set data-theme + data-mode from localStorage and
            avoid a flash of unthemed content. next/script with
            beforeInteractive runs before hydration, no React-tree
            warning. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <PostHogProvider>
            <AuthHealer />
            {children}
            <TwoFactorNudge />
            <IdleSignOut />
            <Toaster />
            <PWARegister />
            <SpeedInsights />
            <Analytics />
          </PostHogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
