import "server-only";

import { headers } from "next/headers";
import Link from "next/link";
import { lookupCertificateByVerifyCode } from "@/lib/public-verify";
import { clientIpFromHeaders, enforceRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export default async function PublicVerifyCertificatePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const h = await headers();
  const ip = clientIpFromHeaders(h);
  const rl = await enforceRateLimit(`pub:verify-page:ip:${ip}`, 25, 60_000);

  if (!rl.ok) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12 text-slate-900">
        <section className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-bold text-slate-900">
            Too Many Verification Requests
          </h1>
          <p className="mt-2 text-xs text-slate-600">
            Please wait {rl.retryAfterSec} seconds and refresh the page.
          </p>
        </section>
      </main>
    );
  }

  const result = await lookupCertificateByVerifyCode(code);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-12 text-slate-900">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        {result.status === "valid" ? (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-2xl text-emerald-600 ring-1 ring-emerald-200">
              ✓
            </div>
            <div>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
                Verified Authentic Certificate
              </span>
              <h1 className="mt-3 text-2xl font-bold text-slate-900">
                {result.certificate.recipientName}
              </h1>
              <p className="mt-1 text-sm font-medium text-indigo-700">
                {result.certificate.certificateLabel}
              </p>
            </div>

            <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-2 text-left text-xs">
              <div className="flex justify-between py-2">
                <dt className="font-semibold text-slate-500">Event</dt>
                <dd className="font-semibold text-slate-900">
                  {result.certificate.eventTitle}
                </dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="font-semibold text-slate-500">Issued By</dt>
                <dd className="font-semibold text-slate-900">
                  {result.certificate.organizationName}
                </dd>
              </div>
              {result.certificate.eventDate && (
                <div className="flex justify-between py-2">
                  <dt className="font-semibold text-slate-500">Event Date</dt>
                  <dd className="text-slate-800">
                    {result.certificate.eventDate}
                  </dd>
                </div>
              )}
              <div className="flex justify-between py-2">
                <dt className="font-semibold text-slate-500">Verify Code</dt>
                <dd className="font-mono font-bold text-slate-900">
                  {result.certificate.verifyCode}
                </dd>
              </div>
            </dl>

            <Link
              href={`/e/${result.certificate.eventSlug}`}
              className="inline-block text-xs font-semibold text-indigo-600 hover:underline"
            >
              Visit Event Portal →
            </Link>
          </div>
        ) : result.status === "unavailable" ? (
          <div className="space-y-3 text-center">
            <h1 className="text-lg font-bold text-slate-900">
              Verification Currently Unavailable
            </h1>
            <p className="text-xs text-slate-600">
              This issuing organization&apos;s portal is currently unavailable.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-xl text-red-600 ring-1 ring-red-200">
              ✕
            </div>
            <h1 className="text-lg font-bold text-slate-900">
              Certificate Not Found
            </h1>
            <p className="text-xs text-slate-600">
              No active verified certificate matches code{" "}
              <code className="font-mono font-semibold">
                {String(code).slice(0, 32)}
              </code>
              .
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
