import type { Metadata } from "next";
import Script from "next/script";
import { getCookieFreeAnalyticsConfig } from "@/lib/feature-flags";
import "./globals.css";

function resolveSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && !configured.includes(".supabase.co")) {
    return configured.replace(/\/+$/, "");
  }
  return "https://certsaas.pk";
}

const siteUrl = resolveSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "CertSaaS — Issue Certificates Online, No Printing",
    template: "%s | CertSaaS",
  },
  description:
    "Upload your certificate template and attendee list, let recipients download verified PDFs with QR codes, and track who downloaded in real time.",
  openGraph: {
    type: "website",
    siteName: "CertSaaS",
    locale: "en_US",
    url: siteUrl,
    title: "CertSaaS — Issue Certificates Online, No Printing",
    description:
      "Issue tamper-evident digital PDF certificates with QR verification, CSV/Excel imports, and real-time download tracking.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CertSaaS — Issue Certificates Online, No Printing",
    description:
      "Upload your certificate template and attendee list, let attendees download verified PDFs, and track downloads.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const analytics = getCookieFreeAnalyticsConfig();

  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        {analytics.enabled && analytics.scriptSrc && analytics.domain && (
          <Script
            src={analytics.scriptSrc}
            data-domain={analytics.domain}
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
