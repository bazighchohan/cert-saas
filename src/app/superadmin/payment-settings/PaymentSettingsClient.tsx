"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, useToast } from "@/components/ui";
import type { PlatformFeatureFlags } from "@/lib/feature-flags";
import type { PaymentSettingsData } from "@/lib/superadmin-data";
import { superAdminUpdatePaymentSettingsAction } from "../actions";

export default function PaymentSettingsClient({
  initialSettings,
  featureFlags,
}: {
  initialSettings: PaymentSettingsData;
  featureFlags: PlatformFeatureFlags;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [bankEnabled, setBankEnabled] = useState(initialSettings.bankEnabled);
  const [bankName, setBankName] = useState(initialSettings.bankName);
  const [bankAccountTitle, setBankAccountTitle] = useState(
    initialSettings.bankAccountTitle,
  );
  const [bankAccountNumber, setBankAccountNumber] = useState(
    initialSettings.bankAccountNumber,
  );
  const [bankIban, setBankIban] = useState(initialSettings.bankIban);

  const [jazzcashEnabled, setJazzcashEnabled] = useState(
    initialSettings.jazzcashEnabled,
  );
  const [jazzcashAccountTitle, setJazzcashAccountTitle] = useState(
    initialSettings.jazzcashAccountTitle,
  );
  const [jazzcashNumber, setJazzcashNumber] = useState(
    initialSettings.jazzcashNumber,
  );

  const [easypaisaEnabled, setEasypaisaEnabled] = useState(
    initialSettings.easypaisaEnabled,
  );
  const [easypaisaAccountTitle, setEasypaisaAccountTitle] = useState(
    initialSettings.easypaisaAccountTitle,
  );
  const [easypaisaNumber, setEasypaisaNumber] = useState(
    initialSettings.easypaisaNumber,
  );

  const [instructions, setInstructions] = useState(
    initialSettings.instructions,
  );
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await superAdminUpdatePaymentSettingsAction({
        bankEnabled,
        bankName,
        bankAccountTitle,
        bankAccountNumber,
        bankIban,
        jazzcashEnabled,
        jazzcashAccountTitle,
        jazzcashNumber,
        easypaisaEnabled,
        easypaisaAccountTitle,
        easypaisaNumber,
        instructions,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast("Saved Bank, JazzCash, and Easypaisa payment settings.", "success");
      router.refresh();
    } catch {
      showToast("Failed to save payment settings.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Payment Settings &amp; Feature Flags
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Configure Bank Transfer, JazzCash, and Easypaisa receiving accounts
          shown when <code className="font-mono text-xs">REQUIRE_PAYMENT_PROOF=true</code>.
        </p>
      </div>

      {/* Feature Flags Status Banner */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-bold text-slate-900">
          Environment Feature Flags (Default: OFF)
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
            <span className="font-mono font-bold text-slate-800">
              REQUIRE_PAYMENT_PROOF
            </span>
            <p className="mt-1 font-semibold text-indigo-700">
              {featureFlags.requirePaymentProof ? "ENABLED" : "OFF (Pilot mode)"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Requires screenshot + TID + displays the bank/wallet accounts below.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
            <span className="font-mono font-bold text-slate-800">
              EMAILS_ENABLED
            </span>
            <p className="mt-1 font-semibold text-indigo-700">
              {featureFlags.emailsEnabled ? "ENABLED (Resend)" : "OFF"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Sends non-blocking Resend notifications on request, approval, and rejection.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
            <span className="font-mono font-bold text-slate-800">
              PAYMENT_GATEWAY_ENABLED
            </span>
            <p className="mt-1 font-semibold text-indigo-700">
              {featureFlags.paymentGatewayEnabled ? "ENABLED (Safepay)" : "OFF (ManualProvider)"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Switches between ManualProvider and SafepayProvider + /api/webhooks/safepay.
            </p>
          </div>
        </div>
      </section>

      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs"
      >
        {/* Bank Transfer */}
        <div className="space-y-3 border-b border-slate-100 pb-6">
          <label className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <input
              type="checkbox"
              checked={bankEnabled}
              onChange={(e) => setBankEnabled(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Bank Transfer (IBFT / Raast)
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Bank Name"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              required
            />
            <Input
              label="Account Title"
              value={bankAccountTitle}
              onChange={(e) => setBankAccountTitle(e.target.value)}
              required
            />
            <Input
              label="Account Number"
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              required
            />
            <Input
              label="IBAN"
              value={bankIban}
              onChange={(e) => setBankIban(e.target.value)}
            />
          </div>
        </div>

        {/* JazzCash */}
        <div className="space-y-3 border-b border-slate-100 pb-6">
          <label className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <input
              type="checkbox"
              checked={jazzcashEnabled}
              onChange={(e) => setJazzcashEnabled(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            JazzCash
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="JazzCash Account Title"
              value={jazzcashAccountTitle}
              onChange={(e) => setJazzcashAccountTitle(e.target.value)}
              required
            />
            <Input
              label="JazzCash Mobile / Account Number"
              value={jazzcashNumber}
              onChange={(e) => setJazzcashNumber(e.target.value)}
              required
            />
          </div>
        </div>

        {/* Easypaisa */}
        <div className="space-y-3 border-b border-slate-100 pb-6">
          <label className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <input
              type="checkbox"
              checked={easypaisaEnabled}
              onChange={(e) => setEasypaisaEnabled(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Easypaisa
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Easypaisa Account Title"
              value={easypaisaAccountTitle}
              onChange={(e) => setEasypaisaAccountTitle(e.target.value)}
              required
            />
            <Input
              label="Easypaisa Mobile / Account Number"
              value={easypaisaNumber}
              onChange={(e) => setEasypaisaNumber(e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="pay-instructions"
            className="mb-1.5 block text-xs font-semibold text-slate-700"
          >
            Payment Instructions Banner
          </label>
          <textarea
            id="pay-instructions"
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={1000}
            className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900"
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={saving}>
            Save Payment Settings
          </Button>
        </div>
      </form>
    </div>
  );
}
