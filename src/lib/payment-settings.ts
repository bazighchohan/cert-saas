import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";

export interface PaymentSettingsData {
  bankEnabled: boolean;
  bankName: string;
  bankAccountTitle: string;
  bankAccountNumber: string;
  bankIban: string;
  jazzcashEnabled: boolean;
  jazzcashAccountTitle: string;
  jazzcashNumber: string;
  easypaisaEnabled: boolean;
  easypaisaAccountTitle: string;
  easypaisaNumber: string;
  instructions: string;
  updatedAt: string | null;
}

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettingsData = {
  bankEnabled: true,
  bankName: "Meezan Bank",
  bankAccountTitle: "Cert SaaS Technologies",
  bankAccountNumber: "0101-0101234567",
  bankIban: "PK00MEZN0001010101234567",
  jazzcashEnabled: true,
  jazzcashAccountTitle: "Cert SaaS",
  jazzcashNumber: "0300-0000000",
  easypaisaEnabled: true,
  easypaisaAccountTitle: "Cert SaaS",
  easypaisaNumber: "0345-0000000",
  instructions:
    "Transfer the exact PKR amount, save your confirmation receipt, and enter the transaction reference.",
  updatedAt: null,
};

export async function getPaymentSettings(): Promise<PaymentSettingsData> {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("payment_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();

    if (error || !data) {
      return DEFAULT_PAYMENT_SETTINGS;
    }

    const r = data as Record<string, unknown>;
    return {
      bankEnabled: r.bank_enabled !== false,
      bankName: String(r.bank_name ?? DEFAULT_PAYMENT_SETTINGS.bankName),
      bankAccountTitle: String(
        r.bank_account_title ?? DEFAULT_PAYMENT_SETTINGS.bankAccountTitle,
      ),
      bankAccountNumber: String(
        r.bank_account_number ?? DEFAULT_PAYMENT_SETTINGS.bankAccountNumber,
      ),
      bankIban: String(r.bank_iban ?? DEFAULT_PAYMENT_SETTINGS.bankIban),
      jazzcashEnabled: r.jazzcash_enabled !== false,
      jazzcashAccountTitle: String(
        r.jazzcash_account_title ??
          DEFAULT_PAYMENT_SETTINGS.jazzcashAccountTitle,
      ),
      jazzcashNumber: String(
        r.jazzcash_number ?? DEFAULT_PAYMENT_SETTINGS.jazzcashNumber,
      ),
      easypaisaEnabled: r.easypaisa_enabled !== false,
      easypaisaAccountTitle: String(
        r.easypaisa_account_title ??
          DEFAULT_PAYMENT_SETTINGS.easypaisaAccountTitle,
      ),
      easypaisaNumber: String(
        r.easypaisa_number ?? DEFAULT_PAYMENT_SETTINGS.easypaisaNumber,
      ),
      instructions: String(
        r.instructions ?? DEFAULT_PAYMENT_SETTINGS.instructions,
      ),
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
    };
  } catch {
    return DEFAULT_PAYMENT_SETTINGS;
  }
}
