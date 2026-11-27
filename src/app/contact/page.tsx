import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell from "@/components/marketing/MarketingShell";
import { getSupportWhatsappInfo } from "@/lib/feature-flags";

export const metadata: Metadata = {
  title: "Contact Us",
  description:
    "Reach the CertSaaS team on WhatsApp or email for pilot onboarding, custom event packages, or data requests.",
  alternates: {
    canonical: "/contact",
  },
};

export default function ContactPage() {
  const whatsapp = getSupportWhatsappInfo();
  const supportEmail =
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || "support@certsaas.pk";

  return (
    <MarketingShell>
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-14 sm:px-6 sm:py-20">
        <header className="text-center">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Contact Our Team
          </h1>
          <p className="mt-3 text-base text-slate-700">
            Whether you&apos;re onboarding a university society for the pilot,
            planning a multi-track conference, or requesting data assistance,
            we&apos;re quick on WhatsApp.
          </p>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          <section className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
            <div>
              <span className="inline-block rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-emerald-800">
                Fastest Response
              </span>
              <h2 className="mt-3 text-lg font-bold text-slate-900">
                WhatsApp Support
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                Message us directly for pilot approvals, package recommendations,
                or live event troubleshooting.
              </p>
              <p className="mt-3 font-mono text-sm font-bold text-slate-900">
                {whatsapp.displayNumber}
              </p>
            </div>

            <a
              href={whatsapp.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 block rounded-xl bg-emerald-700 px-4 py-3 text-center text-sm font-bold text-white shadow-xs transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Chat on WhatsApp →
            </a>
          </section>

          <section className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
            <div>
              <span className="inline-block rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-indigo-800">
                Email &amp; Privacy Requests
              </span>
              <h2 className="mt-3 text-lg font-bold text-slate-900">
                Email Us
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                For institutional procurement, formal invoices, or privacy &amp;
                data deletion inquiries.
              </p>
              <p className="mt-3 font-mono text-sm font-bold text-slate-900">
                {supportEmail}
              </p>
            </div>

            <a
              href={`mailto:${supportEmail}`}
              className="mt-6 block rounded-xl border border-slate-300 bg-white px-4 py-3 text-center text-sm font-bold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Send Email
            </a>
          </section>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xs">
          <h2 className="text-base font-bold text-slate-900">
            Looking for setup instructions?
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            Browse our step-by-step guides covering templates, name placement,
            CSV imports, typo fixes, and download resets.
          </p>
          <Link
            href="/help"
            className="mt-4 inline-block rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white transition hover:bg-indigo-700"
          >
            Open Help Guides →
          </Link>
        </section>
      </div>
    </MarketingShell>
  );
}
