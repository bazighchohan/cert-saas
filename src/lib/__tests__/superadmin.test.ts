import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMonthlyRevenueSeries,
  computeExtendedExpiryIso,
  filterSuperAdminOrganizations,
  type SuperAdminOrgRow,
} from "../superadmin-helpers";

describe("buildMonthlyRevenueSeries", () => {
  it("sums ONLY approved payment_requests per month and ignores pending/rejected", () => {
    const res = buildMonthlyRevenueSeries(
      [
        {
          amountPkr: 2999,
          status: "approved",
          reviewedAt: "2026-09-14T10:00:00Z",
          createdAt: "2026-09-14T09:00:00Z",
        },
        {
          amountPkr: 7999,
          status: "approved",
          reviewedAt: "2026-11-02T12:00:00Z",
          createdAt: "2026-11-01T20:00:00Z",
        },
        {
          amountPkr: 2999,
          status: "approved",
          reviewedAt: "2026-11-18T15:30:00Z",
          createdAt: "2026-11-18T14:00:00Z",
        },
        {
          amountPkr: 7999,
          status: "pending",
          reviewedAt: null,
          createdAt: "2026-11-20T08:00:00Z",
        },
        {
          amountPkr: 2999,
          status: "rejected",
          reviewedAt: "2026-11-21T08:00:00Z",
          createdAt: "2026-11-20T08:00:00Z",
        },
      ],
      6,
      "2026-11-26T00:00:00Z",
    );

    assert.equal(res.totalApprovedRequests, 3);
    assert.equal(res.totalApprovedRevenuePkr, 2999 + 7999 + 2999);
    assert.equal(res.series.length, 6);
    assert.equal(res.series[0]?.month, "2026-06");
    assert.equal(res.series[res.series.length - 1]?.month, "2026-11");

    const byMonth = new Map(res.series.map((s) => [s.month, s]));
    assert.equal(byMonth.get("2026-09")?.revenuePkr, 2999);
    assert.equal(byMonth.get("2026-09")?.approvedCount, 1);
    assert.equal(byMonth.get("2026-10")?.revenuePkr, 0);
    assert.equal(byMonth.get("2026-11")?.revenuePkr, 10998);
    assert.equal(byMonth.get("2026-11")?.approvedCount, 2);
  });
});

describe("filterSuperAdminOrganizations & computeExtendedExpiryIso", () => {
  const ORGS: SuperAdminOrgRow[] = [
    {
      id: "org-1",
      name: "FAST Computing Society",
      slug: "fast-cs",
      planId: "starter",
      planName: "Starter",
      status: "active",
      planExpiresAt: "2026-12-20T00:00:00Z",
      eventsCount: 4,
      certificatesIssuedCount: 420,
      downloadsCount: 310,
      memberCount: 2,
      ownerEmail: "president@fast.edu.pk",
      lastLoginAt: "2026-11-25T18:00:00Z",
      createdAt: "2026-10-01T00:00:00Z",
    },
    {
      id: "org-2",
      name: "Spam Club",
      slug: "spam-club",
      planId: "free",
      planName: "Free",
      status: "suspended",
      planExpiresAt: null,
      eventsCount: 1,
      certificatesIssuedCount: 12,
      downloadsCount: 0,
      memberCount: 1,
      ownerEmail: "abuse@example.org",
      lastLoginAt: null,
      createdAt: "2026-11-10T00:00:00Z",
    },
  ];

  it("filters organizations by search query, planId, and active/suspended status", () => {
    assert.equal(filterSuperAdminOrganizations({ organizations: ORGS }).length, 2);

    assert.deepEqual(
      filterSuperAdminOrganizations({
        organizations: ORGS,
        statusFilter: "suspended",
      }).map((o) => o.id),
      ["org-2"],
    );

    assert.deepEqual(
      filterSuperAdminOrganizations({
        organizations: ORGS,
        planFilter: "starter",
      }).map((o) => o.id),
      ["org-1"],
    );

    assert.deepEqual(
      filterSuperAdminOrganizations({
        organizations: ORGS,
        search: "president@fast",
      }).map((o) => o.id),
      ["org-1"],
    );
  });

  it("extends expiry from future date when active, or from now when expired/null", () => {
    const nowMs = Date.parse("2026-11-26T00:00:00Z");

    // Active future expiry -> adds 30 days on top of remaining time
    const extendedFuture = computeExtendedExpiryIso(
      "2026-12-06T00:00:00Z",
      30,
      nowMs,
    );
    assert.equal(extendedFuture, "2027-01-05T00:00:00.000Z");

    // Past expired date -> adds 30 days starting from now
    const extendedExpired = computeExtendedExpiryIso(
      "2026-10-01T00:00:00Z",
      30,
      nowMs,
    );
    assert.equal(extendedExpired, "2026-12-26T00:00:00.000Z");
  });
});
