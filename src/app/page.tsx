import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getPricingAndPresets } from "@/lib/pricing-server";
import LandingPricingCalculator from "./LandingPricingCalculator";

// Always compute prices dynamically from public.pricing_config without redeploying
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [{ pricingConfig, presets }, user] = await Promise.all([
    getPricingAndPresets(),
    getCurrentUser(),
  ]);

  return (
    <div className="min-h-dvh bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900">
      {/* Top Navbar */}
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur-xs">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white shadow-xs">
              📜
            </span>
            <div>
              <span className="block text-sm font-bold tracking-tight text-slate-900">
                cert-saas
              </span>
              <span className="block text-[11px] font-medium text-slate-500">
                Verified Digital Certificates
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {user ? (
              <Link
                href="/dashboard"
                className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-indigo-700"
              >
                Open Dashboard →
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-indigo-700"
                >
                  Create Organization
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl space-y-16 px-4 py-12 sm:px-6 sm:py-16">
        {/* Hero */}
        <section className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-indigo-700 ring-1 ring-indigo-200">
            Built for Universities, Societies &amp; Conferences
          </span>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
            Issue tamper-evident PDF certificates in minutes
          </h1>
          <p className="mt-4 text-base leading-relaxed text-slate-600 sm:text-lg">
            Upload your custom PDF or image design, import up to 5,000 attendees
            from CSV or Excel, stamp instant verification QR codes, and share a
            fast self-service download portal.
          </p>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={user ? "/dashboard" : "/signup"}
              className="rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700"
            >
              {user ? "Go to Dashboard →" : "Create Organization Account →"}
            </Link>
            <a
              href="#pricing"
              className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-50"
            >
              Calculate Pricing
            </a>
          </div>
        </section>

        {/* Live Pricing Section */}
        <section id="pricing" className="scroll-mt-8">
          <LandingPricingCalculator
            pricingConfig={pricingConfig}
            presets={presets}
            isSignedIn={Boolean(user)}
          />
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white py-8 text-center text-xs text-slate-500">
        <p>
          cert-saas · Multi-tenant E-Certificate &amp; QR Verification Platform
        </p>
      </footer>
    </div>
  );
}
