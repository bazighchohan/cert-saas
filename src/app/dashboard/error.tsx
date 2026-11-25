"use client";

import { Button } from "@/components/ui";

export default function DashboardErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto my-12 max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center shadow-xs sm:p-8">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-50 text-xl text-red-600">
        ⚠️
      </div>
      <h2 className="text-lg font-bold text-slate-900">
        Something went wrong loading the dashboard
      </h2>
      <p className="mt-1.5 text-xs text-slate-600">
        {error.message || "An unexpected error occurred."}
      </p>
      <div className="mt-5 flex items-center justify-center gap-3">
        <Button variant="primary" size="sm" onClick={() => reset()}>
          Retry
        </Button>
      </div>
    </div>
  );
}
