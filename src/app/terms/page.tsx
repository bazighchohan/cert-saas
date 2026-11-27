import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell from "@/components/marketing/MarketingShell";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms of Service for using CertSaaS to issue and verify digital event certificates.",
  alternates: {
    canonical: "/terms",
  },
};

export default function TermsPage() {
  return (
    <MarketingShell>
      <article className="mx-auto max-w-3xl space-y-8 px-4 py-14 sm:px-6 sm:py-20">
        <header className="border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Terms of Service
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Last updated: November 2026
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            1. Organization Accounts &amp; Approval
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Every organization account requires approval before creating or
            releasing events. You must provide accurate organization and contact
            information and have authority to issue certificates on behalf of
            your institution, society, or company.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            2. Acceptable Use &amp; Anti-Spoofing
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            You may only upload templates and issue credentials for genuine
            events run by your organization. Impersonating another university,
            government body, or employer — or issuing fraudulent credentials —
            results in immediate account and public-portal suspension.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            3. Event Packages, Capacity &amp; 12-Month Retention
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Packages grant a fixed number of event slots and a per-event
            certificate capacity within your chosen validity duration (3, 6, or
            12 months). Creating an event consumes one slot; additional
            certificates for an event may be added via approved top-ups.
            Released events remain publicly downloadable for{" "}
            <strong>12 months after release</strong>.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            4. Data Ownership &amp; Account Deletion
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Your organization retains full ownership of your templates and
            attendee lists as detailed in our{" "}
            <Link
              href="/privacy"
              className="font-semibold text-indigo-700 underline"
            >
              Privacy Policy
            </Link>
            . You may export your records or permanently delete any event&apos;s
            data or your entire organization at any time from your dashboard.
          </p>
        </section>
      </article>
    </MarketingShell>
  );
}
