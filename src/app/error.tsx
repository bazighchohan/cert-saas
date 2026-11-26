"use client";

export default function RootErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-bold text-slate-900">
          Something went wrong
        </h1>
        <p className="mt-2 text-xs text-slate-600">
          An unexpected error occurred while processing your request. No stack
          traces or internal details are exposed.
        </p>
        {error.digest && (
          <p className="mt-1.5 font-mono text-[10px] text-slate-400">
            Reference ID: {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={() => reset()}
          className="mt-5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
        >
          Try Again
        </button>
      </div>
    </main>
  );
}
