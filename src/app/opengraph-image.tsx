import { ImageResponse } from "next/og";

export const alt = "CertSaaS — Issue certificates online, no printing";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 60%, #312e81 100%)",
          color: "#ffffff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
          }}
        >
          <div
            style={{
              width: "52px",
              height: "52px",
              borderRadius: "14px",
              background: "#4f46e5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "22px",
              fontWeight: 800,
            }}
          >
            CS
          </div>
          <span
            style={{
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.02em",
            }}
          >
            CertSaaS
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div
            style={{
              fontSize: "64px",
              fontWeight: 800,
              lineHeight: 1.1,
              letterSpacing: "-0.03em",
              maxWidth: "960px",
            }}
          >
            Issue certificates online, no printing
          </div>
          <div
            style={{
              fontSize: "26px",
              color: "#cbd5e1",
              lineHeight: 1.4,
              maxWidth: "880px",
            }}
          >
            Upload your template &amp; CSV list | QR-verified PDF downloads |
            Real-time tracking for universities &amp; conferences
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: "16px",
            fontSize: "20px",
            fontWeight: 700,
            color: "#e0e7ff",
          }}
        >
          <span
            style={{
              padding: "10px 20px",
              borderRadius: "999px",
              background: "rgba(99, 102, 241, 0.25)",
            }}
          >
            QR Verification
          </span>
          <span
            style={{
              padding: "10px 20px",
              borderRadius: "999px",
              background: "rgba(99, 102, 241, 0.25)",
            }}
          >
            12-Month Retention
          </span>
          <span
            style={{
              padding: "10px 20px",
              borderRadius: "999px",
              background: "rgba(99, 102, 241, 0.25)",
            }}
          >
            Up to 5,000 Attendees / Import
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
