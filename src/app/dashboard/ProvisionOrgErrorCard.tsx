"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  logoutAction,
  retryProvisionOrganizationAction,
} from "@/app/auth/actions";
import { Button, Input } from "@/components/ui";

export default function ProvisionOrgErrorCard({
  userEmail,
  defaultOrgName,
  initialError,
}: {
  userEmail: string;
  defaultOrgName: string;
  initialError: string;
}) {
  const router = useRouter();
  const [orgName, setOrgName] = useState(defaultOrgName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function handleRetry(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await retryProvisionOrganizationAction({ orgName });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch {
      setError("Failed to provision organization. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4 py-12 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 text-xl text-amber-800">
          ⚠️
        </div>

        <h1 className="text-center text-xl font-bold text-slate-900">
          Finish setting up your organization
        </h1>
        <p className="mt-1 text-center text-xs text-slate-600">
          Signed in as <strong className="text-slate-900">{userEmail}</strong>
        </p>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800"
          >
            <p className="font-bold">We could not complete organization setup:</p>
            <p className="mt-1">{error}</p>
          </div>
        )}

        <form onSubmit={handleRetry} className="mt-5 space-y-4">
          <Input
            id="retry-org-name"
            label="Organization name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g. ACM Student Chapter"
            required
            minLength={2}
            maxLength={200}
            disabled={loading}
          />

          <Button
            type="submit"
            variant="primary"
            loading={loading}
            className="w-full"
          >
            Retry Organization Setup
          </Button>
        </form>

        <div className="mt-4 border-t border-slate-100 pt-4 text-center">
          <form action={logoutAction}>
            <button
              type="submit"
              className="text-xs font-semibold text-slate-500 hover:text-slate-800"
            >
              Sign out and use a different account
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
