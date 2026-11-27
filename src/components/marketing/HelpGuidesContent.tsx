export interface HelpGuideSection {
  id: string;
  stepNumber: number;
  title: string;
  summary: string;
  steps: string[];
  tip: string;
}

export const HELP_GUIDES: HelpGuideSection[] = [
  {
    id: "create-event",
    stepNumber: 1,
    title: "Create an event",
    summary:
      "Set up an event workspace with a clean public link and attendee lookup label.",
    steps: [
      "Open Dashboard → Events and click Create Event (consumes 1 slot from your soonest-expiring active package).",
      "Enter your event title, optional subtitle, event date, and organizer contact email or phone.",
      "Choose a unique URL slug (for example, annual-hackathon-2026) — your public portal will live at /e/annual-hackathon-2026.",
      "In the Settings tab, pick the identifier label your attendees know (Roll Number, Registration ID, CNIC, or Email) and choose your per-certificate download limit (1, 3, or unlimited).",
    ],
    tip: "Keep the event unreleased while testing your template and attendee list; visitors to /e/your-slug will see a friendly 'Certificates are not available yet' notice until you toggle Released.",
  },
  {
    id: "upload-template",
    stepNumber: 2,
    title: "Upload a template",
    summary:
      "Attach one or more blank PDF or PNG/JPG certificate designs to your event.",
    steps: [
      "Open your event workspace and switch to the Template tab.",
      "Select the default 'Certificate of Participation' type — or click Add Certificate Type to create additional tiers such as Winner, Speaker, or Volunteer.",
      "Upload your blank certificate design (single-page or multi-page PDF, PNG, or JPEG up to 10 MB).",
      "If you uploaded a multi-page PDF, select which page contains the certificate artwork.",
    ],
    tip: "Leave the recipient name area blank on your artwork — CertSaaS stamps each attendee's name cleanly in vector text at download time.",
  },
  {
    id: "place-name",
    stepNumber: 3,
    title: "Place the name",
    summary:
      "Position the recipient's name box, font, color, and QR verification stamp visually.",
    steps: [
      "Inside the Template tab, drag the live name placement box directly onto the blank line of your certificate preview.",
      "Adjust the maximum width handles so long names automatically shrink to fit inside your margins.",
      "Choose font family (Times, Helvetica, or Courier), bold weight, font size, hex color, and alignment (left, center, or right).",
      "Click Generate Test PDF with a long sample name to inspect the exact output before releasing.",
    ],
    tip: "Enable QR Verification in Settings to stamp a scannable /verify/{CODE} QR code in any corner of the certificate.",
  },
  {
    id: "import-attendees",
    stepNumber: 4,
    title: "Import attendees",
    summary:
      "Bulk-import up to 5,000 attendees from CSV or Excel (.xlsx) with row-by-row validation.",
    steps: [
      "Open the Attendees tab and click Import CSV / Excel (you can also download the sample CSV template first).",
      "Upload your .csv or .xlsx file — CertSaaS automatically detects UTF-8 BOM, commas, semicolons, or tabs and previews the first 10 rows.",
      "Map your columns to Identifier, Full Name, optional Email, and Certificate Types.",
      "Review the validation summary (valid rows, invalid rows with exact row numbers, duplicates, and existing records), download the error CSV if any rows need attention, choose 'Skip existing' or 'Update existing names', and click Confirm Import.",
    ],
    tip: "If your attendee list exceeds your event's current certificate limit, request a Certificate Top-Up in Billing at any time.",
  },
  {
    id: "fix-name",
    stepNumber: 5,
    title: "Fix a name",
    summary:
      "Correct spelling mistakes on an attendee's certificate and log why the change was made.",
    steps: [
      "Open your event's Attendees tab (or Downloads tab) and search by the student's roll number, name, or email.",
      "Click Edit next to the attendee, update their Full Name or Identifier, and save.",
      "Open the Issues note field on that attendee to record why the correction was made (for example, 'Updated per student ID card verification on WhatsApp').",
      "If the attendee already used their download limit before the fix, also click Reset Download so they can download the corrected PDF.",
    ],
    tip: "PDFs are generated dynamically from the latest attendee record, so fixing a name takes effect immediately with no re-upload needed.",
  },
  {
    id: "reset-download",
    stepNumber: 6,
    title: "Reset a download",
    summary:
      "Grant another download when an attendee lost their file or had their name corrected.",
    steps: [
      "Go to your event's Attendees or Downloads tab and locate the attendee.",
      "Click Reset Download on their row (or on a specific certificate type if they hold multiple certificates).",
      "Their download_count resets to 0 immediately while preserving historical entries in download_log for your audit trail.",
    ],
    tip: "Resetting a download only affects that individual attendee — everyone else keeps your configured 1-download or 3-download limit.",
  },
  {
    id: "check-downloads",
    stepNumber: 7,
    title: "Check who downloaded",
    summary:
      "Track completion rates, inspect per-attendee timestamps, copy pending emails, and export reports.",
    steps: [
      "Open your event's Downloads tab to view summary cards (Total Attendees, Downloaded, Not Downloaded, and completion percentage) plus a daily downloads chart.",
      "Filter the table by Downloaded, Not Downloaded, or by specific Certificate Type.",
      "Click 'Copy emails of people who haven't downloaded' to paste reminder recipients straight into your email client.",
      "Click Export CSV or Export Excel (.xlsx) to download clean spreadsheets of downloaded or pending attendees, or inspect individual download history timestamps.",
    ],
    tip: "Even after your package validity window expires, you keep full read and Excel/CSV export access to all historical download records.",
  },
];

export default function HelpGuidesContent() {
  return (
    <div className="space-y-8">
      {/* Quick Jump Nav */}
      <nav
        aria-label="Guide topics"
        className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs"
      >
        {HELP_GUIDES.map((g) => (
          <a
            key={g.id}
            href={`#${g.id}`}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-800 focus-visible:outline-2 focus-visible:outline-indigo-600"
          >
            {g.stepNumber}. {g.title}
          </a>
        ))}
      </nav>

      {/* Step-by-Step Sections */}
      <div className="space-y-6">
        {HELP_GUIDES.map((guide) => (
          <section
            key={guide.id}
            id={guide.id}
            className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs sm:p-8"
          >
            <div className="flex items-start gap-3.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
                {guide.stepNumber}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold text-slate-900">
                  {guide.title}
                </h2>
                <p className="mt-1 text-sm text-slate-700">{guide.summary}</p>

                <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
                  {guide.steps.map((step, idx) => (
                    <li key={idx}>{step}</li>
                  ))}
                </ol>

                <p className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-xs font-medium text-indigo-950">
                  <strong>Tip:</strong> {guide.tip}
                </p>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
