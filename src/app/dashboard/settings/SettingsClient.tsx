"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, useToast } from "@/components/ui";
import type { OrgUsageSummary } from "@/lib/dashboard-data";
import {
  changePasswordAction,
  updateOrganizationNameAction,
} from "./actions";

export default function SettingsClient({
  summary,
}: {
  summary: OrgUsageSummary;
}) {
  const { org, user, plan, eventsUsed, certificatesUsed } = summary;
  const { showToast } = useToast();
  const router = useRouter();

  // Organization name state
  const [orgName, setOrgName] = useState(org.name);
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  // Password change state
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

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
    plan.maxEvents && plan.maxEvents > 0
      ? Math.min(100, Math.round((eventsUsed / plan.maxEvents) * 100))
      : 0;

  const certsRatio =
    plan.maxCertificatesTotal && plan.maxCertificatesTotal > 0
      ? Math.min(
          100,
          Math.round((certificatesUsed / plan.maxCertificatesTotal) * 100),
        )
      : 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your organization profile, view current plan limits, and update your password.
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

      {/* 2. Current Plan & Usage */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-slate-900">
                Current Plan & Usage
              </h2>
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
                {plan.name}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {plan.pricePkr === 0
                ? "Free tier — ideal for trying out cert-saas on a small seminar or workshop."
                : `PKR ${plan.pricePkr.toLocaleString()} / month`}
            </p>
          </div>

          <div className="text-right text-xs text-slate-500">
            <div>
              Max per event:{" "}
              <strong className="text-slate-900">
                {plan.maxCertificatesPerEvent ?? "Unlimited"} certificates
              </strong>
            </div>
            <div>
              Custom branding:{" "}
              <strong className="text-slate-900">
                {plan.allowCustomBranding ? "Included" : "Not included"}
              </strong>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {/* Events usage card */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Events Used
              </span>
              <span className="text-base font-bold text-slate-900">
                {eventsUsed} / {plan.maxEvents ?? "∞"}
              </span>
            </div>
            {plan.maxEvents !== null && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all"
                  style={{ width: `${eventsRatio}%` }}
                />
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              {plan.maxEvents !== null
                ? `${Math.max(0, plan.maxEvents - eventsUsed)} event slot(s) remaining on ${plan.name}.`
                : "Unlimited events on your plan."}
            </p>
          </div>

          {/* Certificates usage card */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Total Certificates Issued
              </span>
              <span className="text-base font-bold text-slate-900">
                {certificatesUsed} / {plan.maxCertificatesTotal ?? "∞"}
              </span>
            </div>
            {plan.maxCertificatesTotal !== null && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all"
                  style={{ width: `${certsRatio}%` }}
                />
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Up to {plan.maxCertificatesPerEvent ?? "unlimited"} certificates per event.
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
    </div>
  );
}
