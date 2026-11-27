import type { MetadataRoute } from "next";

function getSiteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && !configured.includes(".supabase.co")) {
    return configured.replace(/\/+$/, "");
  }
  return "https://certsaas.pk";
}

export default function robots(): MetadataRoute.Robots {
  const origin = getSiteOrigin();

  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/pricing",
          "/help",
          "/contact",
          "/terms",
          "/privacy",
          "/e/",
          "/verify/",
        ],
        disallow: [
          "/dashboard/",
          "/superadmin/",
          "/admin/",
          "/pending",
          "/api/",
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
