"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Modal, useToast } from "@/components/ui";
import type { OrgUsageSummary } from "@/lib/dashboard-data";
import { formatExpiryCountdown } from "@/lib/pricing";
import {
  changePasswordAction,
  deleteOrganizationAction,
  updateOrganizationNameAction,
} from "./actions";

export default function SettingsClient({
  summary,
}: {
  summary: OrgUsageSummary;
}) {
  const {
    org,
    user,
    eventsSlotsUsed,
    eventsSlotsTotal,
    soonestActiveExpiry,
    certificatesUsed,
  } = summary;
  const { showToast } = useToast();
  const router = useRouter();

  const [orgName, setOrgName] = useState(org.name);
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [deleteOrgOpen, setDeleteOrgOpen] = useState(false);
  const [confirmOrgSlug, setConfirmOrgSlug] = useState("");
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [deleteOrgError, setDeleteOrgError] = useState<string | null>(null);

  async function handleDeleteOrganization(e: FormEvent) {
    e.preventDefault();
    setDeleteOrgError(null);
    setDeletingOrg(true);

    try {
      const res = await deleteOrganizationAction({
        confirmSlug: confirmOrgSlug,
      });
      if (res.error) {
        setDeleteOrgError(res.error);
        return;
      }
      setDeleteOrgOpen(false);
      router.push(res.redirectTo || "/");
      router.refresh();
    } catch {
      setDeleteOrgError("Failed to delete organization.");
    } finally {
      setDeletingOrg(false);
    }
  }

  async function handleSaveOrgName(e: FormEvent) {
    e.preventDefault();
    setOrgError(null);

    const trimmed = orgName.trim();
    if (trimmed.length < 2 || trimmed.length > 200) {
      setOrgError("Organization name must be between 2 and 200 characters.");
      return;
    }

    setSavingOrg(true);
    try {
      const res = await updateOrganizationNameAction({ name: trimmed });
      if (res.error) {
        setOrgError(res.error);
        showToast(res.error, "error");
        return;
      }
      if (res.orgName) {
        setOrgName(res.orgName);
      }
      showToast("Organization name updated.", "success");
      router.refresh();
    } catch {
      const msg = "Failed to save organization settings.";
      setOrgError(msg);
      showToast(msg, "error");
    } finally {
      setSavingOrg(false);
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }

    setSavingPassword(true);
    try {
      const res = await changePasswordAction({ newPassword });
      if (res.error) {
        setPasswordError(res.error);
        showToast(res.error, "error");
        return;
      }
      setNewPassword("");
      setConfirmPassword("");
      showToast("Your password has been updated.", "success");
    } catch {
      const msg = "Failed to update password.";
      setPasswordError(msg);
      showToast(msg, "error");
    } finally {
      setSavingPassword(false);
    }
  }

  const eventsRatio =
    eventsSlotsTotal > 0
      ? Math.min(100, Math.round((eventsSlotsUsed / eventsSlotsTotal) * 100))
      : 0;

  const expiry = formatExpiryCountdown(soonestActiveExpiry);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your organization profile, view active package slots, and update your password.
        </p>
      </div>

      {/* 1. Organization profile */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="mb-6">
          <h2 className="text-base font-bold text-slate-900">
            Organization Profile
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Displayed in your admin dashboard and on public event certificate portals.
          </p>
        </div>

        <form onSubmit={handleSaveOrgName} className="max-w-lg space-y-4">
          <Input
            id="org-name"
            name="orgName"
            label="Organization name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            required
            minLength={2}
            maxLength={200}
            disabled={savingOrg}
            error={orgError}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              id="org-slug"
              label="Organization slug"
              value={org.slug}
              disabled
              hint="Unique URL identifier"
            />
            <Input
              id="org-role"
              label="Your role"
              value={org.role.toUpperCase()}
              disabled
              hint={`Signed in as ${user.email}`}
            />
          </div>

          <div className="pt-2">
            <Button type="submit" loading={savingOrg}>
              Save Organization Name
            </Button>
          </div>
        </form>
      </section>

      {/* 2. Active Package Slots & Usage */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-slate-900">
                Packages &amp; Usage
              </h2>
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
                {org.packageLabel}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {soonestActiveExpiry
                ? `Soonest active package ${expiry.label}.`
                : "Buy a package in Billing to create and release events."}
            </p>
          </div>

          <Link
            href="/dashboard/billing"
            className="rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            Manage Packages &amp; Top-Ups →
          </Link>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Active Event Slots
              </span>
              <span className="text-base font-bold text-slate-900">
                {eventsSlotsUsed} / {eventsSlotsTotal} events
              </span>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all"
                style={{ width: `${eventsRatio}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {Math.max(0, eventsSlotsTotal - eventsSlotsUsed)} event slot(s) remaining across active packages.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Certificates Issued Across Events
              </span>
              <span className="text-base font-bold text-slate-900">
                {certificatesUsed.toLocaleString()}
              </span>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Each event enforces its own certificate cap copied from its package (plus any approved top-ups).
            </p>
          </div>
        </div>
      </section>

      {/* 3. Change Password */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="mb-6">
          <h2 className="text-base font-bold text-slate-900">
            Change Password
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Update the password for your account ({user.email}).
          </p>
        </div>

        <form onSubmit={handleChangePassword} className="max-w-lg space-y-4">
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            label="New password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            disabled={savingPassword}
          />

          <Input
            id="confirm-password"
            name="confirmPassword"
            type="password"
            label="Confirm new password"
            placeholder="Re-enter your new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            disabled={savingPassword}
            error={passwordError}
          />

          <div className="pt-2">
            <Button type="submit" loading={savingPassword}>
              Update Password
            </Button>
          </div>
        </form>
      </section>

      {/* 4. Danger Zone: Delete My Organization */}
      <section className="rounded-2xl border border-red-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-red-700">
              Delete My Organization
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-600">
              Permanently deletes <strong>{org.name}</strong>, all events,
              attendee lists, issued certificates, uploaded template files,
              payment receipts, download logs, and audit logs. This action
              cannot be undone.
            </p>
          </div>

          <Button
            variant="danger"
            disabled={org.role !== "owner"}
            onClick={() => {
              setConfirmOrgSlug("");
              setDeleteOrgError(null);
              setDeleteOrgOpen(true);
            }}
          >
            Delete my organization
          </Button>
        </div>
        {org.role !== "owner" && (
          <p className="mt-2 text-xs text-slate-500">
            Only the organization owner can permanently delete this workspace.
          </p>
        )}
      </section>

      <Modal
        open={deleteOrgOpen}
        onClose={() => !deletingOrg && setDeleteOrgOpen(false)}
        title="Delete your organization permanently?"
        description="Removes your organization, events, attendees, templates, payment files, and logs."
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleDeleteOrganization} className="space-y-4">
          <p className="text-xs leading-relaxed text-slate-600">
            To confirm permanent deletion of{" "}
            <strong className="text-slate-900">{org.name}</strong>, type your
            organization slug{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-bold text-slate-900">
              {org.slug}
            </code>{" "}
            below:
          </p>

          <Input
            id="confirm-delete-org-slug"
            placeholder={org.slug}
            value={confirmOrgSlug}
            onChange={(e) => setConfirmOrgSlug(e.target.value)}
            autoFocus
            required
            disabled={deletingOrg}
            error={deleteOrgError}
          />

          <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDeleteOrgOpen(false)}
              disabled={deletingOrg}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              loading={deletingOrg}
              disabled={
                confirmOrgSlug.trim().toLowerCase() !== org.slug.toLowerCase()
              }
            >
              Permanently Delete Organization
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
