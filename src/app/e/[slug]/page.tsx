import "server-only";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicEventPageState } from "@/lib/public-event";
import PublicEventPortalClient from "./PublicEventPortalClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const pageState = await getPublicEventPageState(slug);
  if (pageState.state === "not_found") {
    return { title: "Event Not Found" };
  }
  if (pageState.state === "unavailable") {
    return { title: "Event Unavailable | cert-saas" };
  }
  const { event } = pageState;
  return {
    title: `${event.title} — ${event.orgName} | E-Certificate Portal`,
    description:
      event.subtitle ||
      `Download your official e-certificate from ${event.orgName}.`,
  };
}

export default async function PublicEventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const pageState = await getPublicEventPageState(slug);

  if (pageState.state === "not_found") {
    notFound();
  }

  if (pageState.state === "unavailable") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-12 text-slate-900">
        <section
          role="alert"
          className="mx-auto w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-2xl text-red-600 ring-1 ring-red-100">
            🚫
          </div>
          <h1 className="text-lg font-bold text-slate-900">
            This event page is currently unavailable
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Certificates for <strong>{pageState.title}</strong> are currently
            unavailable because the issuing organization&apos;s account is
            suspended.
          </p>
        </section>
      </main>
    );
  }

  const { event } = pageState;

  return (
    <main className="flex min-h-dvh flex-col justify-between bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-10 text-slate-900 sm:py-14">
      <div className="mx-auto w-full max-w-3xl space-y-8 my-auto">
        {/* Event & Organization Header */}
        <header className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-600">
            {event.orgName}
          </p>
          <h1 className="mt-2 text-2xl font-bold leading-tight text-slate-900 sm:text-3xl">
            {event.title}
          </h1>
          {event.subtitle && (
            <p className="mt-1.5 text-sm text-slate-600 sm:text-base">
              {event.subtitle}
            </p>
          )}
          {event.eventDate && (
            <p className="mt-1 text-xs font-medium text-slate-500">
              Event date: {event.eventDate}
            </p>
          )}
        </header>

        {/* Main Content: Friendly "Not Available Yet" vs Lookup/Download Portal */}
        {!event.released ? (
          <section
            role="status"
            className="mx-auto max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-2xl text-indigo-600 ring-1 ring-indigo-100">
              ⏳
            </div>
            <h2 className="text-lg font-bold text-slate-900">
              Certificates are not available yet
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              <strong>{event.orgName}</strong> has not released certificates for{" "}
              <strong>{event.title}</strong> yet. Please check back soon.
            </p>
            {(event.contactEmail || event.contactPhone) && (
              <div className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">
                <p>Questions? Contact the organizer:</p>
                <div className="mt-1.5 flex flex-wrap items-center justify-center gap-3 font-semibold text-indigo-600">
                  {event.contactEmail && (
                    <a href={`mailto:${event.contactEmail}`} className="hover:underline">
                      {event.contactEmail}
                    </a>
                  )}
                  {event.contactPhone && (
                    <a href={`tel:${event.contactPhone}`} className="hover:underline">
                      {event.contactPhone}
                    </a>
                  )}
                </div>
              </div>
            )}
          </section>
        ) : (
          <PublicEventPortalClient
            slug={event.slug}
            identifierLabel={event.identifierLabel}
            requireNameMatch={event.requireNameMatch}
            contactEmail={event.contactEmail}
            contactPhone={event.contactPhone}
          />
        )}
      </div>

      {/* Footer with organizer contact info */}
      <footer className="mx-auto mt-12 w-full max-w-3xl text-center text-xs text-slate-500">
        {(event.contactEmail || event.contactPhone) && (
          <p className="mb-1.5">
            Need help with your certificate? Contact{" "}
            <strong className="text-slate-700">{event.orgName}</strong>
            {event.contactEmail ? (
              <>
                {" · "}
                <a
                  href={`mailto:${event.contactEmail}`}
                  className="font-semibold text-indigo-600 hover:underline"
                >
                  {event.contactEmail}
                </a>
              </>
            ) : null}
            {event.contactPhone ? (
              <>
                {" · "}
                <a
                  href={`tel:${event.contactPhone}`}
                  className="font-semibold text-indigo-600 hover:underline"
                >
                  {event.contactPhone}
                </a>
              </>
            ) : null}
          </p>
        )}
        <p className="text-[11px] text-slate-400">
          Powered by cert-saas · Verified digital certificates
        </p>
      </footer>
    </main>
  );
}
