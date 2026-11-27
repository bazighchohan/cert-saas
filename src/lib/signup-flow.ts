import {
  computePrice,
  validatePricingInput,
  type ComputedPriceBreakdown,
  type PackageKind,
  type PricedPlanPreset,
  type PricingConfig,
} from "@/lib/pricing";

export interface PilotSignupResolvedPlan {
  planId: string | null;
  planSummary: string;
  kind: PackageKind;
  eventsTotal: number;
  certsPerEvent: number;
  months: number;
  breakdown: ComputedPriceBreakdown;
  priceSnapshot: Record<string, unknown>;
}

export interface PilotSignupFlowInput {
  orgName: string;
  contactName: string;
  email: string;
  password: string;
  whatsappNumber: string;
  selectionType: "preset" | "custom";
  planId?: string;
  events?: number;
  certsPerEvent?: number;
  months?: number;
  idempotencyKey?: string;
}

export interface PilotSignupDeps {
  pricingConfig: PricingConfig;
  presets: PricedPlanPreset[];
  createAuthUser: (params: {
    email: string;
    password: string;
    metadata: Record<string, unknown>;
  }) => Promise<
    | { ok: true; userId: string }
    | { ok: false; alreadyExists: boolean; error: string }
  >;
  deleteAuthUser: (userId: string) => Promise<void>;
  signInWithPassword: (params: {
    email: string;
    password: string;
  }) => Promise<{ ok: boolean; userId?: string; error?: string }>;
  runSignupPendingOrgRpc: (params: {
    userId: string;
    email: string;
    orgName: string;
    contactName: string;
    whatsappNumber: string;
    planId: string | null;
    kind: PackageKind;
    eventsTotal: number;
    certsPerEvent: number;
    months: number;
    listPricePkr: number;
    discountPkr: number;
    finalPricePkr: number;
    priceSnapshot: Record<string, unknown>;
    idempotencyKey: string;
  }) => Promise<{
    orgId: string;
    orgStatus: string;
    purchaseId: string;
    purchaseStatus: string;
    alreadyExisted: boolean;
  }>;
  onAfterCreated?: (info: {
    orgId: string;
    purchaseId: string;
    alreadyExisted: boolean;
    resolvedPlan: PilotSignupResolvedPlan;
  }) => Promise<{ redirectTo?: string } | void>;
}

export interface PilotSignupOutcome {
  success?: boolean;
  error?: string;
  orgId?: string;
  purchaseId?: string;
  alreadyExisted?: boolean;
  redirectTo?: string;
  resolvedPlan?: PilotSignupResolvedPlan;
}

/**
 * Resolves and server-recomputes the selected package price from `pricingConfig` + `presets`.
 * Never trusts any price or discount supplied by the client.
 */
export function resolveSignupPlanOnServer(
  input: {
    selectionType: "preset" | "custom";
    planId?: string;
    events?: number;
    certsPerEvent?: number;
    months?: number;
  },
  pricingConfig: PricingConfig,
  presets: PricedPlanPreset[],
): { ok: true; plan: PilotSignupResolvedPlan } | { ok: false; error: string } {
  let planId: string | null = null;
  let kind: PackageKind = "custom";
  let eventsTotal: number;
  let certsPerEvent: number;
  let months: number;
  let planLabel: string;

  if (input.selectionType === "preset") {
    const targetId = (input.planId ?? "").trim().toLowerCase();
    const matched =
      (targetId ? presets.find((p) => p.id === targetId) : undefined) ??
      (targetId === "" ? presets[0] : undefined);

    if (!matched) {
      return { ok: false, error: "Selected plan preset does not exist." };
    }

    planId = matched.id;
    kind = matched.kind;
    eventsTotal = matched.eventsCount;
    certsPerEvent = matched.certsPerEvent;
    months = matched.months;
    planLabel = `${matched.name} (${eventsTotal} event${eventsTotal === 1 ? "" : "s"} × ${certsPerEvent} certs · ${months} months)`;
  } else {
    const validated = validatePricingInput(
      {
        events: Number(input.events ?? 1),
        certsPerEvent: Number(input.certsPerEvent ?? 50),
        months: Number(input.months ?? 3),
      },
      pricingConfig,
    );
    if (!validated.valid) {
      return { ok: false, error: validated.error };
    }
    planId = null;
    kind = "custom";
    eventsTotal = validated.normalized.events;
    certsPerEvent = validated.normalized.certsPerEvent;
    months = validated.normalized.months;
    planLabel = `Custom (${eventsTotal} event${eventsTotal === 1 ? "" : "s"} × ${certsPerEvent} certs · ${months} months)`;
  }

  const breakdown = computePrice(
    { events: eventsTotal, certsPerEvent, months },
    pricingConfig,
  );

  const priceSnapshot: Record<string, unknown> = {
    plan_id: planId,
    kind,
    events: breakdown.events,
    certs_per_event: breakdown.certsPerEvent,
    months: breakdown.months,
    event_fee_pkr: pricingConfig.eventFeePkr,
    cert_rate_pkr: pricingConfig.certRatePkr,
    per_event_price_pkr: breakdown.perEventPricePkr,
    discount_percent: breakdown.discountPercent,
    duration_multiplier: breakdown.durationMultiplier,
    list_price_pkr: breakdown.listPricePkr,
    discount_pkr: breakdown.discountPkr,
    final_price_pkr: breakdown.finalPricePkr,
    currency: "PKR",
  };

  return {
    ok: true,
    plan: {
      planId,
      planSummary: planLabel,
      kind,
      eventsTotal,
      certsPerEvent,
      months,
      breakdown,
      priceSnapshot,
    },
  };
}

// Per-process serialization map keyed by normalized email to deduplicate rapid double-clicks
const inflightSignupByEmail = new Map<string, Promise<PilotSignupOutcome>>();

/**
 * Executes the idempotent pilot signup flow:
 * 1. Serializes concurrent double-clicks for the same email.
 * 2. Recomputes the exact package price on the server.
 * 3. Creates the user with `email_confirm: true` (no email confirmation required) —
 *    or recovers idempotently if a retry hits an already-created user with matching credentials.
 * 4. Runs `signup_pending_organization` inside one atomic Postgres transaction.
 * 5. Signs the user in and redirects to `/pending` (or `/dashboard` if already active).
 */
export async function executePilotSignup(
  input: PilotSignupFlowInput,
  deps: PilotSignupDeps,
): Promise<PilotSignupOutcome> {
  const emailKey = input.email.trim().toLowerCase();
  const existingTask = inflightSignupByEmail.get(emailKey);
  if (existingTask) {
    return existingTask;
  }

  const task = (async (): Promise<PilotSignupOutcome> => {
    const planRes = resolveSignupPlanOnServer(
      {
        selectionType: input.selectionType,
        planId: input.planId,
        events: input.events,
        certsPerEvent: input.certsPerEvent,
        months: input.months,
      },
      deps.pricingConfig,
      deps.presets,
    );

    if (!planRes.ok) {
      return { error: planRes.error };
    }

    const resolvedPlan = planRes.plan;
    const cleanEmail = emailKey;
    const cleanOrgName = input.orgName.trim();
    const cleanContact = input.contactName.trim();
    const cleanWhatsapp = input.whatsappNumber.trim().replace(/\s+/g, " ");

    let userId: string | null = null;
    let newlyCreatedAuthUser = false;

    const createRes = await deps.createAuthUser({
      email: cleanEmail,
      password: input.password,
      metadata: {
        organization_name: cleanOrgName,
        org_name: cleanOrgName,
        contact_name: cleanContact,
        whatsapp_number: cleanWhatsapp,
      },
    });

    if (createRes.ok) {
      userId = createRes.userId;
      newlyCreatedAuthUser = true;
    } else if (createRes.alreadyExists) {
      // Idempotent retry / double-click recovery: verify credentials match the submitting user
      const signInRetry = await deps.signInWithPassword({
        email: cleanEmail,
        password: input.password,
      });
      if (!signInRetry.ok || !signInRetry.userId) {
        return {
          error:
            "An account with this email already exists. Please sign in instead.",
        };
      }
      userId = signInRetry.userId;
    } else {
      return { error: createRes.error };
    }

    let rpcResult: {
      orgId: string;
      orgStatus: string;
      purchaseId: string;
      purchaseStatus: string;
      alreadyExisted: boolean;
    };

    try {
      rpcResult = await deps.runSignupPendingOrgRpc({
        userId,
        email: cleanEmail,
        orgName: cleanOrgName,
        contactName: cleanContact,
        whatsappNumber: cleanWhatsapp,
        planId: resolvedPlan.planId,
        kind: resolvedPlan.kind,
        eventsTotal: resolvedPlan.eventsTotal,
        certsPerEvent: resolvedPlan.certsPerEvent,
        months: resolvedPlan.months,
        listPricePkr: resolvedPlan.breakdown.listPricePkr,
        discountPkr: resolvedPlan.breakdown.discountPkr,
        finalPricePkr: resolvedPlan.breakdown.finalPricePkr,
        priceSnapshot: resolvedPlan.priceSnapshot,
        idempotencyKey:
          input.idempotencyKey?.trim() || `signup:${userId}`,
      });
    } catch (err) {
      if (newlyCreatedAuthUser && userId) {
        await deps.deleteAuthUser(userId).catch(() => {});
      }
      return {
        error:
          err instanceof Error && err.message
            ? err.message
            : "Could not set up your organization request. Please try again.",
      };
    }

    if (newlyCreatedAuthUser) {
      const signInRes = await deps.signInWithPassword({
        email: cleanEmail,
        password: input.password,
      });
      if (!signInRes.ok) {
        return {
          error:
            "Your request was submitted, please sign in with your email and password.",
          redirectTo: "/login",
        };
      }
    }

    let redirectTo =
      rpcResult.orgStatus === "active" ? "/dashboard" : "/pending";

    if (deps.onAfterCreated) {
      const after = await deps.onAfterCreated({
        orgId: rpcResult.orgId,
        purchaseId: rpcResult.purchaseId,
        alreadyExisted: rpcResult.alreadyExisted,
        resolvedPlan,
      });
      if (after?.redirectTo) {
        redirectTo = after.redirectTo;
      }
    }

    return {
      success: true,
      orgId: rpcResult.orgId,
      purchaseId: rpcResult.purchaseId,
      alreadyExisted: rpcResult.alreadyExisted,
      redirectTo,
      resolvedPlan,
    };
  })();

  inflightSignupByEmail.set(emailKey, task);
  try {
    return await task;
  } finally {
    inflightSignupByEmail.delete(emailKey);
  }
}
