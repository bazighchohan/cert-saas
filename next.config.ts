import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

let analyticsOrigin = "";
if (
  (process.env.ANALYTICS_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "true") &&
  process.env.NEXT_PUBLIC_ANALYTICS_SRC
) {
  try {
    analyticsOrigin = ` ${new URL(process.env.NEXT_PUBLIC_ANALYTICS_SRC).origin}`;
  } catch {
    analyticsOrigin = "";
  }
}

// Content Security Policy:
// - Allows Next.js runtime scripts/styles + pdfjs-dist worker (`blob:`) + data/blob previews
// - Restricts network connections (`connect-src`) to same-origin, Supabase HTTPS endpoints, and optional cookie-free analytics origin
// - Blocks <object>/<embed>, framing (`frame-ancestors 'none'`), base-tag hijacking, and cross-origin form posts
const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${analyticsOrigin}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  `connect-src 'self' https://*.supabase.co${analyticsOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: cspDirectives,
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/public/e/[slug]/download": [
      "./public/samples/blank-template.pdf",
      "./public/fonts/**/*",
    ],
    "/api/public/e/[slug]/preview": [
      "./public/samples/blank-template.pdf",
      "./public/fonts/**/*",
    ],
    "/api/dashboard/templates/[certTypeId]/test-pdf": [
      "./public/samples/blank-template.pdf",
      "./public/fonts/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
