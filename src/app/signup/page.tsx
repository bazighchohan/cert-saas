import "server-only";

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import {
  parsePlanSelectionFromParams,
  PLAN_SELECTION_COOKIE_NAME,
  verifyPlanSelectionCookie,
} from "@/lib/plan-selection-cookie";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Request Organization Access",
  description:
    "Create your organization account, choose an event certificate package, and issue verified digital certificates online.",
};

function getCookieSecret(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "cert-saas-plan-cookie-fallback-secret"
  );
}

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

  const [{ pricingConfig, presets }, query, cookieStore] = await Promise.all([
    getPricingAndPresets(),
    searchParams,
    cookies(),
  ]);

  const choiceFromQuery = parsePlanSelectionFromParams(
    {
      plan: query.plan,
      events: query.events,
      certs: query.certs,
      months: query.months,
    },
    pricingConfig,
    presets,
  );

  const rawCookie = cookieStore.get(PLAN_SELECTION_COOKIE_NAME)?.value;
  const choiceFromCookie = !choiceFromQuery
    ? verifyPlanSelectionCookie(
        rawCookie,
        getCookieSecret(),
        pricingConfig,
        presets,
      )
    : null;

  const resolvedChoice = choiceFromQuery ?? choiceFromCookie;

  const initialSelection = resolvedChoice
    ? {
        cameFromUrl: true,
        selectionType: resolvedChoice.selectionType,
        planId: resolvedChoice.planId,
        events: resolvedChoice.events,
        certsPerEvent: resolvedChoice.certsPerEvent,
        months: resolvedChoice.months,
      }
    : undefined;

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
            initialSelection={initialSelection}
          />
        </section>
      </div>
    </main>
  );
}
