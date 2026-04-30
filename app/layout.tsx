import type { Metadata, Viewport } from "next";
import "./globals.css";
import PWARegister from "@/components/PWARegister";
import AuthHealer from "@/components/AuthHealer";

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
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <AuthHealer />
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
