import type { Metadata, Viewport } from "next";
import "./globals.css";
import RegisterSW from "./register-sw";

export const metadata: Metadata = {
  title: "買い物リスト",
  description: "Notion の買い物リストを見やすく整理(会場オフライン対応)",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "買い物リスト",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
