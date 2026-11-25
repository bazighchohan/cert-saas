"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { PublicCertificateCardItem } from "@/app/api/public/e/[slug]/lookup/route";

function parseFilenameFromHeader(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? null;
}

/**
 * Renders page 1 of the personalized certificate PDF into a crisp PNG data URL
 * so mobile (iOS Safari / Android Chrome) and desktop browsers show a true image preview.
 */
function CertificatePreviewThumbnail({
  slug,
  token,
  certId,
  label,
  pageWidthPt,
  pageHeightPt,
}: {
  slug: string;
  token: string;
  certId: string;
  label: string;
  pageWidthPt: number | null;
  pageHeightPt: number | null;
}) {
  const [imgDataUrl, setImgDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function renderPreviewImage() {
      try {
        const url = `/api/public/e/${encodeURIComponent(slug)}/preview?token=${encodeURIComponent(token)}&certId=${encodeURIComponent(certId)}`;
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;
        const page = await doc.getPage(1);
        if (cancelled) return;

        const baseVp = page.getViewport({ scale: 1 });
        const targetWidth = 760;
        const scale = targetWidth / baseVp.width;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        await page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        }).promise;

        if (!cancelled) {
          setImgDataUrl(canvas.toDataURL("image/png"));
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }

    void renderPreviewImage();
    return () => {
      cancelled = true;
    };
  }, [slug, token, certId]);

  const aspectRatio =
    pageWidthPt && pageHeightPt
      ? `${pageWidthPt} / ${pageHeightPt}`
      : "842 / 595";

  return (
    <div
      className="relative w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
      style={{ aspectRatio }}
    >
      {imgDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgDataUrl}
          alt={`${label} preview`}
          className="h-full w-full object-contain"
        />
      ) : failed ? (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-500">
          Preview ready — click Download below to save your PDF certificate.
        </div>
      ) : (
        <div className="flex h-full items-center justify-center gap-2 p-4 text-xs font-medium text-slate-500">
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent"
            aria-hidden="true"
          />
          <span>Generating preview...</span>
        </div>
      )}
    </div>
  );
}

export default function PublicEventPortalClient({
  slug,
  identifierLabel,
  requireNameMatch,
  contactEmail,
  contactPhone,
}: {
  slug: string;
  identifierLabel: string;
  requireNameMatch: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
}) {
  // Lookup form state
  const [identifier, setIdentifier] = useState("");
  const [fullName, setFullName] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Verified session state
  const [attendeeName, setAttendeeName] = useState<string | null>(null);
  const [verifiedIdentifier, setVerifiedIdentifier] = useState<string | null>(
    null,
  );
  const [lookupToken, setLookupToken] = useState<string | null>(null);
  const [certificates, setCertificates] = useState<
    PublicCertificateCardItem[]
  >([]);

  // Download state per certificate card
  const [downloadingCertId, setDownloadingCertId] = useState<string | null>(
    null,
  );
  const [cardMessages, setCardMessages] = useState<
    Record<string, { tone: "success" | "error"; text: string }>
  >({});

  async function handleLookupSubmit(e: FormEvent) {
    e.preventDefault();
    setLookupError(null);

    if (!identifier.trim()) {
      setLookupError(`Please enter your ${identifierLabel.toLowerCase()}.`);
      return;
    }
    if (requireNameMatch && !fullName.trim()) {
      setLookupError("Please enter your full name.");
      return;
    }

    setLookingUp(true);
    try {
      const res = await fetch(
        `/api/public/e/${encodeURIComponent(slug)}/lookup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: identifier.trim(),
            fullName: fullName.trim(),
          }),
        },
      );

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        attendeeName?: string;
        identifier?: string;
        token?: string;
        certificates?: PublicCertificateCardItem[];
      };

      if (!res.ok || !data.token || !data.certificates) {
        setLookupError(
          data.error ||
            "We couldn’t find a matching certificate record. Please double-check your details and try again.",
        );
        return;
      }

      setAttendeeName(data.attendeeName ?? fullName.trim());
      setVerifiedIdentifier(data.identifier ?? identifier.trim());
      setLookupToken(data.token);
      setCertificates(data.certificates);
      setCardMessages({});
    } catch {
      setLookupError(
        "Unable to connect right now. Please check your internet connection and try again.",
      );
    } finally {
      setLookingUp(false);
    }
  }

  async function handleDownloadCertificate(card: PublicCertificateCardItem) {
    if (!lookupToken) return;

    setDownloadingCertId(card.attendeeCertificateId);
    setCardMessages((prev) => {
      const next = { ...prev };
      delete next[card.attendeeCertificateId];
      return next;
    });

    try {
      const res = await fetch(
        `/api/public/e/${encodeURIComponent(slug)}/download`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: lookupToken,
            attendeeCertificateId: card.attendeeCertificateId,
          }),
        },
      );

      const contentType = res.headers.get("content-type") ?? "";
      if (res.ok && contentType.includes("application/pdf")) {
        const blob = await res.blob();
        const filename =
          parseFilenameFromHeader(res.headers.get("content-disposition")) ??
          `certificate-${card.key}.pdf`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        const newCountHeader = Number(
          res.headers.get("x-new-download-count") ?? card.downloadCount + 1,
        );

        setCertificates((prev) =>
          prev.map((c) => {
            if (c.attendeeCertificateId !== card.attendeeCertificateId) {
              return c;
            }
            const nextCount = Number.isFinite(newCountHeader)
              ? newCountHeader
              : c.downloadCount + 1;
            const reached =
              c.downloadLimit !== null && nextCount >= c.downloadLimit;
            return {
              ...c,
              downloadCount: nextCount,
              limitReached: reached,
            };
          }),
        );

        setCardMessages((prev) => ({
          ...prev,
          [card.attendeeCertificateId]: {
            tone: "success",
            text: "Your certificate PDF has been downloaded.",
          },
        }));
        return;
      }

      const errData = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };

      if (errData.code === "DOWNLOAD_LIMIT_REACHED") {
        setCertificates((prev) =>
          prev.map((c) =>
            c.attendeeCertificateId === card.attendeeCertificateId
              ? { ...c, limitReached: true }
              : c,
          ),
        );
      }

      if (errData.code === "SESSION_EXPIRED") {
        setLookupToken(null);
        setLookupError(
          "Your lookup session timed out. Please enter your details again.",
        );
        return;
      }

      setCardMessages((prev) => ({
        ...prev,
        [card.attendeeCertificateId]: {
          tone: "error",
          text:
            errData.error ||
            "Could not download your certificate. Please try again.",
        },
      }));
    } catch {
      setCardMessages((prev) => ({
        ...prev,
        [card.attendeeCertificateId]: {
          tone: "error",
          text: "Network error while downloading. Please try again.",
        },
      }));
    } finally {
      setDownloadingCertId(null);
    }
  }

  function resetToLookupForm() {
    setLookupToken(null);
    setCertificates([]);
    setAttendeeName(null);
    setVerifiedIdentifier(null);
    setCardMessages({});
    setLookupError(null);
  }

  // STEP 2: Verified attendee -> Certificate preview & download card(s)
  if (lookupToken && certificates.length > 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-xs ring-1 ring-slate-200 sm:px-6">
          <div>
            <p className="text-xs font-medium text-slate-500">
              Registered attendee
            </p>
            <h2 className="text-base font-bold text-slate-900 sm:text-lg">
              {attendeeName}
            </h2>
            <p className="font-mono text-xs text-slate-600">
              {identifierLabel}: {verifiedIdentifier}
            </p>
          </div>
          <button
            type="button"
            onClick={resetToLookupForm}
            className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            ← Look up another
          </button>
        </div>

        <div
          className={`grid grid-cols-1 gap-6 ${
            certificates.length > 1 ? "md:grid-cols-2" : ""
          }`}
        >
          {certificates.map((card) => {
            const isDownloading =
              downloadingCertId === card.attendeeCertificateId;
            const msg = cardMessages[card.attendeeCertificateId];

            return (
              <article
                key={card.attendeeCertificateId}
                className="flex flex-col justify-between rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6"
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-slate-900">
                        {card.label}
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {card.downloadLimit === null
                          ? `Downloaded ${card.downloadCount} time${
                              card.downloadCount === 1 ? "" : "s"
                            }`
                          : `${card.downloadCount} of ${card.downloadLimit} download${
                              card.downloadLimit === 1 ? "" : "s"
                            } used`}
                      </p>
                    </div>

                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                        card.limitReached
                          ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200"
                          : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                      }`}
                    >
                      {card.limitReached ? "Limit Reached" : "Ready"}
                    </span>
                  </div>

                  {/* Preview image */}
                  <CertificatePreviewThumbnail
                    slug={slug}
                    token={lookupToken}
                    certId={card.attendeeCertificateId}
                    label={card.label}
                    pageWidthPt={card.pageWidthPt}
                    pageHeightPt={card.pageHeightPt}
                  />
                </div>

                <div className="mt-5 space-y-3">
                  {msg && (
                    <p
                      role="status"
                      className={`rounded-xl px-3.5 py-2.5 text-xs font-medium ${
                        msg.tone === "success"
                          ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
                          : "bg-red-50 text-red-800 ring-1 ring-red-200"
                      }`}
                    >
                      {msg.text}
                    </p>
                  )}

                  {card.limitReached ? (
                    <div
                      role="region"
                      aria-label="Download limit reached"
                      className="rounded-xl border border-amber-200 bg-amber-50/90 p-4 text-xs text-amber-950"
                    >
                      <p className="font-bold">
                        Download limit reached ({card.downloadCount}/
                        {card.downloadLimit})
                      </p>
                      <p className="mt-1 leading-relaxed text-amber-900">
                        Please contact the event organizer if you need your download limit reset or require another copy:
                      </p>
                      {(contactEmail || contactPhone) && (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {contactEmail && (
                            <a
                              href={`mailto:${contactEmail}`}
                              className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 font-semibold text-indigo-700 ring-1 ring-amber-300 hover:bg-amber-100/50"
                            >
                              ✉️ {contactEmail}
                            </a>
                          )}
                          {contactPhone && (
                            <a
                              href={`tel:${contactPhone}`}
                              className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 font-semibold text-indigo-700 ring-1 ring-amber-300 hover:bg-amber-100/50"
                            >
                              📞 {contactPhone}
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={isDownloading}
                      onClick={() => void handleDownloadCertificate(card)}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-xs transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {isDownloading ? (
                        <>
                          <span
                            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                            aria-hidden="true"
                          />
                          <span>Preparing PDF...</span>
                        </>
                      ) : (
                        <span>⬇ Download PDF Certificate</span>
                      )}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  // STEP 1: Accessible Lookup Form
  return (
    <section className="mx-auto w-full max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
      <form onSubmit={handleLookupSubmit} noValidate className="space-y-5">
        <div>
          <label
            htmlFor="public-identifier"
            className="mb-1.5 block text-sm font-semibold text-slate-800"
          >
            {identifierLabel}
          </label>
          <input
            id="public-identifier"
            name="identifier"
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoComplete="off"
            autoFocus
            disabled={lookingUp}
            placeholder={`Enter your ${identifierLabel.toLowerCase()}`}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 disabled:bg-slate-50"
          />
        </div>

        {requireNameMatch && (
          <div>
            <label
              htmlFor="public-fullname"
              className="mb-1.5 block text-sm font-semibold text-slate-800"
            >
              Full name
            </label>
            <input
              id="public-fullname"
              name="fullName"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              autoComplete="name"
              disabled={lookingUp}
              placeholder="Enter your registered full name"
              className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 disabled:bg-slate-50"
            />
          </div>
        )}

        <div aria-live="polite">
          {lookupError && (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium leading-relaxed text-red-800"
            >
              {lookupError}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={lookingUp}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {lookingUp ? (
            <>
              <span
                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                aria-hidden="true"
              />
              <span>Checking registration...</span>
            </>
          ) : (
            <span>Find My Certificate</span>
          )}
        </button>
      </form>
    </section>
  );
}
