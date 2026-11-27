"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  Modal,
  useToast,
  type DataTableColumn,
} from "@/components/ui";
import { createEventAction } from "@/app/dashboard/events/actions";
import type {
  CreateEventBlockInfo,
  EventSummaryRow,
} from "@/lib/dashboard-data";
import { slugifyEventTitle, validateEventSlug } from "@/lib/event-validation";
import { formatExpiryCountdown } from "@/lib/pricing";

export default function EventsListClient({
  events,
  eventsSlotsUsed,
  eventsSlotsTotal,
  soonestActiveExpiry,
  packageLabel,
  createEventBlock,
}: {
  events: EventSummaryRow[];
  eventsSlotsUsed: number;
  eventsSlotsTotal: number;
  soonestActiveExpiry: string | null;
  packageLabel: string;
  createEventBlock: CreateEventBlockInfo | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [eventDate, setEventDate] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showBillingLink, setShowBillingLink] = useState(false);

  const expiryInfo = soonestActiveExpiry
    ? formatExpiryCountdown(soonestActiveExpiry)
    : null;

  function openCreateModal() {
    setTitle("");
    setSubtitle("");
    setSlug("");
    setSlugTouched(false);
    setEventDate("");
    setContactEmail("");
    setContactPhone("");
    setFormError(createEventBlock ? createEventBlock.message : null);
    setShowBillingLink(Boolean(createEventBlock));
    setCreateModalOpen(true);
  }

  function handleTitleChange(nextTitle: string) {
    setTitle(nextTitle);
    if (!slugTouched) {
      setSlug(slugifyEventTitle(nextTitle));
    }
  }

  function handleSlugChange(nextSlug: string) {
    setSlugTouched(true);
    setSlug(nextSlug.toLowerCase().replace(/\s+/g, "-"));
  }

  const liveSlugCheck = slug.trim() ? validateEventSlug(slug) : null;

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setShowBillingLink(false);

    const check = validateEventSlug(slug);
    if (!check.valid) {
      setFormError(check.error || "Invalid slug.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await createEventAction({
        title,
        subtitle,
        slug: check.slug,
        eventDate,
        contactEmail,
        contactPhone,
      });

      if (res.error) {
        setFormError(res.error);
        setShowBillingLink(
          res.code === "NO_ACTIVE_PURCHASE" ||
            res.code === "PURCHASE_PENDING" ||
            res.code === "NO_EVENT_SLOTS" ||
            res.code === "PURCHASE_EXPIRED",
        );
        showToast(res.error, "error");
        return;
      }

      showToast("Event created (1 package slot consumed)!", "success");
      setCreateModalOpen(false);
      if (res.eventId) {
        router.push(`/dashboard/events/${res.eventId}`);
      }
      router.refresh();
    } catch {
      const msg = "Something went wrong while creating the event.";
      setFormError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const columns: DataTableColumn<EventSummaryRow>[] = [
    {
      key: "title",
      header: "Event",
      render: (row) => (
        <div>
          <Link
            href={`/dashboard/events/${row.id}`}
            className="font-semibold text-slate-900 hover:text-indigo-600"
          >
            {row.title}
          </Link>
          {row.subtitle && (
            <p className="text-xs text-slate-500">{row.subtitle}</p>
          )}
        </div>
      ),
    },
    {
      key: "slug",
      header: "Public URL",
      render: (row) => (
        <code className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
          /e/{row.slug}
        </code>
      ),
    },
    {
      key: "certificates",
      header: "Certificates",
      render: (row) => {
        const used = row.certificatesIssuedCount ?? row.attendeeCount;
        return (
          <span className="font-mono text-xs font-semibold text-slate-800">
            {used} / {row.maxCertificates} certificates
          </span>
        );
      },
    },
    {
      key: "eventDate",
      header: "Date",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {row.eventDate || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) =>
        row.released ? (
          <div>
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
              Released
            </span>
            {row.retentionUntil && (
              <p className="mt-0.5 text-[10px] text-slate-500">
                Public until{" "}
                {new Date(row.retentionUntil).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            )}
          </div>
        ) : (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
            Draft
          </span>
        ),
    },
    {
      key: "actions",
      header: "",
      className: "text-right",
      render: (row) => (
        <Link
          href={`/dashboard/events/${row.id}`}
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
        >
          Manage →
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page header with usage meters ("1 / 3 events", "expires in 41 days") */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Events
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Create events, upload certificate templates, and manage attendee downloads.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600">
            <strong className="text-slate-900">
              {eventsSlotsUsed} / {eventsSlotsTotal} events
            </strong>
            {expiryInfo && expiryInfo.daysRemaining !== null ? (
              <span className="text-slate-500"> · {expiryInfo.label}</span>
            ) : (
              <span className="text-slate-500"> · {packageLabel}</span>
            )}
          </span>
          <Button variant="primary" onClick={openCreateModal}>
            + Create Event
          </Button>
        </div>
      </div>

      {/* Clear package status banner when event creation is blocked */}
      {createEventBlock && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-5 py-3.5 text-xs ${
            createEventBlock.code === "PURCHASE_PENDING"
              ? "border-amber-200 bg-amber-50/90 text-amber-950"
              : createEventBlock.code === "PURCHASE_EXPIRED"
                ? "border-red-200 bg-red-50/90 text-red-950"
                : "border-indigo-200 bg-indigo-50/90 text-indigo-950"
          }`}
        >
          <div>
            <strong>
              {createEventBlock.code === "PURCHASE_PENDING"
                ? "Waiting for approval:"
                : createEventBlock.code === "NO_EVENT_SLOTS"
                  ? "No event slots left:"
                  : createEventBlock.code === "PURCHASE_EXPIRED"
                    ? "Package expired:"
                    : "Buy a package:"}
            </strong>{" "}
            {createEventBlock.message}
          </div>
          <Link
            href="/dashboard/billing"
            className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
          >
            {createEventBlock.code === "PURCHASE_PENDING"
              ? "View Billing Status →"
              : "Buy a Package →"}
          </Link>
        </div>
      )}

      {/* Events table or EmptyState */}
      <DataTable
        columns={columns}
        rows={events}
        getRowKey={(row) => row.id}
        emptyState={
          <EmptyState
            icon="🎓"
            title="No events yet"
            description="Every event consumes 1 slot from an active package. Buy a package in Billing or use an available slot to create your first event."
            action={
              createEventBlock ? (
                <Link
                  href="/dashboard/billing"
                  className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
                >
                  Open Billing &amp; Packages →
                </Link>
              ) : (
                <Button variant="primary" onClick={openCreateModal}>
                  Create your first event
                </Button>
              )
            }
          />
        }
      />

      {/* Create Event Modal */}
      <Modal
        open={createModalOpen}
        onClose={() => !submitting && setCreateModalOpen(false)}
        title="Create a new event"
        description="Consumes 1 slot from your soonest-expiring active package and copies its certificate allowance."
        maxWidthClass="max-w-xl"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          <Input
            id="event-title"
            label="Event title *"
            placeholder="e.g. National AI Seminar 2026"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            required
            minLength={2}
            maxLength={200}
            autoFocus
            disabled={submitting}
          />

          <Input
            id="event-subtitle"
            label="Subtitle (optional)"
            placeholder="e.g. Department of Computer Science"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            maxLength={300}
            disabled={submitting}
          />

          <div>
            <Input
              id="event-slug"
              label="Public URL slug *"
              placeholder="national-ai-seminar-2026"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              required
              minLength={2}
              maxLength={80}
              disabled={submitting}
              error={
                liveSlugCheck && !liveSlugCheck.valid
                  ? liveSlugCheck.error
                  : null
              }
              hint={`Public download link: /e/${slug || "your-event-slug"}`}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              id="event-date"
              type="date"
              label="Event date"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              disabled={submitting}
            />
            <Input
              id="contact-email"
              type="email"
              label="Contact email"
              placeholder="events@org.edu"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              disabled={submitting}
            />
            <Input
              id="contact-phone"
              type="tel"
              label="Contact phone"
              placeholder="+92 300 0000000"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              maxLength={40}
              disabled={submitting}
            />
          </div>

          {formError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
              <p>{formError}</p>
              {showBillingLink && (
                <Link
                  href="/dashboard/billing"
                  className="mt-2 inline-block font-bold text-indigo-700 underline"
                >
                  Open Billing &amp; Packages →
                </Link>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCreateModalOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={
                Boolean(createEventBlock) ||
                Boolean(liveSlugCheck && !liveSlugCheck.valid)
              }
            >
              Create Event
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
