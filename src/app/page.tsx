import "server-only";

import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell from "@/components/marketing/MarketingShell";
import PricingCardsSection from "@/components/pricing/PricingCardsSection";
import { getCurrentUser } from "@/lib/auth";
import {
  getSupportWhatsappInfo,
  isPilotBannerEnabled,
} from "@/lib/feature-flags";
import { getPricingAndPresets } from "@/lib/pricing-server";

// Dynamic so changing pricing_config updates every price on / without redeploying
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Issue Certificates Online, No Printing | CertSaaS",
  description:
    "Upload your certificate template and attendee list, let attendees download verified PDFs with QR codes, and track every download in real time.",
  alternates: {
    canonical: "/",
  },
};

const HOW_IT_WORKS_STEPS = [
  {
    step: "1",
    title: "Upload template and attendee list",
    description:
      "Upload your custom PDF or image design, position the recipient name visually, and import up to 5,000 attendees from CSV or Excel in seconds.",
  },
  {
    step: "2",
    title: "Attendees download",
    description:
      "Share one clean event link. Attendees enter their roll number or ID, preview their certificate, and download a crisp QR-verified PDF on any phone or laptop.",
  },
  {
    step: "3",
    title: "You track who downloaded",
    description:
      "See live counts of downloaded vs. pending certificates, copy reminder emails in one click, reset limits when needed, and export clean Excel reports.",
  },
];

const FEATURE_HIGHLIGHTS = [
  {
    icon: "🔒",
    title: "One-time or limited downloads",
    description:
      "Enforce 1-download, 3-download, or unlimited limits atomically on the server so parallel clicks can never bypass your cap — with instant 1-click admin resets.",
  },
  {
    icon: "📱",
    title: "Instant QR verification",
    description:
      "Stamp a scannable QR code and unique verification URL (/verify/CODE) onto every PDF so employers and universities can verify authenticity in one scan.",
  },
  {
    icon: "🎨",
    title: "Visual name editor",
    description:
      "Drag and resize the recipient name box directly on your PDF or PNG artwork. Long names automatically scale down to stay cleanly inside your borders.",
  },
  {
    icon: "📊",
    title: "Smart CSV & Excel import",
    description:
      "Upload messy .csv or .xlsx spreadsheets with automatic delimiter & UTF-8 BOM detection, column mapping, row-by-row validation, and downloadable error reports.",
  },
];

const FAQS = [
  {
    q: "How does pilot approval work?",
    a: "Choose any preset or custom package below and submit your organization details with your WhatsApp number. Our team reviews and activates your workspace — no payment screenshot is needed during the pilot.",
  },
  {
    q: "How long can attendees download their certificates?",
    a: "Certificates stay downloadable for 12 months after release — even after your package's event-creation window expires.",
  },
  {
    q: "What if we have more attendees than expected for an event?",
    a: "You can request a certificate top-up for any existing event right from your Billing page, priced per additional certificate.",
  },
  {
    q: "Can we fix a misspelled name after releasing an event?",
    a: "Yes. Edit the attendee's name in your dashboard, leave an optional note explaining the correction, and reset their download count if they already downloaded the old version.",
  },
  {
    q: "Who owns our attendee data, and can we delete it?",
    a: "Your organization owns 100% of your attendee records and templates. We process them strictly on your behalf, never sell data, and give you self-service 'Delete this event's data' and 'Delete my organization' controls.",
  },
];

export default async function HomePage() {
  const [{ pricingConfig, presets }, user] = await Promise.all([
    getPricingAndPresets(),
    getCurrentUser(),
  ]);

  const showPilotBanner = isPilotBannerEnabled();
  const whatsapp = getSupportWhatsappInfo();
  const isSignedIn = Boolean(user);

  return (
    <MarketingShell isSignedIn={isSignedIn}>
      {/* 1. HERO */}
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <p className="inline-flex items-center rounded-full bg-indigo-50 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-indigo-800 ring-1 ring-indigo-200">
            For Universities, Student Societies &amp; Conferences
          </p>

          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">
            Issue certificates online, no printing
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-slate-700 sm:text-lg">
            Stop manually editing slides, printing stacks of paper, or emailing
            hundreds of attachments. Upload your design and attendee list once —
            let recipients verify and download their own PDFs in seconds.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5">
            <a
              href="#pricing"
              className="rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Choose a Plan →
            </a>
            <Link
              href="/e/sample-event"
              className="rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-bold text-slate-800 shadow-2xs transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Try Live Sample Event
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-24 px-4 py-16 sm:px-6 sm:py-20">
        {/* 2. HOW IT WORKS (3 STEPS) */}
        <section aria-labelledby="how-it-works-heading">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="how-it-works-heading"
              className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl"
            >
              How it works in 3 simple steps
            </h2>
            <p className="mt-2 text-sm text-slate-700 sm:text-base">
              Go from a blank certificate PDF and spreadsheet to a live download
              portal in under five minutes.
            </p>
          </div>

          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {HOW_IT_WORKS_STEPS.map((item) => (
              <li
                key={item.step}
                className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-sm font-extrabold text-white">
                  {item.step}
                </span>
                <h3 className="mt-4 text-base font-bold text-slate-900">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">
                  {item.description}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* 3. FEATURE HIGHLIGHTS */}
        <section aria-labelledby="features-heading">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="features-heading"
              className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl"
            >
              Everything organizers need for reliable distribution
            </h2>
            <p className="mt-2 text-sm text-slate-700 sm:text-base">
              Purpose-built controls that prevent spoofing, messy imports, and
              support headaches.
            </p>
          </div>

          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {FEATURE_HIGHLIGHTS.map((f) => (
              <article
                key={f.title}
                className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs"
              >
                <div
                  aria-hidden="true"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-lg ring-1 ring-indigo-100"
                >
                  {f.icon}
                </div>
                <h3 className="mt-4 text-base font-bold text-slate-900">
                  {f.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                  {f.description}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* 4. LIVE DEMO CALLOUT */}
        <section
          aria-labelledby="demo-heading"
          className="rounded-3xl bg-slate-900 p-8 text-white shadow-md sm:p-10"
        >
          <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-center">
            <div className="max-w-2xl">
              <span className="rounded-full bg-indigo-500/30 px-3 py-1 text-xs font-bold uppercase tracking-wider text-indigo-100">
                Interactive Live Demo
              </span>
              <h2
                id="demo-heading"
                className="mt-3 text-2xl font-extrabold text-white sm:text-3xl"
              >
                Experience the student download flow right now
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">
                Open our sample symposium portal and enter registration ID{" "}
                <code className="rounded bg-slate-800 px-2 py-0.5 font-mono font-bold text-white">
                  DEMO-001
                </code>{" "}
                to preview and download a real QR-stamped PDF certificate, or
                inspect a live verification badge.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/e/sample-event"
                className="rounded-xl bg-white px-5 py-3 text-sm font-bold text-slate-950 shadow-xs transition hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Open Sample Event →
              </Link>
              <Link
                href="/verify/DEMOCERT2026"
                className="rounded-xl border border-slate-700 bg-slate-800 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Verify Sample QR
              </Link>
            </div>
          </div>
        </section>

        {/* 5. PRICING SECTION (4 CARDS) */}
        <section id="pricing" className="scroll-mt-20">
          <PricingCardsSection
            pricingConfig={pricingConfig}
            presets={presets}
            isSignedIn={isSignedIn}
            showPilotBanner={showPilotBanner}
          />
        </section>

        {/* 6. FAQ */}
        <section aria-labelledby="faq-heading" className="mx-auto max-w-3xl">
          <h2
            id="faq-heading"
            className="text-center text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl"
          >
            Frequently Asked Questions
          </h2>

          <div className="mt-8 space-y-3">
            {FAQS.map((item) => (
              <details
                key={item.q}
                className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600">
                  <span>{item.q}</span>
                  <span
                    aria-hidden="true"
                    className="text-indigo-700 transition group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-700">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* 7. CONTACT (WHATSAPP LINK) */}
        <section
          id="contact"
          aria-labelledby="contact-heading"
          className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-2xs sm:p-10"
        >
          <h2
            id="contact-heading"
            className="text-2xl font-extrabold text-slate-900"
          >
            Questions or organizing a campus event?
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-700">
            Message us directly on WhatsApp for pilot onboarding, custom volume
            packages, or setup assistance.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <a
              href={whatsapp.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-5 py-3 text-sm font-bold text-white shadow-xs transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              <span>Chat on WhatsApp ({whatsapp.displayNumber})</span>
            </a>
            <Link
              href="/help"
              className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Read Step-by-Step Guides
            </Link>
          </div>
        </section>
      </div>
    </MarketingShell>
  );
}
