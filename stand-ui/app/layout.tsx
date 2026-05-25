import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { decodeSession, SESSION_COOKIE_NAME } from "@/app/api/_lib/session";
import UserMenu  from "@/app/components/UserMenu";
import RoleBadge from "@/app/components/RoleBadge";
import ModeBadge from "@/app/components/ModeBadge";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Prism",
  description: "Data standardization platform",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = sessionValue ? await decodeSession(sessionValue) : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`} suppressHydrationWarning>
        {session && (
          <>
            {/* Top-left: Prism home link */}
            <Link
              href="/home"
              style={{
                position:    'fixed',
                top:         16,
                left:        16,
                zIndex:      1000,
                display:     'flex',
                alignItems:  'center',
                gap:         8,
                textDecoration: 'none',
              }}
            >
              <svg width="28" height="22" viewBox="0 0 28 22" fill="none" aria-hidden="true">
                <polygon points="0,0 0,22 14,11" fill="#1A1A2E" />
                <polygon points="28,0 28,22 14,11" fill="#378ADD" />
                <circle cx="14" cy="11" r="1.4" fill="white" />
              </svg>
              <span
                style={{
                  fontSize:   15,
                  fontWeight: 600,
                  color:      '#1A1A2E',
                  letterSpacing: '-0.2px',
                }}
              >
                Prism
              </span>
            </Link>

            {/* Top-right: mode badge + role badge + user menu */}
            <div
              style={{
                position:   'fixed',
                top:        16,
                right:      16,
                zIndex:     1000,
                display:    'flex',
                alignItems: 'center',
                gap:        8,
              }}
            >
              <ModeBadge />
              <RoleBadge role={session.role ?? 'user'} />
              <UserMenu
                name={session.name}
                email={session.email}
                pictureUrl={session.pictureUrl}
              />
            </div>
          </>
        )}
        {children}
      </body>
    </html>
  );
}
