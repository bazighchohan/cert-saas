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
  const rawOrgName = input.orgName.trim();
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (rawOrgName.length < 2 || rawOrgName.length > 200) {
    return { error: "Organization name must be between 2 and 200 characters." };
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }
  if (!password || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const orgName = resolveOrganizationName({
    explicitName: rawOrgName,
    email,
  });

  const origin = await getAppOrigin();
  const supabase = await createSupabaseServerClient();

  // Pass organization_name in options.data (user_metadata) so it survives
  // email confirmation links and future logins.
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
    return { error: error.message };
  }

  if (!data.user) {
    return { error: "Could not create user account. Please try again." };
  }

  // Supabase returns an obfuscated user with empty identities if the email is already registered
  // while email confirmations are enabled.
  if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return {
      error: "An account with this email already exists. Please sign in instead.",
    };
  }

  // Provision the organization, owner membership, and Free plan atomically & idempotently.
  try {
    await provisionOrganizationForUser(
      data.user.id,
      orgName,
      email,
      data.user.user_metadata as Record<string, unknown> | undefined,
    );
  } catch (err) {
    console.error("[auth:signupAction] Organization provisioning failed:", err);
    // If email confirmation is required, the user will auto-provision on callback/login;
    // if immediate session was created, surface the error or let dashboard retry page handle it.
    if (data.session) {
      const message =
        err instanceof Error ? err.message : "Failed to create organization.";
      return { error: message };
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
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (!email || !password) {
    return { error: "Please enter both email and password." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  // Ensure the user's organization exists and check if the organization is suspended.
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
      input.next,
      org?.status === "suspended" && isSuperAdmin ? "/superadmin" : "/dashboard",
    ),
  };
}

/**
 * Allows a logged-in user whose auto-provisioning failed to retry creating
 * their organization directly from the dashboard error view.
 */
export async function retryProvisionOrganizationAction(input?: {
  orgName?: string;
}): Promise<AuthActionResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const resolvedName = resolveOrganizationName({
    explicitName: input?.orgName,
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
      error:
        err instanceof Error
          ? err.message
          : "Could not set up your organization. Please try again.",
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
  const email = input.email.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  const origin = await getAppOrigin();
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  if (error) {
    return { error: error.message };
  }

  return { success: true, email };
}

export async function resetPasswordAction(input: {
  password: string;
  code?: string;
  tokenHash?: string;
  type?: string;
}): Promise<AuthActionResult> {
  const { password, code, tokenHash, type } = input;
  if (!password || password.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }

  const supabase = await createSupabaseServerClient();

  let user = await getCurrentUser();
  if (!user && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return { error: error.message };
    user = await getCurrentUser();
  } else if (!user && tokenHash) {
    const otpType = (type as EmailOtpType) || "recovery";
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });
    if (error) return { error: error.message };
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
    return { error: error.message };
  }

  return { success: true, redirectTo: "/dashboard" };
}
