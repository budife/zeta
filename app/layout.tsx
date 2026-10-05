import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hand Frame → Vector Character",
  description:
    "Frame a selection with both hands, detect the face inside it, and drop a vector character over it — all realtime in the browser.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
