"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Button, Input, useToast } from "@/components/ui";
import type { CertificateTypeRow } from "@/lib/dashboard-data";
import {
  CURATED_FONTS,
  checkClientFontGlyphSupport,
  computeNamePlacementPt,
  getFontFileForStyle,
  pdfPointToScreenPx,
  resolveCuratedFont,
  screenPxToPdfPoint,
  type CuratedFontId,
} from "@/lib/fonts";
import { saveNamePlacementAction } from "./template-actions";

const SAMPLE_NAME_PRESETS = [
  { label: "Standard", value: "Bazigh Ali" },
  {
    label: "Long Name (Auto-shrink)",
    value: "Muhammad Abdul Rehman Chaudhry",
  },
  {
    label: "Very Long Name",
    value: "Syed Muhammad Abdul Rehman Bin Tariq Mahmood",
  },
  { label: "Urdu / Arabic", value: "محمد عبدالرحمٰن چوہدری" },
];

const COLOR_PRESETS = [
  { label: "Navy", hex: "#0B2A4F" },
  { label: "Charcoal", hex: "#1E293B" },
  { label: "Gold", hex: "#854D0E" },
  { label: "Royal Blue", hex: "#1D4ED8" },
  { label: "Crimson", hex: "#991B1B" },
];

type DragMode =
  | { kind: "none" }
  | {
      kind: "move";
      startMouseXPx: number;
      startMouseYPx: number;
      startNameXPt: number;
      startNameYPt: number;
    }
  | {
      kind: "resize-left" | "resize-right";
      startMouseXPx: number;
      startMaxWidthPt: number;
    };

function isPdfTemplate(row: CertificateTypeRow): boolean {
  if (!row.templatePath) return true; // Fallback blank sample is a PDF
  if (row.templateMime === "application/pdf") return true;
  if (row.templatePath.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

export default function NamePlacementEditor({
  eventId,
  certType,
  previewBustKey = 0,
}: {
  eventId: string;
  certType: CertificateTypeRow;
  previewBustKey?: number;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const pageWidthPt = certType.pageWidthPt ?? 843.75;
  const pageHeightPt = certType.pageHeightPt ?? 597.75;

  // Placement state in PDF points (origin bottom-left, matching pdf-lib)
  const [nameXPt, setNameXPt] = useState<number>(certType.nameX);
  const [nameYPt, setNameYPt] = useState<number>(certType.nameY);
  const [maxNameWidthPt, setMaxNameWidthPt] = useState<number>(
    certType.maxNameWidth,
  );
  const [nameFont, setNameFont] = useState<CuratedFontId>(
    resolveCuratedFont(certType.nameFont).id,
  );
  const [nameBold, setNameBold] = useState<boolean>(certType.nameBold);
  const [nameSizePt, setNameSizePt] = useState<number>(certType.nameSize);
  const [nameColor, setNameColor] = useState<string>(certType.nameColor);
  const [nameAlign, setNameAlign] = useState<"left" | "center" | "right">(
    certType.nameAlign,
  );

  // Sample name & zoom state
  const [sampleName, setSampleName] = useState<string>(
    "Muhammad Abdul Rehman Chaudhry",
  );
  const [zoomMode, setZoomMode] = useState<number | "fit">("fit");
  const [containerWidthPx, setContainerWidthPx] = useState<number>(720);

  // Status flags
  const [templateLoading, setTemplateLoading] = useState<boolean>(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [fontReadyVersion, setFontReadyVersion] = useState<number>(0);
  const [saving, setSaving] = useState<boolean>(false);
  const [downloadingPdf, setDownloadingPdf] = useState<boolean>(false);

  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragMode>({ kind: "none" });
  const loadedFontsRef = useRef<Set<string>>(new Set());

  // Sync state if user switches to a different certType or after page dimension change
  useEffect(() => {
    setNameXPt(certType.nameX);
    setNameYPt(certType.nameY);
    setMaxNameWidthPt(certType.maxNameWidth);
    setNameFont(resolveCuratedFont(certType.nameFont).id);
    setNameBold(certType.nameBold);
    setNameSizePt(certType.nameSize);
    setNameColor(certType.nameColor);
    setNameAlign(certType.nameAlign);
  }, [
    certType.id,
    certType.nameX,
    certType.nameY,
    certType.maxNameWidth,
    certType.nameFont,
    certType.nameBold,
    certType.nameSize,
    certType.nameColor,
    certType.nameAlign,
  ]);

  // Measure container width so "Fit" zoom scales smoothly on desktop & mobile
  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;

    const updateWidth = () => {
      const w = el.clientWidth - 32;
      if (w > 180) setContainerWidthPx(w);
    };
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute current screen scale (CSS pixels per PDF point)
  const scale = useMemo(() => {
    if (zoomMode === "fit") {
      return Math.max(0.25, Math.min(1.5, containerWidthPx / pageWidthPt));
    }
    return zoomMode;
  }, [zoomMode, containerWidthPx, pageWidthPt]);

  const canvasWidthPx = Math.round(pageWidthPt * scale);
  const canvasHeightPx = Math.round(pageHeightPt * scale);

  const selectedFontDef = useMemo(
    () => resolveCuratedFont(nameFont),
    [nameFont],
  );

  const cssFontFamily = `cert-font-${selectedFontDef.id}-${nameBold ? "bold" : "reg"}`;

  // Load the exact embedded TTF file into browser FontFace API so canvas width measurement
  // and glyph rendering match pdf-lib 1:1.
  useEffect(() => {
    let cancelled = false;
    const fontFile = getFontFileForStyle(selectedFontDef.id, nameBold);

    async function loadTtf() {
      if (typeof window === "undefined" || !("FontFace" in window)) return;
      if (loadedFontsRef.current.has(cssFontFamily)) {
        setFontReadyVersion((v) => v + 1);
        return;
      }
      try {
        const face = new FontFace(cssFontFamily, `url(/${fontFile})`);
        const loaded = await face.load();
        document.fonts.add(loaded);
        loadedFontsRef.current.add(cssFontFamily);
        if (!cancelled) {
          setFontReadyVersion((v) => v + 1);
        }
      } catch (err) {
        console.warn("Could not load embedded TTF via FontFace:", err);
      }
    }

    void loadTtf();
    return () => {
      cancelled = true;
    };
  }, [selectedFontDef.id, nameBold, cssFontFamily]);

  // Render the template (PDF via pdfjs-dist or PNG/JPG via Image) into bgCanvasRef
  useEffect(() => {
    let cancelled = false;

    async function renderTemplateBackground() {
      const canvas = bgCanvasRef.current;
      if (!canvas) return;

      setTemplateLoading(true);
      setTemplateError(null);

      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const previewUrl = certType.templatePath
        ? `/api/dashboard/templates/${certType.id}/preview?page=${certType.pageIndex}&v=${encodeURIComponent(certType.updatedAt)}-${previewBustKey}`
        : `/samples/blank-template.pdf`;

      try {
        if (isPdfTemplate(certType)) {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

          const loadingTask = pdfjs.getDocument({
            url: previewUrl,
            withCredentials: true,
          });
          const pdfDoc = await loadingTask.promise;
          if (cancelled) return;

          // The preview endpoint already extracts the single selected page (page 1),
          // whereas the fallback blank-template.pdf has 2 pages.
          const pageNum = certType.templatePath
            ? 1
            : Math.min(pdfDoc.numPages, certType.pageIndex + 1);
          const page = await pdfDoc.getPage(pageNum);
          if (cancelled) return;

          const baseViewport = page.getViewport({ scale: 1 });
          const renderScale = (canvasWidthPx / baseViewport.width) * dpr;
          const viewport = page.getViewport({ scale: renderScale });

          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          canvas.style.width = `${canvasWidthPx}px`;
          canvas.style.height = `${canvasHeightPx}px`;

          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          await page.render({
            canvasContext: ctx,
            canvas,
            viewport,
          }).promise;
        } else {
          const img = new Image();
          img.crossOrigin = "use-credentials";
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () =>
              reject(new Error("Failed to load template image."));
            img.src = previewUrl;
          });
          if (cancelled) return;

          canvas.width = Math.round(canvasWidthPx * dpr);
          canvas.height = Math.round(canvasHeightPx * dpr);
          canvas.style.width = `${canvasWidthPx}px`;
          canvas.style.height = `${canvasHeightPx}px`;

          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }
      } catch (err) {
        if (!cancelled) {
          setTemplateError(
            err instanceof Error
              ? err.message
              : "Could not render template preview.",
          );
        }
      } finally {
        if (!cancelled) {
          setTemplateLoading(false);
        }
      }
    }

    void renderTemplateBackground();
    return () => {
      cancelled = true;
    };
  }, [
    certType,
    previewBustKey,
    canvasWidthPx,
    canvasHeightPx,
  ]);

  // Compute exact placement in PDF points (and auto-shrink) using the loaded TTF font on canvas
  const computedPlacement = useMemo(() => {
    // Reference fontReadyVersion so placement recomputes once the TTF finishes loading
    void fontReadyVersion;

    const measureAtSizePt = (sizePt: number): number => {
      if (typeof document === "undefined") {
        return sampleName.length * sizePt * 0.52;
      }
      const measureCanvas = document.createElement("canvas");
      const mCtx = measureCanvas.getContext("2d");
      if (!mCtx) return sampleName.length * sizePt * 0.52;
      const fallbackStack =
        selectedFontDef.category === "script"
          ? "cursive"
          : selectedFontDef.category === "sans"
            ? "sans-serif"
            : "serif";
      mCtx.font = `${sizePt}px "${cssFontFamily}", ${fallbackStack}`;
      return mCtx.measureText(sampleName || " ").width;
    };

    return computeNamePlacementPt(
      {
        nameXPt,
        nameYPt,
        maxNameWidthPt,
        nameSizePt,
        nameAlign,
      },
      measureAtSizePt,
    );
  }, [
    nameXPt,
    nameYPt,
    maxNameWidthPt,
    nameSizePt,
    nameAlign,
    sampleName,
    cssFontFamily,
    selectedFontDef.category,
    fontReadyVersion,
  ]);

  // Draw the interactive name box, baseline, resize handles, and live sample text on overlayCanvasRef
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(canvasWidthPx * dpr);
    canvas.height = Math.round(canvasHeightPx * dpr);
    canvas.style.width = `${canvasWidthPx}px`;
    canvas.style.height = `${canvasHeightPx}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidthPx, canvasHeightPx);

    const {
      effectiveFontSizePt,
      textDrawXPt,
      baselineYPt,
      boxLeftPt,
    } = computedPlacement;

    const boxLeftPx = boxLeftPt * scale;
    const boxWidthPx = maxNameWidthPt * scale;
    const baselineYPx = (pageHeightPt - baselineYPt) * scale;
    const fontSizePx = effectiveFontSizePt * scale;

    // Bounding box spans ~0.88em above baseline (ascent) and ~0.26em below baseline (descent)
    const ascentPx = Math.max(14, fontSizePx * 0.88);
    const descentPx = Math.max(6, fontSizePx * 0.26);
    const boxTopPx = baselineYPx - ascentPx;
    const boxHeightPx = ascentPx + descentPx;

    // 1. Shaded name box background + dashed border
    ctx.fillStyle = "rgba(79, 70, 229, 0.08)";
    ctx.fillRect(boxLeftPx, boxTopPx, boxWidthPx, boxHeightPx);

    ctx.strokeStyle = "#4F46E5";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(boxLeftPx, boxTopPx, boxWidthPx, boxHeightPx);
    ctx.setLineDash([]);

    // 2. Alphabetic baseline indicator (matches pdf-lib's y coordinate)
    ctx.strokeStyle = "rgba(79, 70, 229, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(boxLeftPx, baselineYPx);
    ctx.lineTo(boxLeftPx + boxWidthPx, baselineYPx);
    ctx.stroke();

    // 3. Draw the live sample name on the exact alphabetic baseline
    const fallbackStack =
      selectedFontDef.category === "script"
        ? "cursive"
        : selectedFontDef.category === "sans"
          ? "sans-serif"
          : "serif";
    ctx.font = `${fontSizePx}px "${cssFontFamily}", ${fallbackStack}`;
    ctx.fillStyle = /^#[0-9A-Fa-f]{6}$/.test(nameColor) ? nameColor : "#0B2A4F";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(sampleName || " ", textDrawXPt * scale, baselineYPx);

    // 4. Left & right max-width resize handles
    const handleW = 8;
    const handleH = Math.min(24, Math.max(14, boxHeightPx * 0.65));
    const handleY = boxTopPx + (boxHeightPx - handleH) / 2;

    ctx.fillStyle = "#4F46E5";
    ctx.beginPath();
    ctx.roundRect(boxLeftPx - handleW / 2, handleY, handleW, handleH, 3);
    ctx.roundRect(
      boxLeftPx + boxWidthPx - handleW / 2,
      handleY,
      handleW,
      handleH,
      3,
    );
    ctx.fill();

    // 5. Anchor point dot at (nameXPt, nameYPt)
    const anchorScreen = pdfPointToScreenPx(
      nameXPt,
      nameYPt,
      pageHeightPt,
      scale,
    );
    ctx.fillStyle = "#DC2626";
    ctx.beginPath();
    ctx.arc(anchorScreen.xPx, anchorScreen.yPx, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }, [
    canvasWidthPx,
    canvasHeightPx,
    computedPlacement,
    maxNameWidthPt,
    pageHeightPt,
    scale,
    selectedFontDef.category,
    cssFontFamily,
    nameColor,
    sampleName,
    nameXPt,
    nameYPt,
  ]);

  // Pointer interaction: drag box to move, drag side handles to resize max width, or click anywhere to place
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mouseXPx = e.clientX - rect.left;
      const mouseYPx = e.clientY - rect.top;

      const { effectiveFontSizePt, baselineYPt, boxLeftPt } = computedPlacement;
      const boxLeftPx = boxLeftPt * scale;
      const boxWidthPx = maxNameWidthPt * scale;
      const boxRightPx = boxLeftPx + boxWidthPx;
      const baselineYPx = (pageHeightPt - baselineYPt) * scale;
      const fontSizePx = effectiveFontSizePt * scale;
      const ascentPx = Math.max(14, fontSizePx * 0.88);
      const descentPx = Math.max(6, fontSizePx * 0.26);
      const boxTopPx = baselineYPx - ascentPx;
      const boxBottomPx = baselineYPx + descentPx;

      const inYBand = mouseYPx >= boxTopPx - 10 && mouseYPx <= boxBottomPx + 10;

      // Check left/right resize handles first
      if (inYBand && Math.abs(mouseXPx - boxLeftPx) <= 10) {
        dragRef.current = {
          kind: "resize-left",
          startMouseXPx: mouseXPx,
          startMaxWidthPt: maxNameWidthPt,
        };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      if (inYBand && Math.abs(mouseXPx - boxRightPx) <= 10) {
        dragRef.current = {
          kind: "resize-right",
          startMouseXPx: mouseXPx,
          startMaxWidthPt: maxNameWidthPt,
        };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // Inside box -> drag move
      if (
        inYBand &&
        mouseXPx >= boxLeftPx &&
        mouseXPx <= boxRightPx
      ) {
        dragRef.current = {
          kind: "move",
          startMouseXPx: mouseXPx,
          startMouseYPx: mouseYPx,
          startNameXPt: nameXPt,
          startNameYPt: nameYPt,
        };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // Click outside box -> click-to-place anchor immediately and begin dragging from there
      const pt = screenPxToPdfPoint(mouseXPx, mouseYPx, pageHeightPt, scale);
      const clampedX = Math.max(0, Math.min(pageWidthPt, pt.xPt));
      const clampedY = Math.max(0, Math.min(pageHeightPt, pt.yPt));
      setNameXPt(clampedX);
      setNameYPt(clampedY);

      dragRef.current = {
        kind: "move",
        startMouseXPx: mouseXPx,
        startMouseYPx: mouseYPx,
        startNameXPt: clampedX,
        startNameYPt: clampedY,
      };
      canvas.setPointerCapture(e.pointerId);
    },
    [
      computedPlacement,
      maxNameWidthPt,
      nameXPt,
      nameYPt,
      pageHeightPt,
      pageWidthPt,
      scale,
    ],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const mode = dragRef.current;
      if (mode.kind === "none") return;

      const canvas = overlayCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseXPx = e.clientX - rect.left;
      const mouseYPx = e.clientY - rect.top;

      if (mode.kind === "move") {
        const dxPt = (mouseXPx - mode.startMouseXPx) / scale;
        const dyPt = (mouseYPx - mode.startMouseYPx) / scale;
        const nextX = Number(
          Math.max(0, Math.min(pageWidthPt, mode.startNameXPt + dxPt)).toFixed(
            2,
          ),
        );
        // Screen Y grows downward, PDF Y grows upward from bottom-left
        const nextY = Number(
          Math.max(
            0,
            Math.min(pageHeightPt, mode.startNameYPt - dyPt),
          ).toFixed(2),
        );
        setNameXPt(nextX);
        setNameYPt(nextY);
        return;
      }

      const dxPt = (mouseXPx - mode.startMouseXPx) / scale;
      const factor = nameAlign === "center" ? 2 : 1;
      const deltaW =
        mode.kind === "resize-right" ? dxPt * factor : -dxPt * factor;
      const nextW = Number(
        Math.max(40, Math.min(pageWidthPt, mode.startMaxWidthPt + deltaW)).toFixed(
          2,
        ),
      );
      setMaxNameWidthPt(nextW);
    },
    [nameAlign, pageHeightPt, pageWidthPt, scale],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (dragRef.current.kind !== "none") {
        dragRef.current = { kind: "none" };
        try {
          overlayCanvasRef.current?.releasePointerCapture(e.pointerId);
        } catch {
          // Ignore if not captured
        }
      }
    },
    [],
  );

  // Live glyph check for non-Latin / Urdu / Arabic names
  const glyphCheck = useMemo(
    () => checkClientFontGlyphSupport(sampleName, nameFont),
    [sampleName, nameFont],
  );

  async function handleSavePlacement() {
    setSaving(true);
    try {
      const res = await saveNamePlacementAction({
        eventId,
        certTypeId: certType.id,
        nameXPt,
        nameYPt,
        maxNameWidthPt,
        nameFont,
        nameBold,
        nameSizePt,
        nameColor,
        nameAlign,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        `Saved name placement for "${certType.label}" (${nameXPt} pt, ${nameYPt} pt).`,
        "success",
      );
      router.refresh();
    } catch {
      showToast("Failed to save name placement.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDownloadTestPdf() {
    setDownloadingPdf(true);
    try {
      const res = await fetch(
        `/api/dashboard/templates/${certType.id}/test-pdf`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sampleName,
            nameXPt,
            nameYPt,
            maxNameWidthPt,
            nameFont,
            nameBold,
            nameSizePt,
            nameColor,
            nameAlign,
            pageIndex: certType.pageIndex,
          }),
        },
      );

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        showToast(errData.error || "Could not generate test PDF.", "error");
        return;
      }

      const missingHeader = decodeURIComponent(
        res.headers.get("X-Cert-Missing-Chars") || "",
      );
      if (missingHeader) {
        showToast(
          `Note: selected font lacked glyphs for "${missingHeader}"; rendered with Amiri fallback.`,
          "info",
        );
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `test-${certType.key}-${
        sampleName.trim().replace(/\s+/g, "_").slice(0, 30) || "sample"
      }.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast("Network error while generating test PDF.", "error");
    } finally {
      setDownloadingPdf(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-xs">
      {/* Editor top toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900 sm:text-base">
              Visual Name Placement — {certType.label}
            </h3>
            <span className="rounded-md bg-indigo-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-indigo-700">
              {pageWidthPt} × {pageHeightPt} pt
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Click anywhere on the certificate or drag the blue box to position the recipient name. Drag the side handles to resize max width.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={downloadingPdf}
            onClick={handleDownloadTestPdf}
          >
            ⬇ Download Test PDF
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={handleSavePlacement}
          >
            Save Placement
          </Button>
        </div>
      </div>

      {/* Non-Latin / Missing Glyph Warning Banner */}
      {!glyphCheck.supported && glyphCheck.warning && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <span className="text-base" aria-hidden="true">
              ⚠️
            </span>
            <span>{glyphCheck.warning}</span>
          </div>
          {glyphCheck.suggestedFontId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNameFont(glyphCheck.suggestedFontId!)}
            >
              Switch to Amiri Naskh (Urdu / Arabic)
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 divide-y divide-slate-100 xl:grid-cols-12 xl:divide-x xl:divide-y-0">
        {/* Left/Center: Interactive Canvas Stage (8 cols) */}
        <div
          ref={stageWrapRef}
          className="flex flex-col items-center justify-between bg-slate-100/90 p-4 xl:col-span-8"
        >
          {/* Zoom & coordinate status bar */}
          <div className="mb-3 flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2 text-xs text-slate-600 shadow-2xs">
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
              <span>
                X:{" "}
                <strong className="text-slate-900">
                  {nameXPt.toFixed(1)} pt
                </strong>
              </span>
              <span>
                Y (from bottom):{" "}
                <strong className="text-slate-900">
                  {nameYPt.toFixed(1)} pt
                </strong>
              </span>
              <span>
                Max W:{" "}
                <strong className="text-slate-900">
                  {maxNameWidthPt.toFixed(0)} pt
                </strong>
              </span>
              <span>
                Rendered size:{" "}
                <strong
                  className={
                    computedPlacement.wasShrunk
                      ? "text-amber-700"
                      : "text-emerald-700"
                  }
                >
                  {computedPlacement.effectiveFontSizePt.toFixed(1)} pt
                  {computedPlacement.wasShrunk ? " (auto-shrunk)" : ""}
                </strong>
              </span>
            </div>

            <div className="flex items-center gap-1">
              <span className="mr-1 text-[11px] text-slate-500">Zoom:</span>
              {(["fit", 0.5, 0.75, 1, 1.25] as const).map((z) => {
                const active = zoomMode === z;
                return (
                  <button
                    key={String(z)}
                    type="button"
                    onClick={() => setZoomMode(z)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition ${
                      active
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {z === "fit" ? "Fit" : `${Math.round(z * 100)}%`}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Stacked Background + Interactive Overlay Canvases */}
          <div className="flex w-full flex-1 items-center justify-center overflow-auto py-2">
            <div
              className="relative overflow-hidden rounded-xl border border-slate-300 bg-white shadow-md select-none"
              style={{
                width: `${canvasWidthPx}px`,
                height: `${canvasHeightPx}px`,
              }}
            >
              <canvas
                ref={bgCanvasRef}
                className="block h-full w-full"
              />
              <canvas
                ref={overlayCanvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="absolute inset-0 block h-full w-full cursor-move touch-none"
              />

              {templateLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/75 text-xs font-semibold text-slate-600 backdrop-blur-2xs">
                  Rendering template preview...
                </div>
              )}

              {templateError && (
                <div className="absolute inset-0 flex items-center justify-center bg-red-50/90 p-4 text-center text-xs font-medium text-red-700">
                  {templateError}
                </div>
              )}
            </div>
          </div>

          <p className="mt-2 text-center text-[11px] text-slate-500">
            Red dot = anchor point ({nameAlign} aligned on alphabetic baseline) · Origin (0, 0) is bottom-left in PDF points
          </p>
        </div>

        {/* Right: Controls Sidebar (4 cols) */}
        <div className="space-y-5 p-5 xl:col-span-4">
          {/* 1. Sample Name + Presets */}
          <div>
            <Input
              id={`sample-name-${certType.id}`}
              label="Live sample name"
              value={sampleName}
              onChange={(e) => setSampleName(e.target.value)}
              placeholder="Type a recipient name to preview..."
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SAMPLE_NAME_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setSampleName(preset.value)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Font family + Bold */}
          <div className="space-y-3">
            <div>
              <label
                htmlFor={`font-family-${certType.id}`}
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Font family (embedded TTF)
              </label>
              <select
                id={`font-family-${certType.id}`}
                value={nameFont}
                onChange={(e) => setNameFont(e.target.value as CuratedFontId)}
                className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25"
              >
                {CURATED_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5">
              <div>
                <span className="text-xs font-semibold text-slate-800">
                  Bold weight
                </span>
                <p className="text-[11px] text-slate-500">
                  {selectedFontDef.supportsBoldToggle
                    ? "Switches between Regular and Bold TTF"
                    : "This display/script font uses a single weight"}
                </p>
              </div>
              <input
                type="checkbox"
                checked={nameBold}
                onChange={(e) => setNameBold(e.target.checked)}
                disabled={!selectedFontDef.supportsBoldToggle}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
              />
            </div>
          </div>

          {/* 3. Font size & Max width */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              id={`font-size-${certType.id}`}
              type="number"
              label="Font size (pt)"
              min={8}
              max={160}
              step={1}
              value={nameSizePt}
              onChange={(e) =>
                setNameSizePt(
                  Math.max(4, Math.min(300, Number(e.target.value) || 34)),
                )
              }
            />
            <Input
              id={`max-width-${certType.id}`}
              type="number"
              label="Max width (pt)"
              min={40}
              max={Math.round(pageWidthPt)}
              step={5}
              value={Math.round(maxNameWidthPt)}
              onChange={(e) =>
                setMaxNameWidthPt(
                  Math.max(
                    40,
                    Math.min(pageWidthPt, Number(e.target.value) || 200),
                  ),
                )
              }
            />
          </div>

          {/* 4. Alignment (left / center / right) */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Text alignment
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: "left", label: "Left" },
                  { id: "center", label: "Center" },
                  { id: "right", label: "Right" },
                ] as const
              ).map((al) => (
                <button
                  key={al.id}
                  type="button"
                  onClick={() => setNameAlign(al.id)}
                  className={`rounded-xl border py-2 text-xs font-semibold transition ${
                    nameAlign === al.id
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {al.label}
                </button>
              ))}
            </div>
          </div>

          {/* 5. Color picker + presets */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Text color
            </label>
            <div className="flex items-center gap-2.5">
              <input
                type="color"
                value={
                  /^#[0-9A-Fa-f]{6}$/.test(nameColor) ? nameColor : "#0B2A4F"
                }
                onChange={(e) => setNameColor(e.target.value.toUpperCase())}
                className="h-10 w-12 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
              />
              <input
                type="text"
                value={nameColor}
                onChange={(e) => setNameColor(e.target.value.toUpperCase())}
                maxLength={7}
                className="block w-28 rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-indigo-500 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c.hex}
                    type="button"
                    title={c.label}
                    onClick={() => setNameColor(c.hex)}
                    className="h-6 w-6 rounded-full border border-slate-300 shadow-2xs"
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* 6. Exact PDF-point coordinates (bottom-left origin) */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800">
                PDF Point Coordinates
              </span>
              <button
                type="button"
                onClick={() =>
                  setNameXPt(Number((pageWidthPt / 2).toFixed(2)))
                }
                className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-500"
              >
                Center Horizontally
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Input
                id={`coord-x-${certType.id}`}
                type="number"
                label="X (pt from left)"
                step="0.5"
                min={0}
                max={pageWidthPt}
                value={nameXPt}
                onChange={(e) =>
                  setNameXPt(
                    Math.max(
                      0,
                      Math.min(pageWidthPt, Number(e.target.value) || 0),
                    ),
                  )
                }
              />
              <Input
                id={`coord-y-${certType.id}`}
                type="number"
                label="Y (pt from bottom)"
                step="0.5"
                min={0}
                max={pageHeightPt}
                value={nameYPt}
                onChange={(e) =>
                  setNameYPt(
                    Math.max(
                      0,
                      Math.min(pageHeightPt, Number(e.target.value) || 0),
                    ),
                  )
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
