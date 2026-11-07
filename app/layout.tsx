import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Raw — your private workspace",
  description: "A free beta for your projects, prompts and community. Your own account. Your own workspace.",
  manifest: '/manifest.webmanifest',
  appleWebApp: {capable:true,title:'Raw',statusBarStyle:'black-translucent'},
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: '/raw-192.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-GB">
      <body className="antialiased">{children}</body>
    </html>
  );
}
