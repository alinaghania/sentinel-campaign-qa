import type { Metadata } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Sentinel — Email campaign QA",
  description:
    "Analyse multi-agents des briefs et emails de campagne SFMC avant envoi",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} ${playfair.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">
        <header className="sticky top-0 z-40 border-b border-bd bg-bg/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-6">
            <Link href="/" className="doc-title text-[24px] uppercase tracking-[0.04em]">
              Sentinel
            </Link>
            {/* QUATRE entrées, pas cinq : /brands et /brief-template sont sortis
                de la barre à la demande de la cliente. Ils ne sont PAS morts —
                /guide les porte tous les deux, sans condition, et c'est la seule
                entrée qui ne dépend ni d'un état de campagne ni d'un pas du
                parcours de création. Retirer un lien de la barre sans lui laisser
                d'entrée ailleurs fabrique une page que personne ne retrouve. */}
            <nav className="ml-auto flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.16em]">
              <Link href="/" className="rounded-lg px-3 py-1.5 hover:bg-panel hover:text-fg">
                Campaigns
              </Link>
              <Link href="/inbox" className="rounded-lg px-3 py-1.5 hover:bg-panel hover:text-fg">
                Inbox
              </Link>
              <Link href="/rules" className="rounded-lg px-3 py-1.5 hover:bg-panel hover:text-fg">
                Rules
              </Link>
              <Link href="/guide" className="rounded-lg px-3 py-1.5 hover:bg-panel hover:text-fg">
                Guide
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
