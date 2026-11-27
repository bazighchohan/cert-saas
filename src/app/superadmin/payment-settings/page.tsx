import "server-only";

import { getFeatureFlags } from "@/lib/feature-flags";
import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getPaymentSettings } from "@/lib/superadmin-data";
import PaymentSettingsClient from "./PaymentSettingsClient";

export const dynamic = "force-dynamic";

export default async function SuperAdminPaymentSettingsPage() {
  const access = await checkSuperAdminPageAccess();
  if (!access.authorized) {
    return null;
  }

  const settings = await getPaymentSettings();
  const featureFlags = getFeatureFlags();

  return (
    <PaymentSettingsClient
      initialSettings={settings}
      featureFlags={featureFlags}
    />
  );
}
