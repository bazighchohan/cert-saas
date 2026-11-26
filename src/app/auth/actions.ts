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
import { clientIpFromHeaders, enforceRateLimit } from "@/lib/rate-limit";
import {
  ForgotPasswordInputSchema,
  LoginInputSchema,
  ResetPasswordInputSchema,
  SignupInputSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
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
  email: string;
  password: string;
}): Promise<AuthActionResult> {
  const h = await headers();
  const ip = clientIpFromHeaders(h);

  const ipRl = await enforceRateLimit(`auth:signup:ip:${ip}`, 5, 60_000);
  if (!ipRl.ok) {
    return {
      error: `Too many sign-up attempts. Please wait ${ipRl.retryAfterSec}s and try again.`,
    };
  }

  const parsed = SignupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const { orgName: rawOrgName, email, password } = parsed.data;
  const orgName = resolveOrganizationName({
    explicitName: rawOrgName,
    email,
  });

  const origin = await getAppOrigin();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        organization_name: orgName,
        org_name: orgName,
      },
      emailRedirectTo: `${origin}/auth/callback?next=/dashboard`,
    },
  });

  if (error) {
    console.error("[auth:signupAction] Supabase signUp error:", error);
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Could not create account. Please check your details and try again.",
      ),
    };
  }

  if (!data.user) {
    return { error: "Could not create user account. Please try again." };
  }

  if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return {
      error: "An account with this email already exists. Please sign in instead.",
    };
  }

  try {
    await provisionOrganizationForUser(
      data.user.id,
      orgName,
      email,
      data.user.user_metadata as Record<string, unknown> | undefined,
    );
  } catch (err) {
    console.error("[auth:signupAction] Organization provisioning failed:", err);
    if (data.session) {
      return {
        error: "Account created, but organization setup failed. Please retry from the dashboard.",
      };
    }
  }

  if (data.session) {
    return { success: true, redirectTo: "/dashboard" };
  }

  return {
    success: true,
    requiresEmailConfirmation: true,
    email,
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
    const wait = !ipRl.ok ? ipRl.retryAfterSec : !emailRl.ok ? emailRl.retryAfterSec : 60;
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

  if (org?.status === "suspended" && !isSuperAdmin) {
    await supabase.auth.signOut();
    return {
      error:
        "This organization account has been suspended. Please contact platform support.",
    };
  }

  return {
    success: true,
    redirectTo: safeNextPath(
      next,
      org?.status === "suspended" && isSuperAdmin ? "/superadmin" : "/dashboard",
    ),
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
    typeof input?.orgName === "string" ? input.orgName.trim().slice(0, 200) : undefined;

  const resolvedName = resolveOrganizationName({
    explicitName: cleanExplicit,
    userMetadata: user.userMetadata,
    email: user.email,
  });

  try {
    await provisionOrganizationForUser(
      user.id,
      resolvedName,
      user.email,
      user.userMetadata,
    );
    revalidatePath("/dashboard", "layout");
    return { success: true, redirectTo: "/dashboard" };
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
      error: "Too many password reset requests. Please wait a minute and try again.",
    };
  }

  const origin = await getAppOrigin();
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  if (error) {
    console.error("[auth:forgotPasswordAction] error:", error);
    // Return generic success or safe message to prevent account enumeration & stack leaks
    return {
      error: "Could not send password reset email right now. Please try again shortly.",
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
      error: "Too many password reset attempts. Please wait a minute and try again.",
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
