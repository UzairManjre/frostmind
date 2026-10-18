import type { Metadata } from "next";
import { Barlow_Condensed, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { NavBar } from "@/components/NavBar";

// Display: condensed light headings, per the brand deck.
const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  weight: ["300", "400", "500"],
  subsets: ["latin"],
});

// Body: SF Pro is used natively where available (see globals.css --font-sans); Inter is the
// web-loaded stand-in for everything else.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FROSTMIND Admin",
  description: "FROSTMIND cold-chain fleet admin panel",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${barlowCondensed.variable} ${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-ink-950 text-peri-50">
        <AuthProvider>
          <div className="flex min-h-screen flex-col lg:flex-row">
            <NavBar />
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
