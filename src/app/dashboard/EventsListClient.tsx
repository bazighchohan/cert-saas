"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Button,
  DataTable,
  EmptyState,
  Modal,
  type DataTableColumn,
} from "@/components/ui";
import type { EventSummaryRow } from "@/lib/dashboard-data";

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
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const atLimit = maxEvents !== null && eventsUsed >= maxEvents;

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
          <Button
            variant="primary"
            onClick={() => setCreateModalOpen(true)}
            disabled={atLimit}
          >
            + Create Event
          </Button>
        </div>
      </div>

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
              <Button
                variant="primary"
                onClick={() => setCreateModalOpen(true)}
              >
                Create your first event
              </Button>
            }
          />
        }
      />

      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create a new event"
        description="Event creation wizard and per-event certificate settings are unlocked in the next step."
        footer={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCreateModalOpen(false)}
          >
            Close
          </Button>
        }
      >
        <p className="text-sm text-slate-600">
          Your organization is active on the <strong>{planName}</strong> plan (
          {eventsUsed} of {maxEvents ?? "unlimited"} events used). The event creation form will connect here in the Events CRUD phase.
        </p>
      </Modal>
    </div>
  );
}
