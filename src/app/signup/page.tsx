import "server-only";

import { redirect } from "next/navigation";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{
    plan?: string;
    events?: string;
    certs?: string;
    months?: string;
  }>;
}) {
  const user = await getCurrentUser();
  if (user) {
    const [{ org }, isSuperAdmin] = await Promise.all([
      getCurrentOrgResult(),
      isUserInSuperAdminsTable(user.id),
    ]);
    if (!isSuperAdmin && (!org || org.status !== "active")) {
      redirect("/pending");
    }
    redirect("/dashboard");
  }

  const [{ pricingConfig, presets }, query] = await Promise.all([
    getPricingAndPresets(),
    searchParams,
  ]);

  const rawPlan = (query.plan ?? "").trim().toLowerCase();
  const matchedPreset = rawPlan
    ? presets.find((p) => p.id === rawPlan)
    : undefined;

  let initialPlanFromUrl:
    | {
        cameFromUrl: boolean;
        selectionType: "preset" | "custom";
        planId: string;
        events: number;
        certsPerEvent: number;
        months: number;
      }
    | undefined;

  if (matchedPreset) {
    initialPlanFromUrl = {
      cameFromUrl: true,
      selectionType: "preset",
      planId: matchedPreset.id,
      events: matchedPreset.eventsCount,
      certsPerEvent: matchedPreset.certsPerEvent,
      months: matchedPreset.months,
    };
  } else if (rawPlan === "custom") {
    const parsedEvents = Math.min(
      pricingConfig.maxEvents,
      Math.max(pricingConfig.minEvents, Number(query.events) || 3),
    );
    const rawCerts = Number(query.certs) || 100;
    const snappedCerts =
      Math.round(rawCerts / pricingConfig.certsStep) * pricingConfig.certsStep;
    const parsedCerts = Math.min(
      pricingConfig.maxCertsPerEvent,
      Math.max(pricingConfig.minCertsPerEvent, snappedCerts),
    );
    const rawMonths = Number(query.months) || 3;
    const parsedMonths = pricingConfig.allowedMonths.includes(rawMonths)
      ? rawMonths
      : (pricingConfig.allowedMonths[0] ?? 3);

    initialPlanFromUrl = {
      cameFromUrl: true,
      selectionType: "custom",
      planId: presets[0]?.id ?? "single-50",
      events: parsedEvents,
      certsPerEvent: parsedCerts,
      months: parsedMonths,
    };
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-2xl">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-xl font-bold text-white shadow-md">
            📜
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            Request Organization Access
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Submit your organization details and package selection. We&apos;ll
            confirm and activate your workspace on WhatsApp.
          </p>
        </header>

        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
          <SignupForm
            pricingConfig={pricingConfig}
            presets={presets}
            initialSelection={initialPlanFromUrl}
          />
        </section>
      </div>
    </main>
  );
}
