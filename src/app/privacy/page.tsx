import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell from "@/components/marketing/MarketingShell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How CertSaaS protects attendee and organization data: organizations own their data, 12-month post-release retention, self-service deletion, and zero data sold.",
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPolicyPage() {
  return (
    <MarketingShell>
      <article className="mx-auto max-w-3xl space-y-8 px-4 py-14 sm:px-6 sm:py-20">
        <header className="border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Last updated: November 2026
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            1. Data Ownership &amp; Our Role as Processor
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            <strong>Organizations own their attendee data.</strong> When a
            university, society, company, or event organizer uploads certificate
            templates and attendee records (identifiers, full names, optional
            email addresses, and correction notes), that organization remains
            the sole data controller and owner of those records. CertSaaS
            processes attendee data strictly on the organization&apos;s behalf
            solely to generate, deliver, and verify certificates for that event.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            2. No Data Sold — Ever
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            We <strong>never sell, rent, trade, or share</strong> attendee lists,
            email addresses, identifiers, or organization records with
            advertisers, data brokers, or third parties. Public lookup forms
            use generic error messages so outsiders cannot enumerate who
            attended an event, and public QR verification pages reveal only the
            certificate&apos;s validity, recipient name, event title, and
            issuing organization.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            3. Retention of 12 Months After Release
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Once an event is marked as <strong>Released</strong>, its
            certificates remain downloadable by attendees for{" "}
            <strong>12 months after release</strong> (`retention_until`), even if
            the organization&apos;s package window for creating new events has
            ended. After the 12-month retention window, public downloads close
            automatically.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            4. Self-Service Deletion &amp; Deletion on Request
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Organization administrators can permanently erase their data at any
            time without waiting for support:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700">
            <li>
              <strong>Delete this event&apos;s data:</strong> Immediately
              deletes all attendees, issued certificates, uploaded template
              files, and download logs for that event.
            </li>
            <li>
              <strong>Delete my organization:</strong> Permanently deletes your
              entire organization workspace, all events, attendees, private
              storage templates, payment receipts, and audit/download logs.
            </li>
            <li>
              <strong>Deletion on request:</strong> You may also request full or
              individual attendee deletion at any time via our{" "}
              <Link
                href="/contact"
                className="font-semibold text-indigo-700 underline"
              >
                Contact page
              </Link>
              .
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-bold text-slate-900">
            5. Security, IP Hashing &amp; Cookie-Free Analytics
          </h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Certificate templates are stored in private, tenant-isolated buckets
            with short-lived signed URLs. Raw client IP addresses are never
            stored in `download_log` — only keyed cryptographic HMAC hashes used
            for abuse prevention. Essential cookies are used strictly for
            authenticated organizer sessions; optional public traffic analytics
            (when enabled) is 100% cookie-free.
          </p>
        </section>
      </article>
    </MarketingShell>
  );
}
