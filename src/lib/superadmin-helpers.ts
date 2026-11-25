export interface MonthlyRevenuePoint {
  month: string; // YYYY-MM
  label: string; // e.g. "Nov 2026"
  revenuePkr: number;
  approvedCount: number;
}

export interface ApprovedPaymentForRevenue {
  amountPkr: number;
  status: "pending" | "approved" | "rejected";
  reviewedAt: string | null;
  createdAt: string;
}

export interface SuperAdminOrgRow {
  id: string;
  name: string;
  slug: string;
  planId: string;
  planName: string;
  status: "active" | "suspended";
  planExpiresAt: string | null;
  eventsCount: number;
  certificatesIssuedCount: number;
  downloadsCount: number;
  memberCount: number;
  ownerEmail: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

function formatMonthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1, 1));
  return dt.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Pure, deterministic monthly revenue aggregation over payment_requests.
 * Counts ONLY `status === 'approved'` rows, bucketed by `reviewedAt` (falling back to `createdAt`),
 * across a continuous 6-month (or wider) timeline ending at `referenceNowIso`.
 */
export function buildMonthlyRevenueSeries(
  payments: ApprovedPaymentForRevenue[],
  monthsWindow = 6,
  referenceNowIso?: string,
): {
  series: MonthlyRevenuePoint[];
  totalApprovedRevenuePkr: number;
  totalApprovedRequests: number;
} {
  const totalsByMonth = new Map<string, { revenuePkr: number; count: number }>();
  let totalApprovedRevenuePkr = 0;
  let totalApprovedRequests = 0;
  let earliestMonth: string | null = null;
  let latestMonth: string | null = null;

  for (const p of payments) {
    if (p.status !== "approved") continue;
    const amount = Math.max(0, Number(p.amountPkr ?? 0));
    totalApprovedRevenuePkr += amount;
    totalApprovedRequests += 1;

    const ts = (p.reviewedAt || p.createdAt || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ts)) continue;

    const cur = totalsByMonth.get(ts) ?? { revenuePkr: 0, count: 0 };
    cur.revenuePkr += amount;
    cur.count += 1;
    totalsByMonth.set(ts, cur);

    if (!earliestMonth || ts < earliestMonth) earliestMonth = ts;
    if (!latestMonth || ts > latestMonth) latestMonth = ts;
  }

  const refDate = new Date(referenceNowIso ?? new Date().toISOString());
  const refYear = refDate.getUTCFullYear();
  const refMonthIdx = refDate.getUTCMonth(); // 0..11

  // Determine end year/month (if an approved payment is dated in a future month in tests, include it)
  let endYear = refYear;
  let endMonthIdx = refMonthIdx;
  if (latestMonth) {
    const [ly, lm] = latestMonth.split("-").map(Number);
    if (ly! > endYear || (ly === endYear && lm! - 1 > endMonthIdx)) {
      endYear = ly!;
      endMonthIdx = lm! - 1;
    }
  }

  const endTotalMonths = endYear * 12 + endMonthIdx;
  let startTotalMonths = endTotalMonths - Math.max(1, monthsWindow - 1);

  if (earliestMonth) {
    const [ey, em] = earliestMonth.split("-").map(Number);
    const earliestTotal = ey! * 12 + (em! - 1);
    // Expand back up to 24 months if historical revenue exists
    startTotalMonths = Math.max(
      endTotalMonths - 23,
      Math.min(startTotalMonths, earliestTotal),
    );
  }

  const series: MonthlyRevenuePoint[] = [];
  for (let m = startTotalMonths; m <= endTotalMonths; m++) {
    const yr = Math.floor(m / 12);
    const mo = (m % 12) + 1;
    const key = `${yr}-${String(mo).padStart(2, "0")}`;
    const entry = totalsByMonth.get(key);
    series.push({
      month: key,
      label: formatMonthLabel(key),
      revenuePkr: entry?.revenuePkr ?? 0,
      approvedCount: entry?.count ?? 0,
    });
  }

  return {
    series,
    totalApprovedRevenuePkr,
    totalApprovedRequests,
  };
}

/**
 * Pure filter over SuperAdminOrgRow for the /superadmin/organizations table.
 */
export function filterSuperAdminOrganizations(params: {
  organizations: SuperAdminOrgRow[];
  search?: string;
  planFilter?: string;
  statusFilter?: "all" | "active" | "suspended";
}): SuperAdminOrgRow[] {
  const q = (params.search ?? "").trim().toLowerCase();
  const plan = (params.planFilter ?? "").trim().toLowerCase();
  const status = params.statusFilter ?? "all";

  return params.organizations.filter((org) => {
    if (status !== "all" && org.status !== status) return false;
    if (plan && plan !== "all" && org.planId.toLowerCase() !== plan) {
      return false;
    }
    if (q) {
      const hay = [
        org.name,
        org.slug,
        org.ownerEmail ?? "",
        org.planName,
        org.id,
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Computes the new `plan_expires_at` ISO timestamp when extending an organization's expiry.
 * Extends from `max(currentExpiresAt, now)` so expired orgs get the full extension from today,
 * while active orgs keep their remaining days plus `addDays`.
 */
export function computeExtendedExpiryIso(
  currentExpiresAt: string | null | undefined,
  addDays: number,
  nowMs = Date.now(),
): string {
  const currentMs = currentExpiresAt ? Date.parse(currentExpiresAt) : NaN;
  const baseMs =
    Number.isFinite(currentMs) && currentMs > nowMs ? currentMs : nowMs;
  return new Date(baseMs + addDays * 86_400_000).toISOString();
}
