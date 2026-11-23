"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Modal,
  useToast,
} from "@/components/ui";
import type { CertificateTypeRow } from "@/lib/dashboard-data";
import NamePlacementEditor from "./NamePlacementEditor";
import {
  addCertificateTypeAction,
  deleteCertificateTypeAction,
  renameCertificateTypeAction,
  selectTemplatePageAction,
} from "./template-actions";

const TYPE_PRESETS = [
  "Certificate of Participation",
  "Certificate of Appreciation",
  "Winner Certificate",
  "Speaker / Panelist",
  "Organizer Certificate",
];

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

function isPdfTemplate(row: CertificateTypeRow): boolean {
  if (row.templateMime === "application/pdf") return true;
  if (row.templatePath?.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

export default function TemplateTabClient({
  eventId,
  initialTypes,
  maxTypesPerEvent,
  planName,
}: {
  eventId: string;
  initialTypes: CertificateTypeRow[];
  maxTypesPerEvent: number | null;
  planName: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  // Local version counter per certTypeId to bust preview cache immediately after replacement
  const [previewVersion, setPreviewVersion] = useState<Record<string, number>>({});
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [changingPageId, setChangingPageId] = useState<string | null>(null);

  // Add Certificate Type Modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [addingType, setAddingType] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Rename Certificate Type Modal state
  const [renamingType, setRenamingType] = useState<CertificateTypeRow | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Delete Confirmation Modal state
  const [deletingType, setDeletingType] = useState<CertificateTypeRow | null>(null);
  const [deletingLoading, setDeletingLoading] = useState(false);

  // Active certificate type selected for the Visual Name Placement Editor
  const [activeEditorTypeId, setActiveEditorTypeId] = useState<string | null>(
    initialTypes[0]?.id ?? null,
  );
  const activeEditorType =
    initialTypes.find((t) => t.id === activeEditorTypeId) ?? initialTypes[0] ?? null;

  // File input refs keyed by certType.id
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const atLimit =
    maxTypesPerEvent !== null && initialTypes.length >= maxTypesPerEvent;

  async function handleAddType(e: FormEvent) {
    e.preventDefault();
    setAddError(null);

    const trimmed = newLabel.trim();
    if (trimmed.length < 2 || trimmed.length > 80) {
      setAddError("Label must be between 2 and 80 characters.");
      return;
    }

    setAddingType(true);
    try {
      const res = await addCertificateTypeAction({
        eventId,
        label: trimmed,
      });

      if (res.error) {
        setAddError(res.error);
        showToast(res.error, "error");
        return;
      }

      showToast(`Added "${trimmed}".`, "success");
      setNewLabel("");
      setAddModalOpen(false);
      router.refresh();
    } catch {
      const msg = "Failed to add certificate type.";
      setAddError(msg);
      showToast(msg, "error");
    } finally {
      setAddingType(false);
    }
  }

  async function handleRenameSubmit(e: FormEvent) {
    e.preventDefault();
    if (!renamingType) return;
    setRenameError(null);

    const trimmed = renameLabel.trim();
    if (trimmed.length < 2 || trimmed.length > 80) {
      setRenameError("Label must be between 2 and 80 characters.");
      return;
    }

    setSavingRename(true);
    try {
      const res = await renameCertificateTypeAction({
        eventId,
        certTypeId: renamingType.id,
        label: trimmed,
      });

      if (res.error) {
        setRenameError(res.error);
        showToast(res.error, "error");
        return;
      }

      showToast("Certificate type renamed.", "success");
      setRenamingType(null);
      router.refresh();
    } catch {
      const msg = "Failed to rename certificate type.";
      setRenameError(msg);
      showToast(msg, "error");
    } finally {
      setSavingRename(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingType) return;
    setDeletingLoading(true);
    try {
      const res = await deleteCertificateTypeAction({
        eventId,
        certTypeId: deletingType.id,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(`Deleted "${deletingType.label}".`, "success");
      setDeletingType(null);
      router.refresh();
    } catch {
      showToast("Failed to delete certificate type.", "error");
    } finally {
      setDeletingLoading(false);
    }
  }

  async function handleFileSelected(certType: CertificateTypeRow, file: File) {
    if (file.size === 0) {
      showToast("Selected file is empty.", "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast("File exceeds the 5 MB maximum size limit.", "error");
      return;
    }

    setUploadingId(certType.id);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("certTypeId", certType.id);
      formData.set("pageIndex", "0");

      const res = await fetch(
        `/api/dashboard/events/${eventId}/templates/upload`,
        {
          method: "POST",
          body: formData,
        },
      );

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        pageWidthPt?: number;
        pageHeightPt?: number;
        pageCount?: number;
      };

      if (!res.ok || data.error) {
        showToast(data.error || "Template upload failed.", "error");
        return;
      }

      setPreviewVersion((prev) => ({
        ...prev,
        [certType.id]: (prev[certType.id] ?? 0) + 1,
      }));
      showToast(
        `Uploaded template for "${certType.label}" (${data.pageWidthPt} × ${data.pageHeightPt} pt).`,
        "success",
      );
      router.refresh();
    } catch {
      showToast("Network error while uploading template.", "error");
    } finally {
      setUploadingId(null);
      const inputEl = fileInputRefs.current[certType.id];
      if (inputEl) inputEl.value = "";
    }
  }

  async function handlePageIndexChange(
    certType: CertificateTypeRow,
    nextPageIndex: number,
  ) {
    setChangingPageId(certType.id);
    try {
      const res = await selectTemplatePageAction({
        eventId,
        certTypeId: certType.id,
        pageIndex: nextPageIndex,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      setPreviewVersion((prev) => ({
        ...prev,
        [certType.id]: (prev[certType.id] ?? 0) + 1,
      }));
      showToast(
        `Selected page ${nextPageIndex + 1} for "${certType.label}".`,
        "success",
      );
      router.refresh();
    } catch {
      showToast("Failed to update template page.", "error");
    } finally {
      setChangingPageId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div>
          <h2 className="text-base font-bold text-slate-900">
            Certificate Types & Templates
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Add multiple certificate types (e.g. Participation, Appreciation, Winner) and upload a PDF, PNG, or JPG template (max 5 MB) for each.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
            Types:{" "}
            <strong className="text-slate-900">
              {initialTypes.length} / {maxTypesPerEvent ?? "∞"}
            </strong>{" "}
            ({planName})
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setNewLabel("");
              setAddError(
                atLimit
                  ? `Your ${planName} plan allows up to ${maxTypesPerEvent} certificate types per event. Upgrade your plan in Billing to add more.`
                  : null,
              );
              setAddModalOpen(true);
            }}
          >
            + Add Certificate Type
          </Button>
        </div>
      </div>

      {/* Plan limit banner */}
      {atLimit && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 px-5 py-3 text-xs text-amber-900">
          <div>
            <strong>Certificate type limit reached:</strong> You have created{" "}
            <strong>
              {initialTypes.length} of {maxTypesPerEvent}
            </strong>{" "}
            certificate types allowed per event on the <strong>{planName}</strong> plan.
          </div>
          <Link
            href="/dashboard/billing"
            className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
          >
            Upgrade Plan →
          </Link>
        </div>
      )}

      {/* Certificate types grid */}
      {initialTypes.length === 0 ? (
        <EmptyState
          icon="🎨"
          title="No certificate types yet"
          description="Add a certificate type (such as Certificate of Participation or Appreciation) to upload your PDF, PNG, or JPG template."
          action={
            <Button
              variant="primary"
              onClick={() => {
                setNewLabel("Certificate of Participation");
                setAddError(null);
                setAddModalOpen(true);
              }}
            >
              Add First Certificate Type
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {initialTypes.map((certType) => {
            const isUploading = uploadingId === certType.id;
            const isChangingPage = changingPageId === certType.id;
            const hasTemplate = Boolean(certType.templatePath);
            const isPdf = isPdfTemplate(certType);
            const ver = previewVersion[certType.id] ?? 0;
            const previewUrl = `/api/dashboard/templates/${certType.id}/preview?page=${certType.pageIndex}&v=${encodeURIComponent(certType.updatedAt)}-${ver}`;

            const aspectRatio =
              certType.pageWidthPt && certType.pageHeightPt
                ? `${certType.pageWidthPt} / ${certType.pageHeightPt}`
                : "842 / 595";

            return (
              <section
                key={certType.id}
                className="flex flex-col justify-between overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs"
              >
                {/* Card top header */}
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-bold text-slate-900 sm:text-base">
                        {certType.label}
                      </h3>
                      <code className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
                        {certType.key}
                      </code>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {hasTemplate ? (
                        <>
                          {isPdf ? "PDF Template" : "Image Template"}
                          {certType.pageWidthPt && certType.pageHeightPt
                            ? ` · ${certType.pageWidthPt} × ${certType.pageHeightPt} pt`
                            : ""}
                          {isPdf && certType.pageCount > 1
                            ? ` · Page ${certType.pageIndex + 1} of ${certType.pageCount}`
                            : ""}
                        </>
                      ) : (
                        "No template file uploaded yet"
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRenamingType(certType);
                        setRenameLabel(certType.label);
                        setRenameError(null);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => setDeletingType(certType)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>

                {/* Thumbnail preview area */}
                <div className="bg-slate-100/80 p-4">
                  {hasTemplate ? (
                    <div className="space-y-3">
                      <div
                        className="relative mx-auto w-full max-w-md overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm"
                        style={{ aspectRatio }}
                      >
                        {isPdf ? (
                          <iframe
                            key={previewUrl}
                            src={`${previewUrl}#toolbar=0&navpanes=0&scrollbar=0&view=Fit`}
                            title={`${certType.label} PDF preview`}
                            className="h-full w-full border-0"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={previewUrl}
                            src={previewUrl}
                            alt={`${certType.label} template preview`}
                            className="h-full w-full object-contain"
                          />
                        )}
                      </div>

                      {/* Metadata bar + multi-page PDF selector */}
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md bg-white px-2 py-1 font-medium text-slate-700 ring-1 ring-slate-200">
                            {certType.pageWidthPt && certType.pageHeightPt
                              ? `${certType.pageWidthPt} × ${certType.pageHeightPt} pt`
                              : "Dimensions stored"}
                          </span>

                          {isPdf && certType.pageCount > 1 && (
                            <label className="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-1 ring-1 ring-slate-200">
                              <span className="text-[11px] font-medium text-slate-500">
                                Page:
                              </span>
                              <select
                                value={certType.pageIndex}
                                disabled={isChangingPage}
                                onChange={(e) =>
                                  handlePageIndexChange(
                                    certType,
                                    Number(e.target.value),
                                  )
                                }
                                className="bg-transparent text-xs font-semibold text-slate-900 focus:outline-none"
                              >
                                {Array.from(
                                  { length: certType.pageCount },
                                  (_, i) => (
                                    <option key={i} value={i}>
                                      {i + 1} of {certType.pageCount}
                                    </option>
                                  ),
                                )}
                              </select>
                            </label>
                          )}
                        </div>

                        <a
                          href={previewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-indigo-600 hover:text-indigo-500"
                        >
                          Open Preview ↗
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() =>
                        !isUploading &&
                        fileInputRefs.current[certType.id]?.click()
                      }
                      className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-10 text-center transition hover:border-indigo-400 hover:bg-indigo-50/30"
                    >
                      <span className="mb-2 text-2xl" aria-hidden="true">
                        📄
                      </span>
                      <p className="text-xs font-semibold text-slate-800">
                        Click to upload a certificate template
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        PDF (unlocked), PNG, or JPG · Max 5 MB
                      </p>
                    </div>
                  )}
                </div>

                {/* Card footer: Upload / Replace button */}
                <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-3.5">
                  <input
                    ref={(el) => {
                      fileInputRefs.current[certType.id] = el;
                    }}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        void handleFileSelected(certType, file);
                      }
                    }}
                  />

                  <span className="truncate font-mono text-[11px] text-slate-400">
                    {certType.templatePath
                      ? certType.templatePath.split("/").pop()
                      : "Awaiting upload"}
                  </span>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={
                        activeEditorType?.id === certType.id
                          ? "primary"
                          : "secondary"
                      }
                      size="sm"
                      onClick={() => setActiveEditorTypeId(certType.id)}
                    >
                      ✏️ Place Name Box
                    </Button>
                    <Button
                      variant={hasTemplate ? "secondary" : "primary"}
                      size="sm"
                      loading={isUploading}
                      onClick={() => fileInputRefs.current[certType.id]?.click()}
                    >
                      {hasTemplate ? "Replace Template" : "Upload Template"}
                    </Button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Visual Click-to-Place Name Editor for the selected Certificate Type */}
      {activeEditorType && (
        <div className="space-y-3 pt-2">
          {initialTypes.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-600">
                Editing name placement for:
              </span>
              {initialTypes.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveEditorTypeId(t.id)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                    activeEditorType.id === t.id
                      ? "border-indigo-600 bg-indigo-600 text-white shadow-2xs"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <NamePlacementEditor
            key={activeEditorType.id}
            eventId={eventId}
            certType={activeEditorType}
            previewBustKey={previewVersion[activeEditorType.id] ?? 0}
          />
        </div>
      )}

      {/* Add Certificate Type Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => !addingType && setAddModalOpen(false)}
        title="Add a certificate type"
        description="Each certificate type has its own template and recipient name box."
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleAddType} className="space-y-4">
          <Input
            id="new-cert-type-label"
            label="Certificate type label *"
            placeholder="e.g. Certificate of Appreciation"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            required
            minLength={2}
            maxLength={80}
            autoFocus
            disabled={addingType}
            error={addError}
          />

          <div>
            <p className="mb-1.5 text-[11px] font-medium text-slate-500">
              Quick presets:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TYPE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setNewLabel(preset)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setAddModalOpen(false)}
              disabled={addingType}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={addingType}
            >
              Add Type
            </Button>
          </div>
        </form>
      </Modal>

      {/* Rename Certificate Type Modal */}
      <Modal
        open={Boolean(renamingType)}
        onClose={() => !savingRename && setRenamingType(null)}
        title="Rename certificate type"
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleRenameSubmit} className="space-y-4">
          <Input
            id="rename-cert-type-label"
            label="Certificate type label *"
            value={renameLabel}
            onChange={(e) => setRenameLabel(e.target.value)}
            required
            minLength={2}
            maxLength={80}
            autoFocus
            disabled={savingRename}
            error={renameError}
          />

          <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRenamingType(null)}
              disabled={savingRename}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={savingRename}
            >
              Save Label
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Certificate Type ConfirmDialog */}
      <ConfirmDialog
        open={Boolean(deletingType)}
        onClose={() => !deletingLoading && setDeletingType(null)}
        onConfirm={handleConfirmDelete}
        title={`Delete "${deletingType?.label ?? ""}"?`}
        description="This will remove the certificate type, its uploaded template file in Storage, and any attendee certificates linked to this type."
        confirmLabel="Delete Certificate Type"
        danger
        loading={deletingLoading}
      />
    </div>
  );
}
