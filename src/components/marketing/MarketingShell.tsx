import type { ReactNode } from "react";
import Link from "next/link";
import { getSupportWhatsappInfo } from "@/lib/feature-flags";

export interface MarketingShellProps {
  isSignedIn?: boolean;
  children: ReactNode;
}

export default function MarketingShell({
  isSignedIn = false,
  children,
}: MarketingShellProps) {
  const whatsapp = getSupportWhatsappInfo();

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 text-slate-900">
      {/* Keyboard Skip-to-Content Link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-indigo-600 focus:px-4 focus:py-2.5 focus:text-sm focus:font-bold focus:text-white focus:shadow-lg"
      >
        Skip to main content
      </a>

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white shadow-xs"
              >
                📜
              </span>
              <span className="text-base font-extrabold tracking-tight text-slate-900">
                CertSaaS
              </span>
            </Link>

            <nav
              aria-label="Primary"
              className="hidden items-center gap-1 md:flex"
            >
              <Link
                href="/pricing"
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600"
              >
                Pricing
              </Link>
              <Link
                href="/e/sample-event"
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600"
              >
                Live Demo
              </Link>
              <Link
                href="/help"
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600"
              >
                Help Guides
              </Link>
              <Link
                href="/contact"
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600"
              >
                Contact
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2.5">
            {isSignedIn ? (
              <Link
                href="/dashboard"
                className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm"
              >
                Open Dashboard →
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white"
                >
                  📜
                </span>
                <span className="text-sm font-extrabold text-slate-900">
                  CertSaaS
                </span>
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-slate-600">
                Issue verified digital PDF certificates online — built for
                universities, student societies, conferences, and training
                institutes.
              </p>
            </div>

            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                Product
              </h2>
              <ul className="mt-3 space-y-2 text-xs font-medium text-slate-700">
                <li>
                  <Link href="/pricing" className="hover:text-indigo-700 hover:underline">
                    Pricing &amp; Packages
                  </Link>
                </li>
                <li>
                  <Link href="/e/sample-event" className="hover:text-indigo-700 hover:underline">
                    Sample Event Demo
                  </Link>
                </li>
                <li>
                  <Link href="/verify/DEMOCERT2026" className="hover:text-indigo-700 hover:underline">
                    Sample QR Verification
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                Resources
              </h2>
              <ul className="mt-3 space-y-2 text-xs font-medium text-slate-700">
                <li>
                  <Link href="/help" className="hover:text-indigo-700 hover:underline">
                    Step-by-Step Help Guides
                  </Link>
                </li>
                <li>
                  <Link href="/contact" className="hover:text-indigo-700 hover:underline">
                    Contact Us
                  </Link>
                </li>
                <li>
                  <a
                    href={whatsapp.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-indigo-700 hover:underline"
                  >
                    WhatsApp ({whatsapp.displayNumber})
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                Legal &amp; Privacy
              </h2>
              <ul className="mt-3 space-y-2 text-xs font-medium text-slate-700">
                <li>
                  <Link href="/privacy" className="hover:text-indigo-700 hover:underline">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="hover:text-indigo-700 hover:underline">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-10 border-t border-slate-200 pt-6 text-xs text-slate-600">
            © {new Date().getUTCFullYear()} CertSaaS. Organizations own their
            attendee data; no data is ever sold.
          </div>
        </div>
      </footer>
    </div>
  );
}
