"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { resetPasswordAction } from "@/app/auth/actions";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function ResetPasswordForm({
  code,
  tokenHash,
  type,
}: {
  code?: string;
  tokenHash?: string;
  type?: string;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // If the recovery link uses a hash fragment (#access_token=...), allow the
  // @supabase/ssr browser client to detect it and sync auth cookies.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash.includes("access_token")) {
      try {
        const supabase = createSupabaseBrowserClient();
        void supabase.auth.getSession();
      } catch {
        // Ignore if public env vars are not set yet.
      }
    }
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await resetPasswordAction({
        password,
        code,
        tokenHash,
        type,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.push(res.redirectTo || "/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
          New password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          autoFocus
          required
          minLength={8}
          disabled={loading}
          className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-slate-700">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Re-enter your new password"
          autoComplete="new-password"
          required
          minLength={8}
          disabled={loading}
          className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
        />
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700 ring-1 ring-red-200">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="flex w-full items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-70"
      >
        {loading ? "Updating password..." : "Update Password"}
      </button>

      <p className="text-center text-xs text-slate-600">
        Need a new reset link?{" "}
        <Link href="/forgot-password" className="font-semibold text-indigo-600 hover:text-indigo-500">
          Request another link
        </Link>
      </p>
    </form>
  );
}
