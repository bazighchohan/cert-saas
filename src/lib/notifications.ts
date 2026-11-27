import { areEmailsEnabled } from "@/lib/feature-flags";

export interface EmailSendResult {
  sent: boolean;
  skipped?: boolean;
  id?: string;
  error?: string;
}

type EnvLike = Record<string, string | undefined>;
type FetchLike = typeof fetch;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends a transactional email through Resend when `EMAILS_ENABLED=true`.
 * Failures are ALWAYS caught and logged — never throws and never blocks a request.
 */
export async function sendResendEmail(
  params: {
    to: string;
    subject: string;
    html: string;
    text: string;
  },
  options?: {
    env?: EnvLike;
    fetchImpl?: FetchLike;
  },
): Promise<EmailSendResult> {
  const env = options?.env ?? process.env;
  if (!areEmailsEnabled(env)) {
    return { sent: false, skipped: true };
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  const to = params.to.trim();

  if (!apiKey || !from || !to) {
    console.error("[notifications] EMAILS_ENABLED is true, but RESEND_API_KEY, EMAIL_FROM, or recipient is missing.");
    return {
      sent: false,
      error: "Missing RESEND_API_KEY, EMAIL_FROM, or recipient email.",
    };
  }

  const fetchFn = options?.fetchImpl ?? fetch;

  try {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error("[notifications] Resend API non-OK response:", {
        status: res.status,
        body: bodyText.slice(0, 300),
      });
      return {
        sent: false,
        error: `Resend HTTP ${res.status}`,
      };
    }

    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, id: json.id };
  } catch (err) {
    console.error("[notifications] Resend send failed (non-blocking):", err);
    return {
      sent: false,
      error: err instanceof Error ? err.message : "Unknown email error",
    };
  }
}

export async function notifySuperAdminNewSignupRequest(
  input: {
    orgName: string;
    contactName: string;
    email: string;
    whatsappNumber: string;
    planSummary: string;
    listPricePkr: number;
    finalPricePkr: number;
  },
  options?: { env?: EnvLike; fetchImpl?: FetchLike },
): Promise<EmailSendResult> {
  const env = options?.env ?? process.env;
  if (!areEmailsEnabled(env)) {
    return { sent: false, skipped: true };
  }

  const superAdminEmail = env.SUPER_ADMIN_EMAIL?.trim() ?? "";
  if (!superAdminEmail) {
    console.error("[notifications] EMAILS_ENABLED is true, but SUPER_ADMIN_EMAIL is not configured.");
    return { sent: false, error: "Missing SUPER_ADMIN_EMAIL" };
  }

  const subject = `[cert-saas] New Organization Request: ${input.orgName}`;
  const text = [
    `New organization signup awaiting approval:`,
    `Organization: ${input.orgName}`,
    `Contact: ${input.contactName}`,
    `Email: ${input.email}`,
    `WhatsApp: ${input.whatsappNumber}`,
    `Selected Plan: ${input.planSummary}`,
    `List Price: PKR ${input.listPricePkr.toLocaleString()} (Computed Total: PKR ${input.finalPricePkr.toLocaleString()})`,
    `Review in /superadmin/requests`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f172a">
      <h2>New Organization Request</h2>
      <p><strong>${escapeHtml(input.orgName)}</strong> has requested access.</p>
      <ul>
        <li><strong>Contact:</strong> ${escapeHtml(input.contactName)}</li>
        <li><strong>Email:</strong> ${escapeHtml(input.email)}</li>
        <li><strong>WhatsApp:</strong> ${escapeHtml(input.whatsappNumber)}</li>
        <li><strong>Plan:</strong> ${escapeHtml(input.planSummary)}</li>
        <li><strong>List Price:</strong> PKR ${input.listPricePkr.toLocaleString()} (Total: PKR ${input.finalPricePkr.toLocaleString()})</li>
      </ul>
      <p>Open <code>/superadmin/requests</code> to approve as pilot, approve as paid, or reject.</p>
    </div>
  `;

  return sendResendEmail({ to: superAdminEmail, subject, html, text }, options);
}

export async function notifyCustomerOrganizationApproved(
  input: {
    toEmail: string;
    contactName: string;
    orgName: string;
    isPilot: boolean;
    planSummary: string;
    expiresAt: string | null;
    dashboardUrl?: string;
  },
  options?: { env?: EnvLike; fetchImpl?: FetchLike },
): Promise<EmailSendResult> {
  const subject = `Your organization "${input.orgName}" has been approved!`;
  const dashUrl = input.dashboardUrl || "/dashboard";
  const text = [
    `Hi ${input.contactName || "there"},`,
    ``,
    `Your organization "${input.orgName}" has been approved (${input.isPilot ? "Pilot Package" : "Active Package"}).`,
    `Package: ${input.planSummary}`,
    input.expiresAt ? `Valid until: ${new Date(input.expiresAt).toUTCString()}` : "",
    ``,
    `Sign in to your dashboard: ${dashUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f172a">
      <h2>Your Organization Is Approved</h2>
      <p>Hi ${escapeHtml(input.contactName || "there")},</p>
      <p><strong>${escapeHtml(input.orgName)}</strong> is now active (${input.isPilot ? "Pilot Package" : "Paid Package"}).</p>
      <p><strong>Package:</strong> ${escapeHtml(input.planSummary)}</p>
      <p><a href="${escapeHtml(dashUrl)}">Open your Organization Dashboard</a></p>
    </div>
  `;

  return sendResendEmail(
    { to: input.toEmail, subject, html, text },
    options,
  );
}

export async function notifyCustomerOrganizationRejected(
  input: {
    toEmail: string;
    contactName: string;
    orgName: string;
    reason: string;
  },
  options?: { env?: EnvLike; fetchImpl?: FetchLike },
): Promise<EmailSendResult> {
  const subject = `Update on your organization request ("${input.orgName}")`;
  const text = [
    `Hi ${input.contactName || "there"},`,
    ``,
    `We could not approve the organization request for "${input.orgName}".`,
    `Reason: ${input.reason}`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f172a">
      <h2>Update on Your Request</h2>
      <p>Hi ${escapeHtml(input.contactName || "there")},</p>
      <p>We could not approve the request for <strong>${escapeHtml(input.orgName)}</strong>.</p>
      <p><strong>Reason:</strong> ${escapeHtml(input.reason)}</p>
    </div>
  `;

  return sendResendEmail(
    { to: input.toEmail, subject, html, text },
    options,
  );
}
