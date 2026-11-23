"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  EmptyState,
  Input,
  Modal,
  useToast,
} from "@/components/ui";
import {
  deleteEventAction,
  updateEventOverviewAction,
  updateEventSettingsAction,
} from "@/app/dashboard/events/actions";
import type { EventDetail } from "@/lib/dashboard-data";
import { validateEventSlug } from "@/lib/event-validation";
import TemplateTabClient from "./TemplateTabClient";

export type EventTab =
  | "overview"
  | "template"
  | "attendees"
  | "downloads"
  | "settings";

const TABS: Array<{ id: EventTab; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "📋" },
  { id: "template", label: "Template", icon: "🎨" },
  { id: "attendees", label: "Attendees", icon: "👥" },
  { id: "downloads", label: "Downloads", icon: "📥" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

const IDENTIFIER_PRESETS = [
  "Registration number",
  "Roll number",
  "Member ID",
  "Email",
  "Employee ID",
];

export default function EventWorkspaceClient({
  event,
  initialTab = "overview",
}: {
  event: EventDetail;
  initialTab?: EventTab;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<EventTab>(initialTab);

  // Overview form state
  const [title, setTitle] = useState(event.title);
  const [subtitle, setSubtitle] = useState(event.subtitle || "");
  const [slug, setSlug] = useState(event.slug);
  const [eventDate, setEventDate] = useState(event.eventDate || "");
  const [contactEmail, setContactEmail] = useState(event.contactEmail || "");
  const [contactPhone, setContactPhone] = useState(event.contactPhone || "");
  const [savingOverview, setSavingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Settings tab state
  const [released, setReleased] = useState(event.released);
  const [identifierLabel, setIdentifierLabel] = useState(event.identifierLabel);
  const [requireNameMatch, setRequireNameMatch] = useState(
    event.requireNameMatch,
  );
  const [downloadLimit, setDownloadLimit] = useState<number | null>(
    event.downloadLimit === 1 || event.downloadLimit === 3
      ? event.downloadLimit
      : null,
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Delete confirmation modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const liveSlugCheck = validateEventSlug(slug);

  async function handleSaveOverview(e: FormEvent) {
    e.preventDefault();
    setOverviewError(null);

    if (!liveSlugCheck.valid) {
      setOverviewError(liveSlugCheck.error || "Invalid slug.");
      return;
    }

    setSavingOverview(true);
    try {
      const res = await updateEventOverviewAction({
        eventId: event.id,
        title,
        subtitle,
        slug: liveSlugCheck.slug,
        eventDate,
        contactEmail,
        contactPhone,
      });

      if (res.error) {
        setOverviewError(res.error);
        showToast(res.error, "error");
        return;
      }

      if (res.slug) setSlug(res.slug);
      showToast("Event details saved.", "success");
      router.refresh();
    } catch {
      const msg = "Failed to save event details.";
      setOverviewError(msg);
      showToast(msg, "error");
    } finally {
      setSavingOverview(false);
    }
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    setSettingsError(null);

    const trimmedLabel = identifierLabel.trim();
    if (!trimmedLabel) {
      setSettingsError("Identifier label is required.");
      return;
    }

    setSavingSettings(true);
    try {
      const res = await updateEventSettingsAction({
        eventId: event.id,
        released,
        identifierLabel: trimmedLabel,
        requireNameMatch,
        downloadLimit,
      });

      if (res.error) {
        setSettingsError(res.error);
        showToast(res.error, "error");
        return;
      }

      showToast("Event settings updated.", "success");
      router.refresh();
    } catch {
      const msg = "Failed to save event settings.";
      setSettingsError(msg);
      showToast(msg, "error");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleQuickReleaseToggle(nextReleased: boolean) {
    setReleased(nextReleased);
    setSavingSettings(true);
    try {
      const res = await updateEventSettingsAction({
        eventId: event.id,
        released: nextReleased,
        identifierLabel: identifierLabel.trim() || event.identifierLabel,
        requireNameMatch,
        downloadLimit,
      });

      if (res.error) {
        setReleased(!nextReleased);
        showToast(res.error, "error");
        return;
      }

      showToast(
        nextReleased
          ? "Certificates released! Public downloads are now enabled."
          : "Certificates set to Draft (downloads paused).",
        "success",
      );
      router.refresh();
    } catch {
      setReleased(!nextReleased);
      showToast("Failed to update release status.", "error");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleConfirmDelete(e: FormEvent) {
    e.preventDefault();
    setDeleteError(null);

    if (confirmSlug.trim().toLowerCase() !== event.slug) {
      setDeleteError(`Please type "${event.slug}" exactly to confirm.`);
      return;
    }

    setDeleting(true);
    try {
      const res = await deleteEventAction({
        eventId: event.id,
        confirmSlug,
      });

      if (res.error) {
        setDeleteError(res.error);
        showToast(res.error, "error");
        return;
      }

      showToast(`Deleted event "${event.title}".`, "success");
      setDeleteModalOpen(false);
      router.push("/dashboard");
      router.refresh();
    } catch {
      const msg = "Failed to delete event.";
      setDeleteError(msg);
      showToast(msg, "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top breadcrumb + Event header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard"
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
          >
            ← Back to Events
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
              {event.title}
            </h1>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                released
                  ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
              }`}
            >
              {released ? "Released" : "Draft"}
            </span>
          </div>
          {event.subtitle && (
            <p className="mt-0.5 text-sm text-slate-600">{event.subtitle}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Public portal:{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">
              /e/{event.slug}
            </code>
            {event.eventDate ? ` · Event date: ${event.eventDate}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant={released ? "secondary" : "primary"}
            size="sm"
            loading={savingSettings}
            onClick={() => handleQuickReleaseToggle(!released)}
          >
            {released ? "Pause Downloads" : "Release Certificates"}
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-2 overflow-x-auto" aria-label="Event sections">
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold whitespace-nowrap transition sm:text-sm ${
                  active
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
                }`}
              >
                <span aria-hidden="true">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* 1. OVERVIEW TAB */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Quick stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Attendees
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {event.attendeeCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Lookup by {event.identifierLabel}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Downloaded
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {event.certificatesDownloadedCount} /{" "}
                {event.certificatesIssuedCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Certificates claimed
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Templates
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {event.certificateTypesCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Certificate type(s)
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Download Limit
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {event.downloadLimit === null
                  ? "Unlimited"
                  : `${event.downloadLimit}×`}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {event.requireNameMatch
                  ? "Exact name match required"
                  : "Identifier lookup only"}
              </p>
            </div>
          </div>

          {/* Edit event details form */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
            <div className="mb-6">
              <h2 className="text-base font-bold text-slate-900">
                Event Details
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Shown on the public certificate download page (/e/{event.slug}).
              </p>
            </div>

            <form
              onSubmit={handleSaveOverview}
              className="max-w-2xl space-y-4"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  id="overview-title"
                  label="Event title *"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  minLength={2}
                  maxLength={200}
                  disabled={savingOverview}
                />
                <Input
                  id="overview-subtitle"
                  label="Subtitle"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  maxLength={300}
                  disabled={savingOverview}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  id="overview-slug"
                  label="Public URL slug *"
                  value={slug}
                  onChange={(e) =>
                    setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))
                  }
                  required
                  minLength={2}
                  maxLength={80}
                  disabled={savingOverview}
                  error={!liveSlugCheck.valid ? liveSlugCheck.error : null}
                  hint={`Public link: /e/${slug || "event-slug"}`}
                />
                <Input
                  id="overview-date"
                  type="date"
                  label="Event date"
                  value={eventDate}
                  onChange={(e) => setEventDate(e.target.value)}
                  disabled={savingOverview}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  id="overview-email"
                  type="email"
                  label="Organizer contact email"
                  placeholder="events@org.edu"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  disabled={savingOverview}
                />
                <Input
                  id="overview-phone"
                  type="tel"
                  label="Organizer contact phone"
                  placeholder="+92 300 0000000"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  maxLength={40}
                  disabled={savingOverview}
                />
              </div>

              {overviewError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700">
                  {overviewError}
                </p>
              )}

              <div className="pt-2">
                <Button
                  type="submit"
                  loading={savingOverview}
                  disabled={!liveSlugCheck.valid}
                >
                  Save Event Details
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* 2. TEMPLATE TAB */}
      {activeTab === "template" && (
        <TemplateTabClient
          eventId={event.id}
          initialTypes={event.certificateTypes}
          maxTypesPerEvent={event.maxCertificateTypesPerEvent}
          planName={event.planName}
        />
      )}

      {/* 3. ATTENDEES TAB */}
      {activeTab === "attendees" && (
        <EmptyState
          icon="👥"
          title={`Attendees (${event.attendeeCount})`}
          description={`Import attendees via CSV or add them manually using "${event.identifierLabel}" as the lookup key. Per-event attendee management connects here in the Attendees phase.`}
        />
      )}

      {/* 4. DOWNLOADS TAB */}
      {activeTab === "downloads" && (
        <EmptyState
          icon="📥"
          title={`Download Logs (${event.certificatesDownloadedCount} downloaded)`}
          description="Track which attendees have downloaded their certificate, view timestamps, and export downloaded / pending lists as CSV."
        />
      )}

      {/* 5. SETTINGS TAB */}
      {activeTab === "settings" && (
        <div className="space-y-8">
          <form onSubmit={handleSaveSettings} className="space-y-6">
            {/* Release toggle & Verification settings */}
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
              <h2 className="text-base font-bold text-slate-900">
                Portal & Verification Settings
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Control how attendees look up and download their certificates on{" "}
                <code className="font-mono text-slate-700">
                  /e/{event.slug}
                </code>
                .
              </p>

              <div className="mt-6 max-w-2xl space-y-6">
                {/* Released Toggle */}
                <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div>
                    <label
                      htmlFor="setting-released"
                      className="text-sm font-bold text-slate-900"
                    >
                      Release certificates to attendees
                    </label>
                    <p className="mt-0.5 text-xs text-slate-600">
                      When enabled, attendees visiting{" "}
                      <code className="font-mono">/e/{event.slug}</code> can look up and download their certificates. When disabled, the page displays a &ldquo;Coming Soon&rdquo; message.
                    </p>
                  </div>
                  <input
                    id="setting-released"
                    type="checkbox"
                    checked={released}
                    onChange={(e) => setReleased(e.target.checked)}
                    disabled={savingSettings}
                    className="mt-1 h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </div>

                {/* Identifier Label */}
                <div>
                  <Input
                    id="setting-identifier-label"
                    label="Attendee identifier label *"
                    value={identifierLabel}
                    onChange={(e) => setIdentifierLabel(e.target.value)}
                    required
                    minLength={1}
                    maxLength={60}
                    disabled={savingSettings}
                    hint="The field label shown on the public download form."
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-500">Presets:</span>
                    {IDENTIFIER_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setIdentifierLabel(preset)}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                          identifierLabel === preset
                            ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Require exact name match toggle */}
                <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div>
                    <label
                      htmlFor="setting-name-match"
                      className="text-sm font-bold text-slate-900"
                    >
                      Require exact name match
                    </label>
                    <p className="mt-0.5 text-xs text-slate-600">
                      When enabled, attendees must enter both their{" "}
                      <strong>{identifierLabel || "identifier"}</strong> and their full name (case-insensitive) to download their certificate.
                    </p>
                  </div>
                  <input
                    id="setting-name-match"
                    type="checkbox"
                    checked={requireNameMatch}
                    onChange={(e) => setRequireNameMatch(e.target.checked)}
                    disabled={savingSettings}
                    className="mt-1 h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </div>

                {/* Download limit selector (1, 3, unlimited) */}
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">
                    Download limit per certificate
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        { value: 1, label: "1 download", sub: "Strict single download" },
                        { value: 3, label: "3 downloads", sub: "Allows re-download" },
                        { value: null, label: "Unlimited", sub: "No per-attendee cap" },
                      ] as const
                    ).map((opt) => {
                      const selected = downloadLimit === opt.value;
                      return (
                        <button
                          key={String(opt.value)}
                          type="button"
                          onClick={() => setDownloadLimit(opt.value)}
                          disabled={savingSettings}
                          className={`rounded-xl border p-3 text-left transition ${
                            selected
                              ? "border-indigo-600 bg-indigo-50/70 ring-2 ring-indigo-500/20"
                              : "border-slate-200 bg-white hover:bg-slate-50"
                          }`}
                        >
                          <p className="text-xs font-bold text-slate-900 sm:text-sm">
                            {opt.label}
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {opt.sub}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {settingsError && (
                  <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700">
                    {settingsError}
                  </p>
                )}

                <div className="pt-2">
                  <Button type="submit" loading={savingSettings}>
                    Save Event Settings
                  </Button>
                </div>
              </div>
            </section>
          </form>

          {/* Danger Zone: Delete Event with typed confirmation */}
          <section className="rounded-2xl border border-red-200 bg-white p-6 shadow-xs sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-red-700">
                  Delete Event
                </h2>
                <p className="mt-1 max-w-xl text-xs text-slate-600">
                  Permanently deletes <strong>{event.title}</strong>, including all{" "}
                  <strong>{event.attendeeCount}</strong> attendee(s), issued certificates, uploaded template files, and download logs. This action cannot be undone.
                </p>
              </div>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmSlug("");
                  setDeleteError(null);
                  setDeleteModalOpen(true);
                }}
              >
                Delete Event
              </Button>
            </div>
          </section>
        </div>
      )}

      {/* Typed confirmation delete modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => !deleting && setDeleteModalOpen(false)}
        title="Delete event permanently?"
        description="This will remove the event, all attendees, template files, and download logs."
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleConfirmDelete} className="space-y-4">
          <p className="text-xs leading-relaxed text-slate-600">
            To confirm deletion of{" "}
            <strong className="text-slate-900">{event.title}</strong>, please type the event slug{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-bold text-slate-900">
              {event.slug}
            </code>{" "}
            below:
          </p>

          <Input
            id="confirm-delete-slug"
            placeholder={event.slug}
            value={confirmSlug}
            onChange={(e) => setConfirmSlug(e.target.value)}
            autoFocus
            required
            disabled={deleting}
            error={deleteError}
          />

          <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              loading={deleting}
              disabled={confirmSlug.trim().toLowerCase() !== event.slug}
            >
              Permanently Delete Event
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
