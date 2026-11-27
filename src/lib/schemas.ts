import { z } from "zod";
import { MAX_IMPORT_ROWS } from "@/lib/tabular-import";

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------
export const UuidSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Invalid identifier format.",
  );

export const EventSlugParamSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Invalid event slug.")
  .max(80, "Event slug is too long.")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Invalid URL-safe event slug.");

export const VerifyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{8,32}$/, "Invalid verification code format.");

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email address is too long.")
  .email("Please enter a valid email address.");

// -----------------------------------------------------------------------------
// Auth Server Actions
// -----------------------------------------------------------------------------
export const WhatsappNumberSchema = z
  .string()
  .trim()
  .min(6, "Please enter a valid WhatsApp number (e.g. +92 300 1234567).")
  .max(30, "WhatsApp number is too long.")
  .regex(
    /^\+?[0-9][0-9\s()-]{4,28}[0-9]$/,
    "Please enter a valid WhatsApp number (digits, spaces, or leading +).",
  );

export const SignupInputSchema = z.object({
  orgName: z
    .string()
    .trim()
    .min(2, "Organization name must be between 2 and 200 characters.")
    .max(200, "Organization name must be between 2 and 200 characters."),
  contactName: z
    .string()
    .trim()
    .min(2, "Contact person name must be between 2 and 200 characters.")
    .max(200, "Contact person name must be between 2 and 200 characters."),
  email: EmailSchema,
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(128, "Password cannot exceed 128 characters."),
  whatsappNumber: WhatsappNumberSchema,
  selectionType: z.enum(["preset", "custom"]).default("preset"),
  planId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/, "Please choose a valid plan preset.")
    .optional()
    .or(z.literal("")),
  events: z.coerce.number().int().min(1).max(20).optional(),
  certsPerEvent: z.coerce.number().int().min(25).max(500).optional(),
  months: z.coerce.number().int().optional(),
  idempotencyKey: z.string().trim().max(120).optional(),
});

export const LoginInputSchema = z.object({
  email: EmailSchema,
  password: z
    .string()
    .min(1, "Please enter both email and password.")
    .max(128, "Password cannot exceed 128 characters."),
  next: z.string().max(512).optional(),
});

export const ForgotPasswordInputSchema = z.object({
  email: EmailSchema,
});

export const ResetPasswordInputSchema = z.object({
  password: z
    .string()
    .min(8, "New password must be at least 8 characters.")
    .max(128, "Password cannot exceed 128 characters."),
  code: z.string().max(512).optional(),
  tokenHash: z.string().max(512).optional(),
  type: z.string().max(64).optional(),
});

// -----------------------------------------------------------------------------
// Events Server Actions & Settings
// -----------------------------------------------------------------------------
export const EventDetailsInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Event title must be between 2 and 200 characters.")
    .max(200, "Event title must be between 2 and 200 characters."),
  subtitle: z
    .string()
    .trim()
    .max(300, "Subtitle cannot exceed 300 characters.")
    .optional()
    .or(z.literal("")),
  slug: z.string().trim().min(2).max(80),
  eventDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Event date must be a valid YYYY-MM-DD date.")
    .optional()
    .or(z.literal("")),
  contactEmail: EmailSchema.optional().or(z.literal("")),
  contactPhone: z
    .string()
    .trim()
    .max(40, "Contact phone cannot exceed 40 characters.")
    .optional()
    .or(z.literal("")),
});

export const UpdateEventOverviewSchema = EventDetailsInputSchema.extend({
  eventId: UuidSchema,
});

export const UpdateEventSettingsSchema = z.object({
  eventId: UuidSchema,
  released: z.boolean(),
  identifierLabel: z
    .string()
    .trim()
    .min(1, "Identifier label must be between 1 and 60 characters.")
    .max(60, "Identifier label must be between 1 and 60 characters."),
  uppercaseIdentifiers: z.boolean().optional(),
  requireNameMatch: z.boolean(),
  downloadLimit: z.union([z.literal(1), z.literal(3), z.null()]),
  showQr: z.boolean().optional(),
  qrPosition: z
    .enum(["bottom-right", "bottom-left", "top-right", "top-left", "custom"])
    .optional(),
});

export const DeleteEventSchema = z.object({
  eventId: UuidSchema,
  confirmSlug: z.string().trim().min(1).max(100),
});

export const DeleteEventDataSchema = z.object({
  eventId: UuidSchema,
  confirmSlug: z.string().trim().min(1).max(100),
});

export const DeleteOrganizationSchema = z.object({
  confirmSlug: z.string().trim().min(2).max(100),
});

export const UpdateOrgNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Organization name must be between 2 and 200 characters.")
    .max(200, "Organization name must be between 2 and 200 characters."),
});

export const ChangePasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, "New password must be at least 8 characters.")
    .max(128, "New password cannot exceed 128 characters."),
});

// -----------------------------------------------------------------------------
// Templates & Placement Schemas
// -----------------------------------------------------------------------------
export const AddCertificateTypeSchema = z.object({
  eventId: UuidSchema,
  label: z
    .string()
    .trim()
    .min(2, "Certificate type label must be between 2 and 80 characters.")
    .max(80, "Certificate type label must be between 2 and 80 characters."),
});

export const RenameCertificateTypeSchema = AddCertificateTypeSchema.extend({
  certTypeId: UuidSchema,
});

export const SelectTemplatePageSchema = z.object({
  eventId: UuidSchema,
  certTypeId: UuidSchema,
  pageIndex: z.number().int().min(0).max(500),
});

export const DeleteCertificateTypeSchema = z.object({
  eventId: UuidSchema,
  certTypeId: UuidSchema,
});

export const SaveNamePlacementSchema = z.object({
  eventId: UuidSchema,
  certTypeId: UuidSchema,
  nameXPt: z.number().finite().min(0).max(10_000),
  nameYPt: z.number().finite().min(0).max(10_000),
  maxNameWidthPt: z.number().finite().min(10).max(10_000),
  nameFont: z.string().trim().min(1).max(80),
  nameBold: z.boolean(),
  nameSizePt: z.number().finite().min(4).max(300),
  nameColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a 6-digit hex code."),
  nameAlign: z.enum(["left", "center", "right"]),
});

export const TestPdfBodySchema = z.object({
  sampleName: z.string().trim().max(200).optional(),
  pageIndex: z.number().int().min(0).max(500).optional(),
  nameXPt: z.number().finite().min(0).max(10_000).optional(),
  nameYPt: z.number().finite().min(0).max(10_000).optional(),
  maxNameWidthPt: z.number().finite().min(10).max(10_000).optional(),
  nameFont: z.string().trim().max(80).optional(),
  nameBold: z.boolean().optional(),
  nameSizePt: z.number().finite().min(4).max(300).optional(),
  nameColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  nameAlign: z.enum(["left", "center", "right"]).optional(),
});

// -----------------------------------------------------------------------------
// Attendees, Imports & Downloads Schemas
// -----------------------------------------------------------------------------
export const AttendeesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().max(200).optional().default(""),
  source: z.enum(["csv", "manual", "all", ""]).optional().default(""),
  sortBy: z
    .enum([
      "created_at",
      "identifier",
      "full_name",
      "email",
      "source",
      "downloads",
    ])
    .optional()
    .default("created_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const AddAttendeeInputSchema = z.object({
  eventId: UuidSchema,
  identifier: z.string().trim().min(1).max(120),
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(254).optional(),
  note: z.string().trim().max(500).optional(),
  certificateTypeIds: z.array(UuidSchema).max(50),
});

export const UpdateAttendeeInputSchema = z.object({
  eventId: UuidSchema,
  attendeeId: UuidSchema,
  identifier: z.string().trim().min(1).max(120),
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(254).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const DeleteAttendeeInputSchema = z.object({
  eventId: UuidSchema,
  attendeeId: UuidSchema,
});

export const BulkDeleteAttendeesInputSchema = z.object({
  eventId: UuidSchema,
  attendeeIds: z.array(UuidSchema).min(1).max(5000),
});

export const SetAttendeeCertTypeInputSchema = z.object({
  eventId: UuidSchema,
  attendeeId: UuidSchema,
  certificateTypeId: UuidSchema,
  assigned: z.boolean(),
});

export const BulkSetCertTypeInputSchema = z.object({
  eventId: UuidSchema,
  attendeeIds: z.array(UuidSchema).min(1).max(5000),
  certificateTypeId: UuidSchema,
  assigned: z.boolean(),
});

export const ResetAttendeeDownloadsInputSchema = z.object({
  eventId: UuidSchema,
  attendeeId: UuidSchema,
  attendeeCertificateId: UuidSchema.optional(),
});

export const SaveAttendeeIssueNoteInputSchema = z.object({
  eventId: UuidSchema,
  attendeeId: UuidSchema,
  issueNote: z.string().max(1000, "Issue note cannot exceed 1,000 characters."),
});

export const ImportPreviewBodySchema = z.object({
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().min(1).max(1_000_000),
        cells: z.array(z.string().max(2000)).max(200),
      }),
    )
    .min(1, "At least one row is required.")
    .max(MAX_IMPORT_ROWS, `Import exceeds maximum of ${MAX_IMPORT_ROWS.toLocaleString()} rows.`),
  mapping: z.object({
    identifierCol: z.number().int().min(0).max(200).nullable(),
    fullNameCol: z.number().int().min(0).max(200).nullable(),
    emailCol: z.number().int().min(0).max(200).nullable(),
    noteCol: z.number().int().min(0).max(200).nullable(),
    certTypesCol: z.number().int().min(0).max(200).nullable(),
    perTypeCols: z.record(z.string(), z.number().int().min(0).max(200).nullable()).optional(),
    defaultTypeIds: z.array(UuidSchema).max(50),
  }),
});

export const ImportConfirmBodySchema = z.object({
  mode: z.enum(["skip", "update"]).default("skip"),
  preparedRows: z
    .array(
      z.object({
        rowNumber: z.number().int().min(1).max(1_000_000).default(1),
        identifier: z.string().trim().min(1).max(120),
        fullName: z.string().trim().min(1).max(200),
        email: z.string().max(254).nullable(),
        note: z.string().max(500).nullable(),
        typeIds: z.array(UuidSchema).max(50),
        isExistingInEvent: z.boolean().default(false),
      }),
    )
    .min(1, "No valid rows provided to import.")
    .max(MAX_IMPORT_ROWS, `Import exceeds maximum of ${MAX_IMPORT_ROWS.toLocaleString()} rows.`),
});

export const DownloadsQuerySchema = z.object({
  status: z
    .enum(["all", "downloaded", "not_downloaded"])
    .optional()
    .default("all"),
  certTypeId: z
    .union([UuidSchema, z.literal("")])
    .optional()
    .default(""),
  search: z.string().max(200).optional().default(""),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const DownloadsExportQuerySchema = z.object({
  status: z
    .enum(["all", "downloaded", "not_downloaded"])
    .optional()
    .default("downloaded"),
  format: z.enum(["csv", "xlsx"]).optional().default("csv"),
  certTypeId: z
    .union([UuidSchema, z.literal("")])
    .optional()
    .default(""),
});

// -----------------------------------------------------------------------------
// Public Student Portal & Verification Schemas
// -----------------------------------------------------------------------------
export const PublicLookupBodySchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Please enter your valid identifier.")
    .max(100, "Identifier cannot exceed 100 characters."),
  fullName: z.string().trim().max(200).optional().default(""),
});

export const PublicPreviewQuerySchema = z.object({
  token: z.string().min(16).max(2048),
  certId: UuidSchema,
});

export const PublicDownloadBodySchema = z.object({
  token: z.string().min(16).max(2048),
  attendeeCertificateId: UuidSchema,
});

// -----------------------------------------------------------------------------
// Billing, Packages, Top-ups & Superadmin Schemas
// -----------------------------------------------------------------------------
export const PaymentUpgradeFieldsSchema = z.object({
  planId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/, "Please select a valid preset."),
  paymentMethod: z.enum(["bank", "jazzcash", "easypaisa"], {
    message: "Payment method must be Bank Transfer, JazzCash, or Easypaisa.",
  }),
  transactionReference: z
    .string()
    .trim()
    .min(2, "Transaction reference / TID must be between 2 and 120 characters.")
    .max(120, "Transaction reference / TID must be between 2 and 120 characters."),
});

export const PurchaseRequestFieldsSchema = z.object({
  selectionType: z.enum(["preset", "custom"]).default("preset"),
  planId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/)
    .optional()
    .or(z.literal("")),
  events: z.coerce.number().int().min(1).max(20).optional(),
  certsPerEvent: z.coerce.number().int().min(25).max(500).optional(),
  months: z.coerce.number().int().optional(),
  paymentMethod: z.enum(["bank", "jazzcash", "easypaisa"], {
    message: "Payment method must be Bank Transfer, JazzCash, or Easypaisa.",
  }),
  transactionReference: z
    .string()
    .trim()
    .min(2, "Transaction reference / TID must be between 2 and 120 characters.")
    .max(120, "Transaction reference / TID must be between 2 and 120 characters."),
  paymentNote: z.string().trim().max(500).optional().default(""),
});

export const CertificateTopupFieldsSchema = z.object({
  eventId: UuidSchema,
  certsAdded: z.coerce
    .number()
    .int()
    .min(25, "Minimum top-up is 25 certificates.")
    .max(5000, "Maximum single top-up is 5,000 certificates."),
  paymentMethod: z.enum(["bank", "jazzcash", "easypaisa"], {
    message: "Payment method must be Bank Transfer, JazzCash, or Easypaisa.",
  }),
  transactionReference: z
    .string()
    .trim()
    .min(2, "Transaction reference / TID must be between 2 and 120 characters.")
    .max(120, "Transaction reference / TID must be between 2 and 120 characters."),
  paymentNote: z.string().trim().max(500).optional().default(""),
});

export const ReviewPaymentActionSchema = z.object({
  requestId: UuidSchema,
  decision: z.enum(["approved", "rejected"]),
  reviewerNote: z.string().trim().max(500).optional(),
  billingDays: z.number().int().min(1).max(3660).optional(),
});

export const ReviewPurchaseActionSchema = z.object({
  purchaseId: UuidSchema,
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

export const ReviewTopupActionSchema = z.object({
  topupId: UuidSchema,
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

export const SuperAdminSuspendSchema = z.object({
  orgId: UuidSchema,
  suspended: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const SuperAdminChangePlanSchema = z.object({
  orgId: UuidSchema,
  planId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/),
  durationDays: z.number().int().min(1).max(3660).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const SuperAdminGrantPackageSchema = z.object({
  orgId: UuidSchema,
  planId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/)
    .optional()
    .or(z.literal("")),
  eventsTotal: z.coerce.number().int().min(1).max(100),
  certsPerEvent: z.coerce.number().int().min(25).max(5000),
  months: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  isPilot: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
});

export const SuperAdminExtendExpirySchema = z.object({
  orgId: UuidSchema,
  purchaseId: UuidSchema.optional(),
  addDays: z.number().int().min(1).max(3660).optional(),
  exactDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
  clearExpiry: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const PurchaseRequestNoProofFieldsSchema = z.object({
  selectionType: z.enum(["preset", "custom"]).default("preset"),
  planId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/)
    .optional()
    .or(z.literal("")),
  events: z.coerce.number().int().min(1).max(20).optional(),
  certsPerEvent: z.coerce.number().int().min(25).max(500).optional(),
  months: z.coerce.number().int().optional(),
  paymentNote: z.string().trim().max(500).optional().default(""),
});

export const CertificateTopupNoProofFieldsSchema = z.object({
  eventId: UuidSchema,
  certsAdded: z.coerce
    .number()
    .int()
    .min(25, "Minimum top-up is 25 certificates.")
    .max(5000, "Maximum single top-up is 5,000 certificates."),
  paymentNote: z.string().trim().max(500).optional().default(""),
});

export const SuperAdminApproveSignupRequestSchema = z.object({
  orgId: UuidSchema,
  purchaseId: UuidSchema,
  mode: z.enum(["pilot", "paid"]),
  paymentNote: z.string().trim().max(500).optional(),
});

export const SuperAdminRejectSignupRequestSchema = z.object({
  orgId: UuidSchema,
  purchaseId: UuidSchema.optional(),
  reason: z
    .string()
    .trim()
    .min(3, "Please enter a rejection reason (at least 3 characters).")
    .max(1000, "Rejection reason cannot exceed 1,000 characters."),
});

export const SuperAdminPaymentSettingsSchema = z.object({
  bankEnabled: z.boolean(),
  bankName: z.string().trim().min(1).max(120),
  bankAccountTitle: z.string().trim().min(1).max(160),
  bankAccountNumber: z.string().trim().min(1).max(80),
  bankIban: z.string().trim().max(80).default(""),
  jazzcashEnabled: z.boolean(),
  jazzcashAccountTitle: z.string().trim().min(1).max(160),
  jazzcashNumber: z.string().trim().min(1).max(40),
  easypaisaEnabled: z.boolean(),
  easypaisaAccountTitle: z.string().trim().min(1).max(160),
  easypaisaNumber: z.string().trim().min(1).max(40),
  instructions: z.string().trim().max(1000).default(""),
});

export const SuperAdminPricingConfigSchema = z.object({
  eventFeePkr: z.coerce.number().int().min(0).max(1_000_000),
  certRatePkr: z.coerce.number().int().min(0).max(100_000),
  roundingPkr: z.coerce.number().int().min(1).max(10_000),
  minEvents: z.coerce.number().int().min(1).max(20),
  maxEvents: z.coerce.number().int().min(1).max(100),
  minCertsPerEvent: z.coerce.number().int().min(1).max(500),
  maxCertsPerEvent: z.coerce.number().int().min(25).max(10_000),
  certsStep: z.coerce.number().int().min(1).max(500),
  volumeDiscounts: z
    .array(
      z.object({
        min_events: z.coerce.number().int().min(1).max(100),
        discount: z.coerce.number().min(0).max(0.95),
      }),
    )
    .min(1)
    .max(20),
  durationMultipliers: z
    .array(
      z.object({
        months: z.coerce.number().int().min(1).max(60),
        mult: z.coerce.number().min(0.1).max(10),
      }),
    )
    .min(1)
    .max(10),
});
