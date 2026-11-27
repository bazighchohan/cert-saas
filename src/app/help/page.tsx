import type { Metadata } from "next";
import HelpGuidesContent from "@/components/marketing/HelpGuidesContent";
import MarketingShell from "@/components/marketing/MarketingShell";

export const metadata: Metadata = {
  title: "Help & Step-by-Step Guides",
  description:
    "Step-by-step guides on creating an event, uploading a template, placing recipient names, importing CSV/Excel attendees, fixing names, resetting downloads, and tracking completion.",
  alternates: {
    canonical: "/help",
  },
};

export default function PublicHelpPage() {
  return (
    <MarketingShell>
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-14 sm:px-6 sm:py-20">
        <header>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Step-by-Step Organizer Guides
          </h1>
          <p className="mt-2 text-base text-slate-700">
            Everything you need to create an event, position names on your
            template, import attendees, fix typos, reset download limits, and
            export download reports.
          </p>
        </header>

        <HelpGuidesContent />
      </div>
    </MarketingShell>
  );
}
