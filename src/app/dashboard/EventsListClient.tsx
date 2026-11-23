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
import type { EventSummaryRow } from "@/lib/dashboard-data";
import { slugifyEventTitle, validateEventSlug } from "@/lib/event-validation";

export default function EventsListClient({
  events,
  eventsUsed,
  maxEvents,
  planName,
}: {
  events: EventSummaryRow[];
  eventsUsed: number;
  maxEvents: number | null;
  planName: string;
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
  const [isPlanLimitError, setIsPlanLimitError] = useState(false);

  const atLimit = maxEvents !== null && eventsUsed >= maxEvents;

  function openCreateModal() {
    setTitle("");
    setSubtitle("");
    setSlug("");
    setSlugTouched(false);
    setEventDate("");
    setContactEmail("");
    setContactPhone("");
    setFormError(
      atLimit
        ? `Your organization has reached the ${planName} plan limit of ${maxEvents} event${
            maxEvents === 1 ? "" : "s"
          } (${eventsUsed}/${maxEvents} used). Upgrade your plan in Billing to create more events.`
        : null,
    );
    setIsPlanLimitError(atLimit);
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
    setIsPlanLimitError(false);

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
        setIsPlanLimitError(res.code === "PLAN_LIMIT_REACHED");
        showToast(res.error, "error");
        return;
      }

      showToast("Event created!", "success");
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
      key: "eventDate",
      header: "Date",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {row.eventDate || "—"}
        </span>
      ),
    },
    {
      key: "attendees",
      header: "Attendees",
      render: (row) => (
        <span className="font-medium text-slate-800">{row.attendeeCount}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) =>
        row.released ? (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
            Released
          </span>
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
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Events
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Create events, upload certificate templates, and manage attendee downloads.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600">
            Events used:{" "}
            <strong className="text-slate-900">
              {eventsUsed} / {maxEvents ?? "∞"}
            </strong>{" "}
            ({planName})
          </span>
          <Button variant="primary" onClick={openCreateModal}>
            + Create Event
          </Button>
        </div>
      </div>

      {/* Plan limit banner when at max_events */}
      {atLimit && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 px-5 py-3.5 text-xs text-amber-900">
          <div>
            <strong>Plan limit reached:</strong> You have used{" "}
            <strong>
              {eventsUsed} of {maxEvents}
            </strong>{" "}
            event{maxEvents === 1 ? "" : "s"} included in the{" "}
            <strong>{planName}</strong> plan. Upgrade to Starter for up to 10 events and 500 certificates per event.
          </div>
          <Link
            href="/dashboard/billing"
            className="shrink-0 rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-800"
          >
            Upgrade Plan →
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
            description="Create your first event to upload a certificate template, add attendees via CSV or manually, and share a public download page."
            action={
              <Button variant="primary" onClick={openCreateModal}>
                Create your first event
              </Button>
            }
          />
        }
      />

      {/* Create Event Modal */}
      <Modal
        open={createModalOpen}
        onClose={() => !submitting && setCreateModalOpen(false)}
        title="Create a new event"
        description="Set up your event details and public download URL slug."
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
              {isPlanLimitError && (
                <Link
                  href="/dashboard/billing"
                  className="mt-2 inline-block font-bold text-indigo-700 underline"
                >
                  View upgrade options in Billing →
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
              disabled={Boolean(liveSlugCheck && !liveSlugCheck.valid)}
            >
              Create Event
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
