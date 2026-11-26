"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12 font-sans text-slate-900">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-bold text-slate-900">
            Application Error
          </h1>
          <p className="mt-2 text-xs text-slate-600">
            Something went wrong on our side. Please refresh or try again in a
            moment.
          </p>
          {error.digest && (
            <p className="mt-1.5 font-mono text-[10px] text-slate-400">
              Reference ID: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            className="mt-5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
