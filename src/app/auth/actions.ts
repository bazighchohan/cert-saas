"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  getCurrentOrgResult,
  getCurrentUser,
  provisionOrganizationForUser,
  resolveOrganizationName,
} from "@/lib/auth";
import { isPaymentGatewayEnabled } from "@/lib/feature-flags";
import { notifySuperAdminNewSignupRequest } from "@/lib/notifications";
import { getPaymentProvider } from "@/lib/payments";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { clientIpFromHeaders, enforceRateLimit } from "@/lib/rate-limit";
import {
  ForgotPasswordInputSchema,
  LoginInputSchema,
  ResetPasswordInputSchema,
  SignupInputSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { executePilotSignup } from "@/lib/signup-flow";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AuthActionResult {
  error?: string;
  success?: boolean;
  requiresEmailConfirmation?: boolean;
  email?: string;
  redirectTo?: string;
}

async function getAppOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && !configured.includes(".supabase.co")) {
    return configured.replace(/\/+$/, "");
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function safeNextPath(
  next: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}

export async function signupAction(input: {
  orgName: string;
  contactName: string;
  email: string;
  password: string;
  whatsappNumber: string;
  selectionType?: "preset" | "custom";
  planId?: string;
  events?: number;
  certsPerEvent?: number;
  months?: number;
  idempotencyKey?: string;
}): Promise<AuthActionResult> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);

  const ipRl = await enforceRateLimit(`auth:signup:ip:${ip}`, 8, 60_000);
  if (!ipRl.ok) {
    return {
      error: `Too many sign-up attempts. Please wait ${ipRl.retryAfterSec}s and try again.`,
    };
  }

  const parsed = SignupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const data = parsed.data;
  const orgName = resolveOrganizationName({
    explicitName: data.orgName,
    email: data.email,
  });

  const [{ pricingConfig, presets }, origin, supabase] = await Promise.all([
    getPricingAndPresets(),
    getAppOrigin(),
    createSupabaseServerClient(),
  ]);
  const admin = getSupabaseAdmin();

  const outcome = await executePilotSignup(
    {
      orgName,
      contactName: data.contactName,
      email: data.email,
      password: data.password,
      whatsappNumber: data.whatsappNumber,
      selectionType: data.selectionType,
      planId: data.planId,
      events: data.events,
      certsPerEvent: data.certsPerEvent,
      months: data.months,
      idempotencyKey: data.idempotencyKey,
    },
    {
      pricingConfig,
      presets,
      async createAuthUser({ email, password, metadata }) {
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: metadata,
        });

        if (error) {
          const msg = (error.message || "").toLowerCase();
          const alreadyExists =
            msg.includes("already been registered") ||
            msg.includes("already registered") ||
            msg.includes("already exists") ||
            error.status === 422;
          return {
            ok: false,
            alreadyExists,
            error: sanitizeClientErrorMessage(
              error,
              "Could not create account. Please check your details and try again.",
            ),
          };
        }

        if (!created.user?.id) {
          return {
            ok: false,
            alreadyExists: false,
            error: "Could not create user account. Please try again.",
          };
        }

        return { ok: true, userId: created.user.id };
      },
      async deleteAuthUser(userId) {
        await admin.auth.admin.deleteUser(userId);
      },
      async signInWithPassword({ email, password }) {
        const { data: signedIn, error } =
          await supabase.auth.signInWithPassword({
            email,
            password,
          });
        if (error || !signedIn.user?.id) {
          return { ok: false, error: error?.message };
        }
        return { ok: true, userId: signedIn.user.id };
      },
      async runSignupPendingOrgRpc(params) {
        const { data: rpcRows, error: rpcErr } = await admin.rpc(
          "signup_pending_organization",
          {
            p_user_id: params.userId,
            p_email: params.email,
            p_org_name: params.orgName,
            p_contact_name: params.contactName,
            p_whatsapp_number: params.whatsappNumber,
            p_plan_id: params.planId,
            p_kind: params.kind,
            p_events_total: params.eventsTotal,
            p_certs_per_event: params.certsPerEvent,
            p_months: params.months,
            p_list_price_pkr: params.listPricePkr,
            p_discount_pkr: params.discountPkr,
            p_final_price_pkr: params.finalPricePkr,
            p_price_snapshot: params.priceSnapshot,
            p_idempotency_key: params.idempotencyKey,
          },
        );

        if (rpcErr || !rpcRows) {
          throw new Error(
            sanitizeClientErrorMessage(
              rpcErr,
              "Could not save your organization signup request.",
            ),
          );
        }

        const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
          | Record<string, unknown>
          | undefined;
        if (!row?.org_id || !row?.purchase_id) {
          throw new Error("Could not save your organization signup request.");
        }

        return {
          orgId: String(row.org_id),
          orgStatus: String(row.org_status ?? "pending"),
          purchaseId: String(row.purchase_id),
          purchaseStatus: String(row.purchase_status ?? "pending"),
          alreadyExisted: Boolean(row.already_existed),
        };
      },
      async onAfterCreated({ orgId, purchaseId, alreadyExisted, resolvedPlan }) {
        if (!alreadyExisted) {
          // Non-blocking Resend email notification when EMAILS_ENABLED=true
          await notifySuperAdminNewSignupRequest({
            orgName,
            contactName: data.contactName,
            email: data.email,
            whatsappNumber: data.whatsappNumber,
            planSummary: resolvedPlan.planSummary,
            listPricePkr: resolvedPlan.breakdown.listPricePkr,
            finalPricePkr: resolvedPlan.breakdown.finalPricePkr,
          });
        }

        // Optional gateway checkout (OFF by default: PAYMENT_GATEWAY_ENABLED=false)
        if (isPaymentGatewayEnabled() && !alreadyExisted) {
          try {
            const provider = getPaymentProvider();
            const checkout = await provider.createCheckout({
              purchaseId,
              amount: resolvedPlan.breakdown.finalPricePkr,
              currency: "PKR",
              customer: {
                name: data.contactName,
                email: data.email,
                phone: data.whatsappNumber,
                orgId,
                orgName,
              },
              returnUrl: `${origin}/pending`,
            });

            await admin.from("payments").insert({
              org_id: orgId,
              purchase_id: purchaseId,
              provider: provider.name,
              provider_ref: checkout.providerRef,
              amount: resolvedPlan.breakdown.finalPricePkr,
              currency: "PKR",
              status: "created",
              raw_event: { checkout_url: checkout.checkoutUrl },
            });

            revalidatePath("/superadmin", "layout");
            return { redirectTo: checkout.checkoutUrl };
          } catch (gatewayErr) {
            console.error(
              "[auth:signupAction] Payment gateway checkout init failed, falling back to /pending:",
              gatewayErr,
            );
          }
        }

        revalidatePath("/superadmin", "layout");
        revalidatePath("/pending");
      },
    },
  );

  if (outcome.error) {
    return {
      error: outcome.error,
      redirectTo: outcome.redirectTo,
    };
  }

  return {
    success: true,
    redirectTo: outcome.redirectTo || "/pending",
  };
}

export async function loginAction(input: {
  email: string;
  password: string;
  next?: string;
}): Promise<AuthActionResult> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);

  const parsed = LoginInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const { email, password, next } = parsed.data;

  const [ipRl, emailRl] = await Promise.all([
    enforceRateLimit(`auth:login:ip:${ip}`, 10, 60_000),
    enforceRateLimit(`auth:login:email:${email}`, 6, 60_000),
  ]);

  if (!ipRl.ok || !emailRl.ok) {
    const wait = !ipRl.ok
      ? ipRl.retryAfterSec
      : !emailRl.ok
        ? emailRl.retryAfterSec
        : 60;
    return {
      error: `Too many sign-in attempts. Please wait ${wait}s before trying again.`,
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: "Invalid email or password." };
  }

  const [{ org }, isSuperAdmin] = await Promise.all([
    getCurrentOrgResult(),
    isUserInSuperAdminsTable(data.user?.id),
  ]);

  if (!isSuperAdmin && (!org || org.status !== "active")) {
    return {
      success: true,
      redirectTo: "/pending",
    };
  }

  return {
    success: true,
    redirectTo: safeNextPath(next, "/dashboard"),
  };
}

export async function retryProvisionOrganizationAction(input?: {
  orgName?: string;
}): Promise<AuthActionResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const cleanExplicit =
    typeof input?.orgName === "string"
      ? input.orgName.trim().slice(0, 200)
      : undefined;

  const resolvedName = resolveOrganizationName({
    explicitName: cleanExplicit,
    userMetadata: user.userMetadata,
    email: user.email,
  });

  try {
    const [org, isSuperAdmin] = await Promise.all([
      provisionOrganizationForUser(
        user.id,
        resolvedName,
        user.email,
        user.userMetadata,
      ),
      isUserInSuperAdminsTable(user.id),
    ]);
    revalidatePath("/dashboard", "layout");
    revalidatePath("/pending");
    return {
      success: true,
      redirectTo:
        org.status === "active" || isSuperAdmin ? "/dashboard" : "/pending",
    };
  } catch (err) {
    console.error(
      "[auth:retryProvisionOrganizationAction] Provisioning retry failed:",
      err,
    );
    return {
      error: "Could not set up your organization right now. Please try again.",
    };
  }
}

export async function logoutAction(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function forgotPasswordAction(input: {
  email: string;
}): Promise<AuthActionResult> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);

  const parsed = ForgotPasswordInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const { email } = parsed.data;
  const [ipRl, emailRl] = await Promise.all([
    enforceRateLimit(`auth:forgot:ip:${ip}`, 5, 60_000),
    enforceRateLimit(`auth:forgot:email:${email}`, 3, 60_000),
  ]);

  if (!ipRl.ok || !emailRl.ok) {
    return {
      error:
        "Too many password reset requests. Please wait a minute and try again.",
    };
  }

  const origin = await getAppOrigin();
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  if (error) {
    console.error("[auth:forgotPasswordAction] error:", error);
    return {
      error:
        "Could not send password reset email right now. Please try again shortly.",
    };
  }

  return { success: true, email };
}

export async function resetPasswordAction(input: {
  password: string;
  code?: string;
  tokenHash?: string;
  type?: string;
}): Promise<AuthActionResult> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);

  const ipRl = await enforceRateLimit(`auth:reset:ip:${ip}`, 6, 60_000);
  if (!ipRl.ok) {
    return {
      error:
        "Too many password reset attempts. Please wait a minute and try again.",
    };
  }

  const parsed = ResetPasswordInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const { password, code, tokenHash, type } = parsed.data;
  const supabase = await createSupabaseServerClient();

  let user = await getCurrentUser();
  if (!user && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return {
        error: "Your password reset link is invalid or has expired.",
      };
    }
    user = await getCurrentUser();
  } else if (!user && tokenHash) {
    const otpType = (type as EmailOtpType) || "recovery";
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });
    if (error) {
      return {
        error: "Your password reset link is invalid or has expired.",
      };
    }
    user = await getCurrentUser();
  }

  if (!user) {
    return {
      error:
        "Your password reset session has expired. Please request a new reset link.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Could not update password. Please choose a different password.",
      ),
    };
  }

  return { success: true, redirectTo: "/dashboard" };
}
