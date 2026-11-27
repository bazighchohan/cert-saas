import "server-only";

import type { Metadata } from "next";
import MarketingShell from "@/components/marketing/MarketingShell";
import PricingCardsSection from "@/components/pricing/PricingCardsSection";
import { getCurrentUser } from "@/lib/auth";
import { isPilotBannerEnabled } from "@/lib/feature-flags";
import { getPricingAndPresets } from "@/lib/pricing-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing & Event Packages",
  description:
    "Flexible event & certificate packages for universities, societies, and conferences. Every certificate stays downloadable for 12 months after release.",
  alternates: {
    canonical: "/pricing",
  },
};

export default async function PricingPage() {
  const [{ pricingConfig, presets }, user] = await Promise.all([
    getPricingAndPresets(),
    getCurrentUser(),
  ]);

  return (
    <MarketingShell isSignedIn={Boolean(user)}>
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <PricingCardsSection
          pricingConfig={pricingConfig}
          presets={presets}
          isSignedIn={Boolean(user)}
          showPilotBanner={isPilotBannerEnabled()}
          headingLevel="h1"
        />
      </div>
    </MarketingShell>
  );
}
