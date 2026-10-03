import { getEnabledElement } from "@cornerstonejs/core";
import type { RenderingEngine } from "@cornerstonejs/core";
import type { Color, ColorLUT } from "@cornerstonejs/core/types";
import type { vtkVolumeProperty } from '@kitware/vtk.js/Rendering/Core/VolumeProperty';
import { Niivue } from "@niivue/niivue";
import {
    IconAdjustmentsHorizontal,
    IconAngle,
    IconArrowBackUp,
    IconArrowForwardUp,
    IconArrowsCross,
    IconArrowUpRight,
    IconPencil,
	IconStack2,
    IconCamera,
    IconChartBar,
    IconCheck,
    IconChevronDown,
    IconCircle,
    IconClick,
    IconEye,
    IconFlipHorizontal,
    IconGrid3x3,
    IconHome,
    IconId,
    IconLasso,
    IconLayoutSidebarRight,
    IconListDetails, IconMicrophone, IconPlayerPause, IconPlayerPlay, IconPointer, IconReport,
    IconRotateClockwise,
    IconRuler2,
    IconScanEye,
    IconShare,
    IconSquareDashed,
    IconTrash,
    IconUsersGroup,
    IconX,
    IconZoomIn
} from "@tabler/icons-react";
import React, { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { buildMaskFilter } from "../helpers/CornerstoneNifti2";
import { useLocation, useParams } from "react-router-dom";
import AISidebar from "../components/AIAssistant/AISidebar";
import { track } from "../helpers/analytics";
import { buildViewerActions } from "../components/AIAssistant/assistantActions";
import MeasurementPanel from "../components/MeasurementPanel/MeasurementPanel";
import { SegmentationMeshViewer } from "../components/viewer/MeshViewer";
import { captureMeshCanvas } from "../helpers/viewer/meshCapture";
import OrganCheckbox from "../components/OrganCheckbox";
import PercentileBar from "../components/PercentileBar";
import SessionHUD from "../components/ReadingSession/SessionHUD";
import SessionSummary from "../components/ReadingSession/SessionSummary";
import ReportScreen, { prefetchReportData } from "../components/ReportScreen/ReportScreen";
import SliceJumpInput from "../components/SliceJumpInput";
import { SoloChallengeDock, SoloChallengeHeader } from "../education/SoloChallengeChrome";
import { QuizPracticeDock, QuizPracticeHeader } from "../education/QuizPracticeChrome";
import type { QuizPracticeController, SoloChallengeController } from "../education/types";
import SegmentsPopup from "../components/segmentation/SegmentsPopup";
import MarginPanel from "../components/segmentation/MarginPanel";
import IslandsPanel from "../components/segmentation/IslandsPanel";
import LogicalOperatorsPanel from "../components/segmentation/LogicalOperatorsPanel";
import { setBrushMaskingScope } from "../helpers/CornerstoneNifti2";

import SmoothingFlyout from "../components/segmentation/SmoothingFlyout";
import GrowFromSeedsFlyout from "../components/segmentation/GrowFromSeedFlyout";
import FillBetweenSlicesFlyout from "../components/segmentation/FillBetweenSlicesFlyout";
import CopyAcrossSlicesFlyout from "../components/segmentation/CopyAcrossSlicesFlyout";
import { GuidedStepModal } from "../components/segmentation/SliceAnchorPickerUI";
import HollowFlyout from "../components/segmentation/HollowFlyout";
import LevelTracingFlyout from "../components/segmentation/LevelTracingFlyout";
import { useScissorsTool } from "../helpers/viewer/useScissorsTool";
import { useInteractivePromptTool } from "../helpers/viewer/useInteractivePromptTool";
import { loadRecentUploads, renameRecentUpload } from "../helpers/recentUploads";
import {
  applyMargin, getActualMarginMm,
  applyIslandsOperation, applyLogicalOperator, applySmoothing,
  deleteSegmentEverywhere, getSegmentAtVoxel, getActiveEditSegment, type LogicalOperation,
  type LevelTraceOperation
} from "../helpers/CornerstoneNifti2";
import {
    API_BASE,
    APP_CONSTANTS,
    segmentation_categories,
    segmentation_category_colors,
} from "../helpers/constants";
import {
    ANGLE_TOOL,
    applyRemoteMaskRanges,
    applyRemoteMeasurement,
    applySharedMprView,
    applyVolume3DPreset,
    ARROW_TOOL,
    BIDIRECTIONAL_TOOL,
    captureViewportImages,
    centerOnCursor,
    clearMaskEditCursor,
    clearMeasurements,
    createNewAnnotationClass,
	createSegmentationShadow,
    disableVolume3D,
    diffSegmentationFromShadow,
    EDIT_BRUSH,
    EDIT_ERASER,
    ELLIPSE_TOOL,
    enableVolume3D,
    flipPaneHorizontal,
    FREEHAND_ROI_TOOL,
    getCrosshairMm,
    getCurrentVolumeModality,
    getCustomSegmentLabels,
    getMeasurementSummaries,
    getSharedMprView,
    getOrganCentroids,
    getOrganLabelAtPoint,
    getOrganLabelOnClick,
    LENGTH_TOOL,
    MAGNIFY_TOOL,
    moveCornerstoneCrosshairToMm,
    PROBE_TOOL,
    removeRemoteMeasurement,
    redoMaskEdit,
    registerNewSegmentColor,
    renderVisualization,
    resetMprOrientation,
	releasePrimaryMouseTools,
    ROI_TOOL,
    rotatePane90Clockwise,
    setActiveMaskEditTool,
    setActiveMeasurementTool,
    setFillOpacity,
    setOutlineOpacity,
    setPaneSliceIndex,
    setReferenceLinesEnabled,
    setVisibilities,
    setZoom,
    serializeMeasurement,
    startCine,
    stopCine,
    subscribeToCrosshairChanges,
    subscribeToMeasurementChanges,
    subscribeToMprViewChanges,
    subscribeToSegmentationEdits,
    subscribeToSliceChanges,
    subscribeToVolumeProgress,
    toggleCrosshairTool,
    releasePromptMouseButton,
    undoMaskEdit,
    upgradeCtVolume,
    upgradeSegmentationVolume,
    VOLUME_3D_PRESETS,
    VOLUME_3D_PRESETS_MR,
    zoomToFit,
	isSegmentPresent,
    type CinePane,
    type MeasurementSummary,
    type PrimaryMouseToolName,
    type SharedMeasurement,
    type SliceInfo,
	worldToVisiblePaneCanvas,
	setActiveEditSegment,
	beginBrushMaskGuard,
	endBrushMaskGuard,
} from "../helpers/CornerstoneNifti2";
import { useSmartFill } from "../helpers/viewer/useSmartFill";
import { hasSegmentationVolume } from "../helpers/CornerstoneNifti2"; 
import { useLevelTracing } from "../helpers/viewer/useLevelTracing";
import AnnotationToolbar, {
	type PrimaryEditTool,
	type ScissorsOptions,
} from "../components/viewer/AnnotationToolbar";
import { setMaskBrushSize } from "../helpers/CornerstoneNifti2";
import { useMorphPicker } from "../helpers/viewer/useMorphPicker";
import { useToolbarFlyout } from "../helpers/viewer/useToolbarFlyout";
import { useLassoTool } from "../helpers/viewer/useLassoTool";
import { useFocusedPane } from "../helpers/viewer/useFocusedPane";
import { useKeyboardShortcuts } from "../helpers/viewer/useKeyboardShortcuts";
import { type MaskingArea } from "../components/segmentation/MaskingSelect";
import { getLocalDicomFiles, loadLocalDicomSeries } from "../helpers/dicomLocal";
import { loadLocalNiftiAsRawBlobUrl } from "../helpers/localNifti";
import {
    describeBasis,
    loadOrganNorms,
    type OrganNorms,
} from "../helpers/organNorms";
import {
    computeStatRows,
    downloadStats,
    summarizeOutOfRange,
    type OrganMetric,
} from "../helpers/organStatsExport";
import {
    composeImagesSideBySide,
    ReadingSession,
    type SessionResult,
} from "../helpers/readingSession";
import { toolDisplayName, type ReportMeasurement } from "../helpers/sessionReport";
import {getPanTSId } from "../helpers/utils";
import { filenameToName } from "../helpers/utils.name";
import { decodeViewerState, encodeViewerState } from "../helpers/viewerShareState";
import { LiveRoomDock, LiveRoomHeader } from "../liveRooms/LiveRoomChrome";
import LiveRoomCreateDialog from "../liveRooms/LiveRoomCreateDialog";
import { appRootRelativeUrl } from "../liveRooms/protocol";
import type { LiveRoomController, LiveRoomMaskPatch } from "../liveRooms/types";
import { type CheckBoxData } from "../types";
import "./VisualizationPage.css";
import LiveWireOverlay from "../components/viewer/LiveWireOverlay";

type ViewMode = "mpr" | "axial" | "sagittal" | "coronal" | "3d";

// OHIF-style "hanging protocol" layouts for the MPR grid: besides the equal 2×2 grid,
// one pane can be given the lion's share of the space while the other three stack down
// a narrow side column — same idea as OHIF's asymmetric layouts, just a fixed small set
// of presets rather than a free-form layout editor. Only meaningful while viewMode is
// "mpr" (the single-view and 3d-fullscreen modes already dedicate 100% to one pane).
type LayoutPreset = "grid" | "axial-primary" | "sagittal-primary" | "coronal-primary" | "3d-primary";

const LAYOUT_PRESETS: { id: LayoutPreset; label: string }[] = [
	{ id: "grid", label: "Equal" },
	{ id: "axial-primary", label: "Axial Large" },
	{ id: "sagittal-primary", label: "Sagittal Large" },
	{ id: "coronal-primary", label: "Coronal Large" },
	{ id: "3d-primary", label: "3D Large" },
];

// Which pane each non-"grid" preset enlarges. The other three fill the remaining
// narrow column, in this fixed top-to-bottom order (primary pane excluded).
const LAYOUT_PRESET_PRIMARY: Record<Exclude<LayoutPreset, "grid">, ViewMode> = {
	"axial-primary": "axial",
	"sagittal-primary": "sagittal",
	"coronal-primary": "coronal",
	"3d-primary": "3d",
};
const LAYOUT_PANE_ORDER: ViewMode[] = ["axial", "sagittal", "coronal", "3d"];

// View-mode picker + pane-layout preset picker are both "ways to view / arrange the
// scan," so they share one "Layout ▾" toolbar dropdown instead of two separate
// always-visible rows of segmented buttons.
const VIEW_MODE_OPTIONS: { mode: ViewMode; label: string }[] = [
	{ mode: "mpr", label: "⊞ MPR" },
	{ mode: "axial", label: "Axial" },
	{ mode: "sagittal", label: "Sag" },
	{ mode: "coronal", label: "Cor" },
	{ mode: "3d", label: "3D" },
];
const VIEW_MODE_SHORT_LABEL: Record<ViewMode, string> = {
	mpr: "MPR",
	axial: "Axial",
	sagittal: "Sagittal",
	coronal: "Coronal",
	"3d": "3D",
};

export type MaskEditMode = "brush" | "eraser" | "smartfill" | "lasso" | null;

// Case metadata fields pulled from PanTS/metadata.xlsx (via /api/search), in display
// order — a curated subset of row_to_item's fields; spacing_sum/shape_sum/complete are
// internal sort helpers, not meaningful to show a reader.
const METADATA_FIELDS: { key: string; label: string }[] = [
	{ key: "PanTS ID", label: "PanTS ID" },
	{ key: "sex", label: "Sex" },
	{ key: "age", label: "Age" },
	{ key: "tumor", label: "Tumor" },
	{ key: "ct phase", label: "CT Phase" },
	{ key: "manufacturer", label: "Manufacturer" },
	{ key: "manufacturer model", label: "Scanner Model" },
	{ key: "study year", label: "Study Year" },
	{ key: "study type", label: "Study Type" },
	{ key: "site nationality", label: "Site" },
];

const formatMetaValue = (key: string, v: unknown): string => {
	if (key === "tumor") {
		if (v === 1 || v === true) return "Yes";
		if (v === 0 || v === false) return "No";
		return "Unknown";
	}
	if (v === null || v === undefined || v === "") return "—";
	if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(1);
	return String(v);
};

type OrganStat = OrganMetric;

// Formats a nullable metric for the organ-stats detail drawer — "—" when the backend
// didn't compute it (e.g. an empty/degenerate mask), fixed-point otherwise.
const fmtStat = (v: number | null, digits = 0): string => (v === null ? "—" : v.toFixed(digits));

// Cornerstone's segmentation Color is [r, g, b, a] on a 0–255 scale; CSS wants alpha 0–1.
// Falls back to a neutral gray if a label has no LUT entry (shouldn't happen in practice).
const colorToCss = (c: Color | undefined): string =>
	c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})` : "rgba(255, 255, 255, 0.4)";

// Resolves a segment index to a display name for BOTH the static 32 organ
// catalog and any runtime-created custom classes (segment indices beyond
// segmentation_categories.length, eg., from "New class" in annotations tool).

const resolveOrganLabel = (idx: number): string | undefined => {
    const staticName = segmentation_categories[idx - 1];
    if (staticName) return filenameToName(staticName);
    return getCustomSegmentLabels()[idx];
};

// Map an RGB triple to a plain color name so the AI can identify each
// segmentation-mask color by name (paired with the mask legend it receives).
const _COLOR_NAMES: { name: string; rgb: [number, number, number] }[] = [
	{ name: "red", rgb: [220, 30, 30] },
	{ name: "brownish red", rgb: [150, 40, 30] },
	{ name: "orange", rgb: [255, 140, 0] },
	{ name: "yellow", rgb: [230, 210, 60] },
	{ name: "green", rgb: [40, 170, 70] },
	{ name: "teal", rgb: [40, 180, 170] },
	{ name: "light blue", rgb: [120, 190, 235] },
	{ name: "blue", rgb: [50, 110, 220] },
	{ name: "purple", rgb: [140, 60, 200] },
	{ name: "pink", rgb: [235, 110, 175] },
	{ name: "magenta", rgb: [220, 60, 180] },
	{ name: "gray", rgb: [200, 200, 200] },
	{ name: "white", rgb: [245, 245, 245] },
];

function rgbToColorName(r: number, g: number, b: number): string {
	let best = _COLOR_NAMES[0];
	let bestDist = Infinity;
	for (const c of _COLOR_NAMES) {
		const d = (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2;
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best.name;
}

const CT_PRESETS = [
	{ name: "Soft Tissue", width: 400, center: 40 },
	{ name: "Bone", width: 1800, center: 400 },
	{ name: "Lung", width: 1500, center: -600 },
	{ name: "Liver", width: 150, center: -50 }, // Brightness 50 (= -center), Contrast 150 (= width)
	{ name: "Brain", width: 80, center: 40 },
	{ name: "Angio", width: 600, center: 150 }, // contrast-enhanced vessels (CTA)
] as const;

// Used only as a fallback for the very first frame or two, before a pane's
// Cornerstone viewport has actually been enabled yet — see getPanePxPerMm
// below for the real, per-pane, per-zoom-level calculation that replaced
// this as a fixed guess.
const PX_PER_MM_FALLBACK = 2.2;

// The brush-size dotted overlay used to just multiply diameterMm by the
// fixed PX_PER_MM_APPROX guess above and by the toolbar's own zoomLevel
// number — neither of which reflects a given pane's actual voxel spacing
// (axial/sagittal/coronal can each have different mm-per-voxel along their
// in-plane axes) or the viewport's real current zoom. That mismatch is why
// the overlay never quite matched the brush's real footprint. This instead
// asks Cornerstone directly, for the specific pane being drawn, how many
// on-screen canvas pixels correspond to 1mm of real-world distance right
// now — which already bakes in that pane's true spacing AND its current
// zoom, so diameterMm * getPanePxPerMm(...) is the brush's actual size.
function getPanePxPerMm(paneEl: HTMLDivElement | null): number {
	if (!paneEl || typeof window === "undefined") return PX_PER_MM_FALLBACK;
	try {
		const enabled = getEnabledElement(paneEl);
		const viewport = enabled?.viewport;
		if (!viewport || typeof viewport.canvasToWorld !== "function") return PX_PER_MM_FALLBACK;
		const p0 = viewport.canvasToWorld([0, 0]);
		const p1 = viewport.canvasToWorld([100, 0]);
		const dx = p1[0] - p0[0];
		const dy = p1[1] - p0[1];
		const dz = p1[2] - p0[2];
		const worldMm = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (!worldMm || !Number.isFinite(worldMm)) return PX_PER_MM_FALLBACK;
		return 100 / worldMm;
	} catch {
		return PX_PER_MM_FALLBACK;
	}
}
// Measurement tools (+ the magnify loupe, which shares the same primary-mouse-tool slot)
// shown inside the collapsible "Measure" flyout, so the toolbar isn't crowded with one
// button per tool (matches the split-button pattern OHIF uses). `key` is the keyboard
// shortcut (also shown in the flyout). Typed by PrimaryMouseToolName (not the narrower
// MeasurementToolName) so the magnify entry — a plain `string`, deliberately not part of
// the measurement-tool union — fits in the same array.
const MEASURE_TOOLS: { name: PrimaryMouseToolName; label: string; Icon: typeof IconRuler2; key: string }[] = [
	{ name: LENGTH_TOOL, label: "Distance (mm)", Icon: IconRuler2, key: "L" },
	{ name: BIDIRECTIONAL_TOOL, label: "Bidirectional · long × short axis", Icon: IconArrowsCross, key: "B" },
	{ name: ANGLE_TOOL, label: "Angle (°)", Icon: IconAngle, key: "A" },
	{ name: PROBE_TOOL, label: "HU at point", Icon: IconClick, key: "P" },
	{ name: ROI_TOOL, label: "Rect ROI · HU & area", Icon: IconSquareDashed, key: "R" },
	{ name: ELLIPSE_TOOL, label: "Ellipse ROI · HU & area", Icon: IconCircle, key: "E" },
	{ name: FREEHAND_ROI_TOOL, label: "Freehand ROI · HU & area", Icon: IconLasso, key: "F" },
	{ name: ARROW_TOOL, label: "Arrow · label a finding", Icon: IconArrowUpRight, key: "T" },
	{ name: MAGNIFY_TOOL, label: "Magnify loupe", Icon: IconZoomIn, key: "G" },
];

// One-time "click here to close" nudge shown next to the closing anchor
// (the highlighted/red first point) on the Lasso/Scissors live-wire
// overlay, the moment the cursor first gets close enough to actually close
// the loop. Fades away automatically after a few seconds rather than
// needing a dismiss click, since by the time it fades the person has
// almost always already seen the highlighted anchor itself. Resets the
// moment the loop is closed/cancelled (anchor goes away), so it can show
// again on the next shape.
const CLOSE_LOOP_HINT_VISIBLE_MS = 3000;
const CLOSE_LOOP_HINT_FADE_MS = 300;
function CloseLoopHint({ nearClose, anchor }: { nearClose: boolean; anchor: [number, number] | undefined }) {
	const [visible, setVisible] = useState(false);
	const [fading, setFading] = useState(false);
	// Tracks whether this hint has already been shown for the CURRENT loop
	// in progress, so it only ever fires once per shape rather than
	// re-triggering every time the cursor wanders in and out of range.
	const shownThisLoopRef = useRef(false);
	const fadeTimerRef = useRef<number | null>(null);
	const hideTimerRef = useRef<number | null>(null);

	const clearTimers = () => {
		if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);
		if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
		fadeTimerRef.current = null;
		hideTimerRef.current = null;
	};

	// No anchor means there's no shape in progress (just closed, cancelled,
	// or not started yet) — reset so the next shape can show the hint again.
	useEffect(() => {
		if (anchor) return;
		shownThisLoopRef.current = false;
		setVisible(false);
		setFading(false);
		clearTimers();
	}, [anchor]);

	useEffect(() => {
		if (!nearClose || !anchor || shownThisLoopRef.current) return;
		shownThisLoopRef.current = true;
		setFading(false);
		setVisible(true);
		fadeTimerRef.current = window.setTimeout(() => setFading(true), CLOSE_LOOP_HINT_VISIBLE_MS);
		hideTimerRef.current = window.setTimeout(() => setVisible(false), CLOSE_LOOP_HINT_VISIBLE_MS + CLOSE_LOOP_HINT_FADE_MS);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nearClose, anchor]);

	useEffect(() => () => clearTimers(), []);

	if (!visible || !anchor) return null;
	return (
		<div
			aria-hidden="true"
			style={{
				position: "absolute",
				left: anchor[0] + 14,
				top: anchor[1],
				transform: "translateY(-130%)",
				background: "rgba(0, 45, 114, 0.55)",
				border: "1px solid rgba(104, 172, 229, 0.55)",
				borderRadius: 6,
				color: "rgba(255, 255, 255, 0.9)",
				fontFamily: "system-ui, sans-serif",
				fontSize: 11,
				fontWeight: 700,
				padding: "5px 9px",
				whiteSpace: "nowrap",
				pointerEvents: "none",
				zIndex: 40,
				boxShadow: "0 6px 16px -6px rgba(0,0,0,0.35)",
				backdropFilter: "blur(2px)",
				opacity: fading ? 0 : 0.85,
				transition: `opacity ${CLOSE_LOOP_HINT_FADE_MS}ms ease`,
			}}
		>
			Click here to close the lasso
		</div>
	);
}

// WebGL readback is unreliable across GPU/driver combinations. Excluding the
// 3D pane prevents black frames from being sent to the vision assistant.
const INCLUDE_3D_PANE_IN_SNAPSHOTS: boolean = false;

// A stalled volume request used to leave the full viewer on a black "Preparing
// case" screen forever. Give a genuinely slow connection five full minutes
// before exposing recovery controls; only an abandoned request should retry.
const VIEWER_LOAD_TIMEOUT_MS = 300_000;
const VIEWER_RETRY_BASE_DELAY_MS = 2_000;
const VIEWER_RETRY_MAX_DELAY_MS = 30_000;

function isRetryableViewerLoadError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return false;
	if (error instanceof TypeError) return true;
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /network|fetch|connection|timeout|timed out|err_|unexpected end|status (408|429|5\d\d)/i.test(message);
}

function waitForViewerRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Viewer load was aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			window.clearTimeout(timer);
			reject(new DOMException("Viewer load was aborted", "AbortError"));
		};
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// Cornerstone's NIfTI loader starts a second, full-volume request after it has
// read the header. That later request does not accept the viewer AbortSignal,
// so aborting only the metadata promise still left the UI spinning when a
// proxy/QUIC connection stalled mid-download. Race the complete viewer setup
// with the signal so every stage has the same visible recovery path.
function awaitViewerLoadOrAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	disposeLateResult: (value: T) => void
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let aborted = false;
		const onAbort = () => {
			if (aborted) return;
			aborted = true;
			reject(new DOMException("Viewer load was aborted", "AbortError"));
		};

		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });

		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				if (aborted) {
					disposeLateResult(value);
					return;
				}
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				if (!aborted) reject(error);
			}
		);
	});
}

type VisualizationPageProps = {
	liveRoom?: LiveRoomController;
	soloChallenge?: SoloChallengeController;
	quizPractice?: QuizPracticeController;
};

function VisualizationPage({ liveRoom, soloChallenge, quizPractice }: VisualizationPageProps = {}) {
	// References and state
	const params = useParams();
	const isLiveRoom = Boolean(liveRoom);
	const isSoloChallenge = Boolean(soloChallenge);
	const isQuizPractice = Boolean(quizPractice);
	const liveRoomMaskUrl = liveRoom?.maskUrl;
	const soloChallengeMaskUrl = soloChallenge?.maskUrl;
	const quizPracticeMaskUrl = quizPractice?.maskUrl;
	const pantsCase = liveRoom?.metadata.case_id ?? soloChallenge?.challenge.case_id ?? quizPractice?.pack.case_id ?? params.caseId;
	const isCvCase = String(pantsCase ?? "").toUpperCase().startsWith("CV");
	const sessionId = liveRoom || soloChallenge || quizPractice ? undefined : params.sessionId;
	// Local DICOM mode (/dicom): a folder of .dcm files picked on the Upload page,
	// viewed entirely in-browser. No backend case, so no segmentation layer.
	const routerLocation = useLocation();
	const isDicom = !liveRoom && !soloChallenge && !quizPractice && routerLocation.pathname === "/dicom";
	// Local NIfTI (/local-nifti): a single .nii/.nii.gz picked on the Upload page, viewed
	// in-browser with no backend case. `isLocal` = either in-browser mode; both are
	// seg-less, so they share the same "hide segmentation UI, default to 3D volume" behavior.
	const isLocalNifti = !liveRoom && !soloChallenge && !quizPractice && routerLocation.pathname === "/local-nifti";
	const isLocal = isDicom || isLocalNifti;
	const [dicomError, setDicomError] = useState<string | null>(null);


	// Where to load the volumes from. Per the maintainer's rule, dataset cases load
	// from the lab's LOCAL endpoints (served off disk on the JHU server — much faster
	// for big full-body scans than streaming the .nii.gz from HuggingFace). We probe
	// the local file and only fall back to the public HuggingFace mirror when it isn't
	// present (e.g. a dev checkout without the image data), so the viewer never breaks.
	const caseId = isLocalNifti ? "Local NIfTI" : isDicom ? "Local DICOM" : pantsCase ?? sessionId ?? "1";
	const [ctUrl, setCtUrl] = useState<string | null>(null);
	const [segUrl, setSegUrl] = useState<string | null>(null);
	// Whether the local volumes exist (enables the HD toggle). Dataset cases default to
	// the low-res copy for fast loading; ?hd=1 in the URL requests full resolution.
	const [localAvailable, setLocalAvailable] = useState(false);
	const isHd = liveRoom
		? liveRoom.metadata.resolution === "full"
		: typeof window !== "undefined" && new URLSearchParams(window.location.search).get("hd") === "1";
	
	const [showAnnotationToolbar, setShowAnnotationToolbar] = useState(false);
	useEffect(() => {
		if (!showAnnotationToolbar) setEditMode((m) => (m === "brush" || m === "eraser" || m === "lasso" ? null : m));
	}, [showAnnotationToolbar]);

	// Refs into UI outside AnnotationToolbar (segments popup, slice-jump
	// overlay) so its Overview walkthrough can still spotlight them.
	const annotationPopupRef = useRef<HTMLDivElement>(null);
	const annotationPopupDragRef = useRef<HTMLDivElement>(null);
	const annotationPopupMinRef = useRef<HTMLButtonElement>(null);
	// Lets the topbar's auto-close handler below distinguish "this click was
	// the pencil button itself" from "this click was some other toolbar
	// control", so the two handlers don't double-toggle annotation mode.
	const annotatePencilRef = useRef<HTMLButtonElement>(null);
	// Wraps the standalone Undo/Redo buttons so the topbar's "close the
	// annotation ribbon on any other click" handler (below) can exclude
	// them too — otherwise clicking Undo while the ribbon is open bubbles
	// up and immediately closes the ribbon, which reads as "undo closed
	// the toolbar I just opened." Undo/redo should never affect ribbon
	// visibility, only mask/measurement history.
	const undoRedoGroupRef = useRef<HTMLDivElement>(null);
	const sliceJumpWrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		const resolveSources = async () => {
			if (isLocal) return; // local files, not URLs — the setup effect handles them
			// A case/reveal replacement must first invalidate the currently displayed
			// sources so no interaction can continue against the previous medical data.
			setCtUrl(null);
			setSegUrl(null);
			if (sessionId) {
				setCtUrl(`${API_BASE}/api/session-ct/${sessionId}`);
				setSegUrl(`${API_BASE}/api/session-segmentation/${sessionId}`);
				return;
			}
			const id = pantsCase ?? "1";
			const isCvCase = String(id).toUpperCase().startsWith("CV");
			// getPanTSId produces a garbage value for CV ids, but it's only used in the HF
			// fallback URLs which are never reached for CV (CT is always on the JHU server).
			const p = isCvCase ? "" : getPanTSId(id);
			const localCt = `${API_BASE}/api/get-main-nifti/${id}.nii.gz`;
			const localSeg = `${API_BASE}/api/get-segmentations/${id}.nii.gz`;
			const challengeSeg = soloChallengeMaskUrl ?? null;
			const hfCt = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/image_only/${p}/ct.nii.gz?download=true`;
			const hfSeg = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/mask_only/${p}/combined_labels.nii.gz?download=true`;
			// HEAD probe: fast, doesn't download the volume; 404/500 → use HF fallback.
			const localOk = await fetch(localCt, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
			if (cancelled) return;
			setLocalAvailable(localOk);
			// Keep the categorical mask at full resolution even while the CT uses its fast
			// preview. Cornerstone aligns both volumes in world space; downsampling labels
			// creates avoidable stair-stepping and loses small structures.
			const resParam = isHd ? "" : "?res=low";
			setCtUrl(localOk ? `${localCt}${resParam}` : hfCt);
			// CancerVerse cases have no masks yet — /api/get-segmentations returns
			// {"masks_available": false} (JSON, HTTP 200) which hangs the nifti loader.
			// Skip the seg URL entirely so the viewer opens CT-only without hanging.
			if (isLiveRoom) {
				setSegUrl(liveRoomMaskUrl ?? null);
			} else if (isSoloChallenge) {
				setSegUrl(challengeSeg);
			} else if (isQuizPractice) {
				setSegUrl(quizPracticeMaskUrl ?? null);
			} else if (isCvCase) {
				setSegUrl(null);
			} else {
				setSegUrl(localOk ? `${localSeg}${resParam}` : hfSeg);
			}
		};
		resolveSources();
		return () => { cancelled = true; };
	}, [pantsCase, sessionId, isHd, isLocal, isLiveRoom, isQuizPractice, isSoloChallenge, liveRoomMaskUrl, quizPracticeMaskUrl, soloChallengeMaskUrl]);

	// Flip between low-res and full-res by reloading the route — a fresh mount cleanly
	// re-inits the Cornerstone/NiiVue contexts (re-running them in place is fragile).
	const toggleHd = () => {
		const params = new URLSearchParams(window.location.search);
		if (isHd) params.delete("hd");
		else params.set("hd", "1");
		const qs = params.toString();
		window.location.href = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
	};
	

	const axial_ref = useRef<HTMLDivElement>(null);
	const sagittal_ref = useRef<HTMLDivElement>(null);
	const coronal_ref = useRef<HTMLDivElement>(null);
	// render_ref (3D NiiVue canvas) removed — the 3D view it fed is disabled;
	// restore this ref alongside the commented-out create3DVolume calls if re-enabled.
	// const _cmapRef = useRef<NColorMap>(null);
	// const TaskMenu_ref = useRef(null);
	const VisualizationContainer_ref = useRef(null);
	//   const lastClickInfoRef = useRef(null);
	const preIsolateCheckStateRef = useRef<boolean[] | null>(null);
	//const [isolatedOrgan, setIsolatedOrgan] = useState<string | null>(null);

	const [checkState, setCheckState] = useState<boolean[]>([true]);
	const meshCheckState = useMemo(() => {
		if (liveRoom?.metadata.mode === "quiz") {
			const lesionRevealed = Boolean(liveRoom.quiz?.reveal?.viewer_cue?.show_lesion_overlay);
			// The source-mask label can differ from the viewer's pancreatic-lesion mesh ID.
			// Keep that mesh hidden until the server-authored final reveal.
			const lesionMeshId = segmentation_categories.indexOf("pancreatic_lesion") + 1;
			return checkState.map((_, index) => (
				index === 0 || lesionRevealed || index !== lesionMeshId
			));
		}
		if (quizPractice) {
			const finalReveal = quizPractice.result?.reveals.find((item) => item.question_id === "conclusion");
			const lesionRevealed = Boolean(finalReveal?.viewer_cue?.show_lesion_overlay);
			const lesionMeshId = segmentation_categories.indexOf("pancreatic_lesion") + 1;
			return checkState.map((_, index) => (
				index === 0 || lesionRevealed || index !== lesionMeshId
			));
		}
		const meshOrganId = soloChallenge?.result?.ground_truth.mesh_organ_id;
		if (!isSoloChallenge || !meshOrganId || meshOrganId >= checkState.length) return checkState;
		return checkState.map((_, index) => index === 0 || index === meshOrganId);
	}, [checkState, isSoloChallenge, liveRoom?.metadata.mode, liveRoom?.quiz?.reveal, quizPractice, soloChallenge?.result]);
	const [NV, _setNV] = useState<Niivue | undefined>();
	const [checkBoxData, setCheckBoxData] = useState<CheckBoxData[]>([]);
	// Fill (solid color wash) and outline (border) opacity are independent sliders — see
	// setFillOpacity/setOutlineOpacity. Outline defaults to 0 (off), matching how the mask
	// looked before this split existed (borders were never actually rendered).
	const [opacityValue, setOpacityValue] = useState(
		APP_CONSTANTS.DEFAULT_SEGMENTATION_OPACITY * 100
	);
	
	const [outlineOpacityValue, setOutlineOpacityValue] = useState(0);
	// Current/total slice per MPR pane, for the "245/519" caption + drag scrollbar.
	// One event per case actually opened in the viewer — not per re-render, and
	// not for a viewer opened on a local file, which has no case behind it.
	useEffect(() => {
		if (pantsCase || sessionId) track("viewer_open_case");
	}, [pantsCase, sessionId]);

	// Populated by subscribeToSliceChanges once the volume is ready; null until then.
	const [sliceInfo, setSliceInfo] = useState<Record<CinePane, SliceInfo | null>>({
		axial: null,
		sagittal: null,
		coronal: null,
	});
	const sliceInfoRef = useRef(sliceInfo);
	useEffect(() => { sliceInfoRef.current = sliceInfo; }, [sliceInfo]);
	// Matches the "Soft Tissue" CT_PRESETS entry (W 400 / L 40) — activePreset below
	// defaults to that same preset, so the readout and the pre-highlighted button
	// should agree on first load instead of showing a level the preset never set.
	const [windowWidth, setWindowWidth] = useState(400);
	const [windowCenter, setWindowCenter] = useState(40);
	const [maskingArea, setMaskingArea] = useState<MaskingArea>("everywhere");
	// Resolves the global masking selection into the concrete inputs the existing
	// helper functions expect: which segment ids an "all/visible segments" operation
	// should run over, and whether the current pick means "restrict to inside" a set
	// of segments vs "restrict to outside" them.
	const resolveMaskingTargets = (): { applyToVisible: boolean; ids: number[]; inside: boolean; invalid?: boolean } => {
		const allIds = checkBoxData.map((o) => o.id);
		switch (maskingArea) {
			case "insideAllSegments":
			case "outsideAllSegments":
				return { applyToVisible: true, ids: allIds, inside: maskingArea.startsWith("inside") };
			case "insideVisibleSegments":
			case "outsideVisibleSegments":
				return { applyToVisible: true, ids: visibleSegmentIndices, inside: maskingArea.startsWith("inside") };
			case "insideSegment":
			case "outsideSegment":
				if (activeSegment == null) {
					return { applyToVisible: false, ids: [], inside: true, invalid: true };
				}
				return { applyToVisible: false, ids: [activeSegment], inside: maskingArea.startsWith("inside") };
			case "everywhere":
			default:
				return { applyToVisible: false, ids: [], inside: true };
		}
	};
	
	// Brief W/L readout: shown only while the user is actively dragging the brightness/
	// contrast sliders or picking a preset — not on the initial/deep-link window apply, and
	// not left on screen indefinitely. windowReadoutTimerRef holds the fade-out timeout so
	// each new change can restart it instead of stacking timers.
	const [windowReadoutVisible, setWindowReadoutVisible] = useState(false);
	const windowReadoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [renderingEngine, setRenderingEngine] =
		useState<RenderingEngine | null>(null);
	const [viewportIds, setViewportIds] = useState<string[]>([]);
	const [volumeId, setVolumeId] = useState<string | null>(null);
	const [showReportScreen, setShowReportScreen] = useState(false);
	const [showStats, setShowStats] = useState(false);
	const [showAISidebar, setShowAISidebar] = useState(false);
	// Width (px) of the AI sidebar; drag-resizable from its left edge. Both the
	// sidebar and the content shift read this via the --vp-ai-width CSS var.
	const [aiWidth, setAiWidth] = useState(400);
	const aiWidthRef = useRef(400);
	const vpRootRef = useRef<HTMLDivElement>(null);
	const [organStats, setOrganStats] = useState<OrganStat[] | null>(null);
	const [statsLoading, setStatsLoading] = useState(false);
	const [statsError, setStatsError] = useState(false);
	// Row index of the organ whose full metric breakdown (median/std dev/skew/kurtosis/...)
	// is expanded inline. Only one at a time — keeps the panel compact by default.
	const [expandedStatRow, setExpandedStatRow] = useState<number | null>(null);
	// Population reference + this case's demographics, used to show each organ's volume
	// percentile vs the dataset. Both are optional — if the norms asset is missing (e.g. a
	// dev checkout) or the case has no metadata, the panel just omits the percentile column.
	const [organNorms, setOrganNorms] = useState<OrganNorms | null>(null);
	const [demographics, setDemographics] = useState<{ sex: string | null; age: number | null } | null>(null);
	const normsTried = useRef(false);
	// Case metadata panel (PanTS/metadata.xlsx, via the same /api/search lookup that
	// already supplies demographics). demographicsTriedRef guards the fetch so it only
	// ever runs once per case, even if no matching row is found (in which case
	// caseMetadata stays null and the panel shows its "not available" state).
	const [showMetadata, setShowMetadata] = useState(false);
	const [caseMetadata, setCaseMetadata] = useState<Record<string, unknown> | null>(null);
	const demographicsTriedRef = useRef(false);
	// Measured download progress for the loading screen (from the nifti loader's real
	// bytes-loaded/total — accurate, not a guess).
	const [dlPct, setDlPct] = useState<number | null>(null);
	const [dlDone, setDlDone] = useState(false);
	const dlTotalsRef = useRef<Record<string, number>>({});
	// The tools live in a top toolbar (PYCAD-style) that sits above the viewports
	// in normal flow, always visible (no show/hide toggle - it was found to be
	// more trouble than it was worth: the reveal control's placement kept
	// clashing with the axial pane's own label, and it wasn't worth carrying).
	const topbarRef = useRef<HTMLDivElement>(null);
	// Keep --vp-topbar-h in sync with the real toolbar height (it wraps to
	// multiple rows on narrow screens) so anything docked below it — the
	// annotation ribbon — always sits flush under it instead of guessing a
	// fixed pixel value.
	useEffect(() => {
		const el = topbarRef.current;
		const root = document.documentElement;
		if (!el) return;
		const sync = () => root.style.setProperty("--vp-topbar-h", `${el.getBoundingClientRect().height}px`);
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const stageRef = useRef<HTMLDivElement>(null);
	const [showOrganDetails, setShowOrganDetails] = useState(false);
	const [loading, setLoading] = useState(true);
	const [viewerReady, setViewerReady] = useState(false);
	const [acceptedViewerVolumeId, setAcceptedViewerVolumeId] = useState<string | null>(null);
	const viewerReadyRef = useRef(false);
	useEffect(() => {
		viewerReadyRef.current = false;
		setViewerReady(false);
		setAcceptedViewerVolumeId(null);
		setLoading(true);
	}, [caseId, liveRoomMaskUrl, quizPracticeMaskUrl, soloChallengeMaskUrl]);
	// Do not make the report request part of the critical imaging path. Once the
	// CT and viewer are visible, prepare the compact report payload while the
	// browser is idle. The shared helper de-duplicates the eventual Report button
	// request, and the backend already caches completed reports per case.
	useEffect(() => {
		if (
			!viewerReady ||
			!pantsCase ||
			isLocal ||
			isCvCase ||
			isLiveRoom ||
			isSoloChallenge ||
			isQuizPractice
		) {
			return;
		}

		const prepare = () => { void prefetchReportData(String(pantsCase)); };
		const idleWindow = window as Window & {
			requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
			cancelIdleCallback?: (handle: number) => void;
		};
		if (idleWindow.requestIdleCallback) {
			const handle = idleWindow.requestIdleCallback(prepare, { timeout: 10_000 });
			return () => idleWindow.cancelIdleCallback?.(handle);
		}

		const handle = window.setTimeout(prepare, 2_000);
		return () => window.clearTimeout(handle);
	}, [viewerReady, pantsCase, isLocal, isCvCase, isLiveRoom, isSoloChallenge, isQuizPractice]);
	const [crosshairMm, setCrosshairMm] = useState<[number, number, number] | null>(null);
	const [labelColorMap, setLabelColorMap] = useState<{ [key: number]: Color }>(
		segmentation_category_colors
	);
	const [zoomLevel, setZoomLevel] = useState(1);
	const [crosshairToolActive, setCrosshairToolActive] = useState(true);
	// OHIF-style reference lines: unlike the crosshair's own intersection lines (which only
	// show while Crosshairs is the active navigation tool), this is a passive overlay that
	// keeps showing where the pane being scrolled cuts the other two, regardless of which
	// tool currently owns the mouse. Only one pane is ever the "source" at a time — a plain
	// toggle for on/off. The imperative apply happens in the effect below, which also
	// re-applies after any volume reload (a fresh tool group always starts with every tool
	// disabled).
	const [referenceLinesOn, setReferenceLinesOn] = useState(false);
	// Which measurement tool (or the magnify loupe) owns the primary mouse button
	// (null = navigation/crosshair).
	const [activeMeasureTool, setActiveMeasureTool] = useState<PrimaryMouseToolName | null>(null);
	// Cine playback: auto-scroll the current pane through its slices. The FPS slider is
	// always visible next to the play button (not just once playing) so the speed can be
	// dialed in before hitting play; changing it while already playing restarts the clip
	// at the new rate instead of waiting for a stop/start.
	const [cinePlaying, setCinePlaying] = useState(false);
	const [cineFps, setCineFps] = useState(12);
	// Mask editing: right-side panel + which brush (paint/erase) owns the mouse.
	const [editMode, setEditMode] = useState<MaskEditMode>(null);
	const [brushPreviewActive, setBrushPreviewActive] = useState(false);
	const [activeToolbarTool, setActiveToolbarTool] = useState<PrimaryEditTool>(null);
	
	
	// Only paint/erase/scissors/growFromSeeds need the pane to behave differently
	// (brush cursor, lasso clicks, smartfill scribbles). Everything else (margin,
	// islands, logical ops, smoothing, slice tools, level tracing) just needs its
	// flyout open — no separate pane interaction mode.
	const TOOLBAR_TO_EDIT_MODE: Partial<Record<Exclude<PrimaryEditTool, null>, MaskEditMode>> = {
	  paint: "brush",
	  erase: "eraser",
	  scissors: "lasso",
	  growFromSeeds: "smartfill",
	};

	

	
	const handleToolbarToolChange = (tool: PrimaryEditTool) => {
		if (!viewerReady || (tool && !hasActiveTarget)) return;
		setActiveToolbarTool(tool);
		setEditMode(tool ? TOOLBAR_TO_EDIT_MODE[tool] ?? null : null);
		// setMaskBrushSize's very first call (from the slider) is the only
		// thing that ever pushes diameterMm into Cornerstone's tool group —
		// if the group wasn't ready yet at that point (e.g. the user paints
		// before ever touching the slider), the brush silently falls back to
		// Cornerstone's own default instead of the 10mm the slider shows.
		// Re-push it here, every time paint/erase is actually selected, so
		// what gets painted always matches the slider by the time the brush
		// can be used — cheap and idempotent if it was already applied.
		if (tool === "paint" || tool === "erase") setMaskBrushSize(diameterMm);
	  };

	
	const handleDiameterChange = (mm: number) => {
	  setDiameterMm(mm);
	  setMaskBrushSize(mm);
	};
	const [diameterMm, setDiameterMm] = useState(10);
	const [scissorsOptions, setScissorsOptions] = useState<ScissorsOptions>({
		operation: "eraseInside",
		magnetEnabled: true,
	});

	const [activeSegment, setActiveSegmentState] = useState<number | null>(null);
	const [levelTraceTolerance, setLevelTraceTolerance] = useState(50);
	const [levelTraceOperation, setLevelTraceOperation] = useState<LevelTraceOperation>("fillInside");
	const [segmentColorsHex, setSegmentColorsHex] = useState<Record<number, string>>({});
	const [segmentVisibility, setSegmentVisibility] = useState<Record<number, boolean>>({});
	// "Show only target class's mask" toggle state — on by default. See the
	// isolation effect below for how this actually filters visibility.
	const [showOnlyTargetMask, setShowOnlyTargetMask] = useState(true);
	// Existing-organ dropdown in SegmentsPopup — lets the brush target one of the
	// 32 static catalog organs without listing them all as rows.
	const [activeCatalogOrganId, setActiveCatalogOrganId] = useState<number | null>(null);
	const hasSegments = checkBoxData.length > 0;


	// keep MaskBrush target in sync with the popup's active segment
	useEffect(() => {
		if (activeSegment != null) setActiveEditSegment(activeSegment);
	  }, [activeSegment]);

	// map paint/erase/scissors toolbar selection onto the existing Cornerstone tool wiring
	useEffect(() => {
	if (activeToolbarTool === "paint" || activeToolbarTool === "erase") {
		setActiveMeasurementTool(null);
		setActiveMaskEditTool(activeToolbarTool === "paint" ? EDIT_BRUSH : EDIT_ERASER);
	} else if (activeToolbarTool === "growFromSeeds") {
		setActiveMeasurementTool(null);
		setActiveMaskEditTool(null);
		releasePrimaryMouseTools();
	} else if (!activeMeasureTool) {
		setActiveMaskEditTool(null);
		toggleCrosshairTool(crosshairToolActive);
	}
	}, [activeToolbarTool]);

	const setActiveSegment = (id: number | null) => setActiveSegmentState(id);

	// Shared by both "select a custom class" and "select an existing organ"
	// (see onSelect/handleSelectCatalogOrgan below): moves both the 2D MPR
	// crosshair and the 3D crosshair to the centroid of whatever class was
	// just targeted, on axial/sagittal/coronal at once — same mechanism the
	// sidebar's "jump to organ" already uses (handleJumpToOrgan below), just
	// triggered from the popup's own row click instead. No-ops quietly if
	// the class has no voxels yet (nothing painted into it) or centroid data
	// isn't available for it.
	const jumpCrosshairToSegmentCentroid = (label: number) => {
		const centroid = getOrganCentroids()?.[label];
		if (!centroid) return;
		moveCornerstoneCrosshairToMm(centroid);
		setCrosshairMm(centroid);
	};

	// Selecting an existing organ from the dropdown targets the brush at it
	// exactly like clicking a custom-segment row does.
	const handleSelectCatalogOrgan = (id: number | null) => {
		setActiveCatalogOrganId(id);
		// Keep activeSegment in lockstep in both directions — deselecting
		// (id === null) must clear activeSegment too, or a stale id lingers
		// and SegmentsPopup keeps showing a target as active.
		setActiveSegmentState(id);
		if (id != null) jumpCrosshairToSegmentCentroid(id);
	};
	const handleRenameSegment = (id: number, name: string): boolean => {
		const dup = checkBoxData.some((s) => s.id !== id && s.label.toLowerCase() === name.toLowerCase());
		if (dup) return false;
		setCheckBoxData((prev) => prev.map((s) => (s.id === id ? { ...s, label: name } : s)));
		return true;
	};

	const handleSegmentColorChange = (id: number, hex: string) => {
	setSegmentColorsHex((prev) => ({ ...prev, [id]: hex }));
	registerNewSegmentColor(id, hexToColor(hex));
	};

	const handleToggleSegmentVisibility = (id: number) => {
	track("viewer_toggle_organ");
	setSegmentVisibility((prev) => {
		const next = { ...prev, [id]: prev[id] === false ? true : false };
		setCheckState((cs) => {
		const arr = [...cs];
		arr[id] = next[id] !== false;
		return arr;
		});
		return next;
	});
	};
	const hasAnySegments = checkBoxData.length > 0;
	useEffect(() => {
		// Catalog organs are already part of checkBoxData at load, so every
		// scope option (insideSegment, insideAllSegments, insideVisibleSegments,
		// and their outside equivalents) resolves for them exactly the way it
		// does for custom classes — no special-casing needed here anymore.
		const needsAnySegments =
			maskingArea === "insideAllSegments" ||
			maskingArea === "outsideAllSegments" ||
			maskingArea === "insideVisibleSegments" ||
			maskingArea === "outsideVisibleSegments";
		const needsActiveSegment = maskingArea === "insideSegment" || maskingArea === "outsideSegment";
		if ((needsAnySegments && !hasAnySegments) || (needsActiveSegment && activeSegment == null)) {
			setMaskingArea("everywhere");
		}
	}, [hasAnySegments, activeSegment, maskingArea]);

	const handleDeleteSegment = (id: number) => {
	// Clear every voxel belonging to this segment in the actual segmentation
	// volume first — otherwise the label data survives (still paintable, still
	// present in the 3D render, masking scopes, islands, etc) even though the
	// row disappears from the popup.
	const r = deleteSegmentEverywhere(id);
	if (r) sessionRef.current?.log("edit", `Deleted segment (${r.changedVoxels.toLocaleString()} vox)`, 2000);
	setCheckBoxData((prev) => prev.filter((s) => s.id !== id));
	setCheckState((prev) => { const n = [...prev]; n[id] = false; return n; });
	setSegmentColorsHex((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
	setSegmentVisibility((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
	// Deleting a class should always leave nothing targeted — not fall back
	// to auto-picking another remaining class as the new target — so the
	// person has to deliberately pick their next target rather than
	// unknowingly keep painting into whatever class happened to be next in
	// the list.
	setActiveCatalogOrganId(null);
	setActiveSegmentState(null);
	};

	const renderAnnotationFlyout = (tool: Exclude<PrimaryEditTool, null>, onApplied: () => void, onCloseSettings: () => void, onGuidedControlsChange: (controls: import("../components/segmentation/SliceAnchorPickerUI").GuidedFlowControls | null) => void) => {
	switch (tool) {
		case "margin": {
			const marginInfo = activeSegment ? getActualMarginMm(3) : null;
			return (
			  <MarginPanel
			  onApply={(op, mm) => {
				const { applyToVisible, ids } = resolveMaskingTargets();
				const r = applyMargin(op, mm, applyToVisible, ids, maskFilter);
				if (r) sessionRef.current?.log("edit", `Margin ${op} ${mm}mm (${r.changedVoxels.toLocaleString()} vox)`, 2000);
			}}			
				actualMm={marginInfo?.mm ?? null}
				actualVoxels={marginInfo?.voxels ?? null}
				onApplied={onApplied}
			  />
			);
		  }
		  case "islands":
			return (
			  <IslandsPanel
				onCloseSettings={onCloseSettings}
				onGuidedControlsChange={onGuidedControlsChange}
				onApply={(op, min) => {
					const r = applyIslandsOperation(op, min, islandSeedVoxel ?? undefined, maskFilter);
				  if (r) {
					sessionRef.current?.log("edit", `Islands: ${op} (${r.changedVoxels.toLocaleString()} vox)`, 2000);
					// "Split islands to segments" creates brand-new segment indices on
					// the backend (with their own color already registered) — fold
					// them into the same UI state a manually-created class would use,
					// so they show up in the segments popup as real, functioning
					// custom classes rather than invisible/unlabeled data.
					if (r.createdSegments?.length) {
						setCheckBoxData((prev) => [
							...prev,
							...r.createdSegments!.map((s) => ({ id: s.id, label: s.label })),
						]);
						setCheckState((prev) => {
							const next = [...prev];
							for (const s of r.createdSegments!) next[s.id] = true;
							return next;
						});
						setLabelColorMap((prev) => {
							const next = { ...prev };
							for (const s of r.createdSegments!) next[s.id] = s.color;
							return next;
						});
						setSegmentColorsHex((prev) => {
							const next = { ...prev };
							for (const s of r.createdSegments!) next[s.id] = colorToHex(s.color);
							return next;
						});
						// Same "just-created class becomes the target" behavior as
						// handleCreateClass above — otherwise the edit target is left
						// pointed at whatever the split just broke apart, which is a
						// confusing thing to keep painting into. Picks the first of
						// the new classes (order matches newLabelForComponent's
						// insertion order on the backend, which isn't otherwise
						// meaningful, but it has to be one of them).
						setActiveSegmentState(r.createdSegments[0].id);
						setActiveCatalogOrganId(null);
					}
				  }
				}}
				pickingSelectedIsland={morphPicker.picking}
				onPickSelectedIsland={morphPicker.startPicking}
				onResetPick={resetIslandPick}
				hasSelectedIsland={islandSeedVoxel != null && !islandPickInvalid}
				pickedInvalid={islandPickInvalid}
				targetKey={activeCatalogOrganId ?? activeSegment}
				onApplied={onApplied}
			  />
			);
			case "logicalOperators":
				return (
				  <LogicalOperatorsPanel
					segments={logicalOpSegments}
					targetSegmentId={activeSegment ?? checkBoxData[0]?.id ?? 1}
					operation={logicalOp}
					onOperationChange={setLogicalOp}
					sourceId={logicalOpSourceId}
					onSourceIdChange={setLogicalOpSourceId}
					bypassMasking={logicalOpBypassMasking}
					onBypassMaskingChange={setLogicalOpBypassMasking}
					onApply={(op, src, bypass) => {
					  const target = activeSegment ?? checkBoxData[0]?.id ?? 1;
					  const r = applyLogicalOperator(op, target, src, bypass, maskFilter);
					  if (r) sessionRef.current?.log("edit", `Logical op ${op} (${r.changedVoxels.toLocaleString()} vox)`, 2000);
					}}
					onApplied={onApplied}
				  />
				);
		case "growFromSeeds":
		return (
			<GrowFromSeedsFlyout
			markMode={smartFill.markMode}
			setMarkMode={smartFill.setMarkMode}
			scope={smartFill.scope}
			setScope={smartFill.setScope}
			apply={smartFill.apply}
			clearScribbles={smartFill.clearScribbles}
			hasForegroundMarks={smartFill.hasForegroundMarks}
			hasBackgroundMarks={smartFill.hasBackgroundMarks}
			onApplied={onApplied}
			onCloseSettings={onCloseSettings}
			onGuidedControlsChange={onGuidedControlsChange}
			/>
		);
		case "fillBetweenSlices":
		return (
			<FillBetweenSlicesFlyout
			pane={focusedPane.getFocusedPane()}
			totalSlices={sliceInfo[focusedPane.getFocusedPane()]?.total ?? 0}
			segmentIndex={activeSegment ?? 1}
			maskFilter={maskFilter}
			onLog={(d) => sessionRef.current?.log("edit", d, 2000)}
			onApplied={onApplied}
			onCloseSettings={onCloseSettings}
			onGuidedControlsChange={onGuidedControlsChange}
			/>
		);
		case "copyAcrossSlices":
		return (
			<CopyAcrossSlicesFlyout
			pane={focusedPane.getFocusedPane()}
			totalSlices={sliceInfo[focusedPane.getFocusedPane()]?.total ?? 0}
			segmentIndex={activeSegment ?? 1}
			maskFilter={maskFilter}
			onLog={(d) => sessionRef.current?.log("edit", d, 2000)}
			onApplied={onApplied}
			onCloseSettings={onCloseSettings}
			onGuidedControlsChange={onGuidedControlsChange}
			/>
		);
		case "hollow":
		return (
			<HollowFlyout
			segmentIndex={activeSegment ?? 1}
			maskFilter={maskFilter}
			onLog={(d) => sessionRef.current?.log("edit", d, 2000)}
			onApplied={onApplied}
			/>
		);
		case "smoothing":
		return (
			<SmoothingFlyout
			onApply={(method, kernelMm) => {
				const { applyToVisible, ids } = resolveMaskingTargets();
				const r = applySmoothing(kernelMm, applyToVisible, ids, maskFilter);
				if (r) sessionRef.current?.log("edit", `Smoothing ${method} (${r.changedVoxels.toLocaleString()} vox)`, 2000);
			}}
			onApplied={onApplied}
			/>
		);
		case "levelTracing":
			return (
				<LevelTracingFlyout
					operation={levelTraceOperation}
					onOperationChange={setLevelTraceOperation}
					toleranceHu={levelTraceTolerance}
					onToleranceChange={setLevelTraceTolerance}
					onCloseSettings={onCloseSettings}
				/>
			);
	}
	};
	


	
	const morphPicker = useMorphPicker({
		panelOpen: showAnnotationToolbar,
		onLog: (detail) => sessionRef.current?.log("edit", detail, 1500),
	  });

	// The islands "keep/remove selected" picker shares morphPicker.seedVoxel with
	// the other morphology tools, which has no concept of "this pick is stale."
	// We track a "cleared" marker instead of needing the hook itself to forget the
	// voxel: once cleared, the same seedVoxel value keeps reading as "nothing
	// picked" until the user actually clicks a new voxel (which changes the
	// value and naturally clears the marker again).
	// NOTE: this has to be React state, not a ref — a ref mutation doesn't
	// trigger a re-render, so the "picked" UI (and the Apply button's reset)
	// wouldn't actually update on screen until some unrelated state change
	// happened to force a re-render.
	const [clearedIslandSeed, setClearedIslandSeed] = useState<[number, number, number] | null>(null);
	const resetIslandPick = () => {
		setClearedIslandSeed(morphPicker.seedVoxel ?? null);
		// Switching operation (or target segment), or pressing Apply, should
		// also cancel an in-progress pick — otherwise morphPicker.picking stays
		// true and the viewport is left silently armed/waiting for a click for
		// an operation that may no longer need one.
		// If useMorphPicker doesn't expose a cancel method yet, add one there —
		// this call is a no-op until it does.
		(morphPicker as unknown as { stopPicking?: () => void; cancelPicking?: () => void }).stopPicking?.();
		(morphPicker as unknown as { stopPicking?: () => void; cancelPicking?: () => void }).cancelPicking?.();
	};
	const islandSeedVoxel =
		morphPicker.seedVoxel && morphPicker.seedVoxel !== clearedIslandSeed
			? morphPicker.seedVoxel
			: null;
	// A pick only counts if the clicked voxel actually belongs to the segment
	// the islands operation is about to run on — islands are just connected
	// components *within* the active segment, so a click anywhere else can't
	// be applied.
	const islandPickInvalid =
		islandSeedVoxel != null && getSegmentAtVoxel(islandSeedVoxel) !== getActiveEditSegment();

	
	const visibleSegmentIndices = useMemo(
		() => checkBoxData.filter((o) => checkState[o.id]).map((o) => o.id),
		[checkBoxData, checkState]
	);



	// Single source of truth for "what does the current masking selection
	// actually resolve to" — shared by the live maskFilter (used by every
	// non-brush tool) and by the brush's pointerup guard below, so the two
	// can never disagree about which area/ids are in effect.
	const resolvedMasking = useMemo(() => {
		const { ids, invalid } = resolveMaskingTargets();
		const effectiveArea = invalid || (maskingArea !== "everywhere" && ids.length === 0)
			? "everywhere"
			: maskingArea;
		return { effectiveArea, ids };
	}, [maskingArea, checkBoxData, visibleSegmentIndices, activeSegment, renderingEngine, viewportIds, volumeId]);

	const maskFilter = useMemo(
		() => buildMaskFilter(resolvedMasking.effectiveArea, resolvedMasking.ids),
		[resolvedMasking]
	);


	// Applies live pointer-driven edits (brush/eraser/scissors/level tracing):
	// commits the brush's mask guard.
	useEffect(() => {
		const isLiveCommitTool =
			editMode === "brush" ||
			editMode === "eraser" ||
			(editMode === "lasso" && activeToolbarTool === "scissors") ||
			activeToolbarTool === "levelTracing";
		if (!isLiveCommitTool) return;
	
		const isOnPane = (e: Event) => (e.target as HTMLElement)?.closest?.(".vp-pane");
	
		const onDown = (e: Event) => {
			if (!isOnPane(e)) return;
			if (editMode === "brush" || editMode === "eraser") beginBrushMaskGuard();
		};
		const onUp = () => {
			if (editMode === "brush" || editMode === "eraser") {
				endBrushMaskGuard(resolvedMasking.effectiveArea, resolvedMasking.ids);
			}
		};
	
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointerup", onUp, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("pointerup", onUp, true);
		};
	}, [editMode, activeToolbarTool, resolvedMasking]);
	// Resolves what the BRUSH is allowed to overwrite, given the same maskingArea/ids
	// every other tool's maskFilter already encodes. Brush locking is per-segment (not
	// per-voxel), so "outside X" unlocks every segment except X; "inside X" unlocks
	// just X; "everywhere" unlocks all. The eraser additionally needs background (0)
	// unlocked even under "inside" scopes, since ERASE_INSIDE_CIRCLE always writes 0
	// as its destination — if 0 stays locked the eraser silently does nothing.
	useEffect(() => {
		if (maskingArea === "everywhere") {
			setBrushMaskingScope("all");
			return;
		}
		const { ids } = resolveMaskingTargets();
		const inside = maskingArea.startsWith("inside");
		const erasing = editMode === "eraser";

		if (inside) {
			setBrushMaskingScope(erasing ? [...ids, 0] : ids);
		} else {
			const allIds = checkBoxData.map((o) => o.id);
			const complement = allIds.filter((id) => !ids.includes(id));
			setBrushMaskingScope([...complement, 0]); // "outside" already includes background
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maskingArea, checkBoxData, visibleSegmentIndices, activeSegment, editMode, renderingEngine, viewportIds, volumeId]);

	const smartFill = useSmartFill({
		enabled: editMode === "smartfill",
		sliceInfoRef,
		maskFilter,
		onLog: (detail) => sessionRef.current?.log("edit", detail, 2000),
	});
	
	const lasso = useLassoTool({
		enabled: editMode === "lasso" && activeToolbarTool !== "scissors",
		maskFilter,
		onLog: (detail) => sessionRef.current?.log("edit", detail, 2000),
	});
	
	const { applyToVisible, ids } = resolveMaskingTargets();
	const scissors = useScissorsTool({
		enabled: editMode === "lasso" && activeToolbarTool === "scissors",
		operation: scissorsOptions.operation,
		applyToVisibleSegments: applyToVisible,
		visibleSegmentIndices: ids,
		activeSegmentIndex: activeSegment,
		maskFilter, // <-- add this
		magnetEnabled: scissorsOptions.magnetEnabled,
		onLog: (detail) => sessionRef.current?.log("edit", detail, 2000),
	});
	const levelTracing = useLevelTracing({
		enabled: activeToolbarTool === "levelTracing",
		toleranceHu: levelTraceTolerance,
		operation: levelTraceOperation,
		activeSegmentIndex: activeSegment,
		maskFilter,
		// Lets the hook re-derive its cached preview outline (voxel-space,
		// camera-independent) against the new camera the instant zoom changes,
		// instead of leaving it drawn at old canvas pixels until the next
		// mousemove happens to refresh it.
		cameraVersion: zoomLevel,
		onLog: (detail) => sessionRef.current?.log("edit", detail, 1500),
	});

	// The active drawing tool for the pane handlers below — whichever one is
	// actually armed right now (they're mutually exclusive via `enabled`).
	const activeDrawTool = activeToolbarTool === "scissors" ? scissors : lasso;

	// Single entry point for both the toolbar's Undo button and the ⌘Z/Ctrl+Z
	// shortcut. Scissors/lasso place polygon points one click at a time
	// (usePolygonDraw's local `points` state) BEFORE anything is committed
	// to the shared mask-edit undo stack — that commit only happens once the
	// shape is closed. Previously Undo always called the global
	// `undoMaskEdit()` directly, with no awareness of an in-progress draw:
	// pressing it while a point was down undid the last COMMITTED mask edit
	// (e.g. a brush stroke) while doing nothing to the pending point, but
	// since the point then got silently cleared by the mask refresh that
	// undo triggers, one press looked like it undid two things at once —
	// the pending point AND the previous brush stroke. Now: if there's a
	// pending, uncommitted point, undo removes just that one point first
	// (activeDrawTool.undo(), from usePolygonDraw); only once there are no
	// pending points left does it fall through to the normal undoMaskEdit()
	// for the last committed edit. Redo has no equivalent concept for an
	// in-progress draw, so it's untouched.
	const handleUndo = useCallback(() => {
		if (activeDrawTool.anchorsCanvas.length > 0) {
			activeDrawTool.undo();
			return;
		}
		undoMaskEdit();
	}, [activeDrawTool]);

	// Progressive resolution: after the fast low-res load, the full-res CT streams in
	// the background and hot-swaps in place (no reload). idle → streaming → done/failed.
	const [enhance, setEnhance] = useState<{ state: "idle" | "streaming" | "done" | "failed"; pct: number | null }>({ state: "idle", pct: null });

	// True from the moment the Annotate button is clicked with HD not yet
	// ready until the HD upgrade (runEnhance) resolves one way or the
	// other. Drives the full-screen blurred loading overlay below AND
	// gates auto-opening the annotation toolbar/SegmentsPopup once the
	// upgrade finishes — see handleAnnotateClick. Kept separate from
	// `enhance.state === "streaming"` because the HD button itself can
	// also drive that state, and clicking HD manually should NOT pop the
	// annotation toolbar open when it finishes.
	const [annotateHdLoading, setAnnotateHdLoading] = useState(false);

	// Click/box-to-segment (interactive prompt tools). `res` MUST match the
	// grid the live segmentation volume is actually on right now — same
	// hdReady logic gating the Annotate button, not a separate guess. Placed
	// after `enhance` is declared above since both read enhance.state.
	const [promptToolBusy, setPromptToolBusy] = useState(false);
	const pointSegment = useInteractivePromptTool({
		enabled: activeToolbarTool === "pointSegment" && !promptToolBusy,
		mode: "point",
		apiBase: API_BASE,
		caseId: pantsCase ?? null,
		activeSegmentIndex: activeSegment,
		res: isHd || enhance.state === "done" ? "full" : "low",
		onLog: (detail) => sessionRef.current?.log("edit", detail, 2000),
		onBusyChange: setPromptToolBusy,
		// Single-shot tool, not equip-and-use like paint/erase — deselect
		// (icon loses its active/white-background state) once a click
		// actually produced a mask, instead of staying armed for repeated
		// clicks the way the brush does.
		onComplete: () => setActiveToolbarTool(null),
	});
	const boxSegment = useInteractivePromptTool({
		enabled: activeToolbarTool === "boxSegment" && !promptToolBusy,
		mode: "box",
		apiBase: API_BASE,
		caseId: pantsCase ?? null,
		activeSegmentIndex: activeSegment,
		res: isHd || enhance.state === "done" ? "full" : "low",
		onLog: (detail) => sessionRef.current?.log("edit", detail, 2000),
		onBusyChange: setPromptToolBusy,
		onComplete: () => setActiveToolbarTool(null),
	});

	const enhanceStartedRef = useRef(false);
	// Live mirrors so the async swap re-applies the *current* window/visibility, not
	// the values captured when the stream started.
	const windowRef = useRef({ w: windowWidth, c: windowCenter });
	const checkStateRef = useRef(checkState);
	const checkBoxDataRef = useRef(checkBoxData);
	useEffect(() => { windowRef.current = { w: windowWidth, c: windowCenter }; }, [windowWidth, windowCenter]);
	useEffect(() => { checkStateRef.current = checkState; }, [checkState]);
	useEffect(() => { checkBoxDataRef.current = checkBoxData; }, [checkBoxData]);

	// "Show only target class's mask" — one effect, driven directly off the
	// toggle + whatever's currently targeted:
	//   - ON: only the targeted class stays visible, everything else hides.
	//     Re-runs whenever the target changes too, so switching targets
	//     while the toggle is on automatically swaps which mask shows.
	//   - OFF: every class goes back to visible. This used to try to
	//     restore a snapshot of per-class visibility taken via a ref, but
	//     that snapshot was captured on mount (before segments had even
	//     loaded) and never refreshed afterward, so switching off almost
	//     always restored stale/empty state instead of actually revealing
	//     the other masks. Unconditionally showing everything on
	//     toggle-off is simpler and is what "show only target mask" -> off
	//     actually promises.
	const isolationTargetKey = activeCatalogOrganId ?? activeSegment;
	useEffect(() => {
		// No target selected — always show every mask, whether or not "show
		// only target mask" is on. Isolating to a single class only makes
		// sense once something is actually targeted; with nothing targeted,
		// silently leaving whatever was isolated before (or hiding
		// everything) both read as the mask having vanished for no reason.
		if (isolationTargetKey == null) {
			setCheckState((prev) => prev.map(() => true));
			return;
		}
		if (showOnlyTargetMask) {
			setCheckState((prev) => prev.map((_, id) => id === isolationTargetKey));
		} else {
			setCheckState((prev) => prev.map(() => true));
		}
	}, [showOnlyTargetMask, isolationTargetKey]);
	// 3D pane rendering mode: organ meshes (dataset cases) or shaded GPU volume
	// rendering of the CT itself (the only 3D option for local DICOM).
	const [threeDMode, setThreeDMode] = useState<"mesh" | "volume">(isLocal ? "volume" : "mesh");
	const [volumePreset, setVolumePreset] = useState<string>(VOLUME_3D_PRESETS[0].name);
	// CT presets by default; swapped for the MR set when a local DICOM turns out to be MR.
	const [volume3DPresets, setVolume3DPresets] = useState<readonly { name: string; label: string }[]>(VOLUME_3D_PRESETS);
	const [volume3DFailed, setVolume3DFailed] = useState(false);
	const volume3DRef = useRef<HTMLDivElement>(null);
	// Toolbar flyout groups — each declutters a cluster of related buttons behind one
	// icon + dropdown (same portal-at-fixed-position pattern, so none of them get
	// clipped by the scrollable toolbar). See useToolbarFlyout.
	const layoutFlyout = useToolbarFlyout(); // view mode + pane layout preset (stays open — a config panel)
	const windowFlyout = useToolbarFlyout(); // CT window presets (stays open — a config panel)
	const adjustFlyout = useToolbarFlyout(); // fill/border/brightness/contrast/zoom sliders + center/reset (stays open)
	const measureFlyout = useToolbarFlyout(); // measurement tools + magnify loupe
	const viewFlyout = useToolbarFlyout(); // hover-identify, reference lines, flip, rotate
	const cineFlyout = useToolbarFlyout(); // play/pause + FPS (stays open — a live mini-panel, not a pick-and-dismiss menu)
	const captureFlyout = useToolbarFlyout(); // snapshot, reading session, share link
	const panelsFlyout = useToolbarFlyout(); // organs, organ stats, case metadata, measurements list

	// Reading session (voice-assisted case review). The ref mirrors the state so event
	// handlers and Cornerstone subscriptions can log without re-subscribing on start/stop.
	const sessionRef = useRef<ReadingSession | null>(null);
	const [readingSession, setReadingSession] = useState<ReadingSession | null>(null);
	const [sessionStarting, setSessionStarting] = useState(false);
	const [sessionResult, setSessionResult] = useState<SessionResult | null>(null);
	const [sessionMeasurements, setSessionMeasurements] = useState<ReportMeasurement[]>([]);
	// Friendly name shown in the toolbar in place of the raw session UUID. Reads
	// from the SAME localStorage record the Upload page's "Completed Uploads"
	// list renders and renames, so the two are always in sync by construction
	// (one store, one label field) rather than two names that can drift apart.
	// null when this session has no local record (e.g. opened on a different
	// browser) -- falls back to the raw id in that case, same as before.
	const [scanLabel, setScanLabel] = useState<string | null>(null);
	const [renamingScan, setRenamingScan] = useState(false);
	const [scanRenameDraft, setScanRenameDraft] = useState("");
	useEffect(() => {
		if (!sessionId) { setScanLabel(null); return; }
		const match = loadRecentUploads().find((u) => u.sessionId === sessionId);
		setScanLabel(match?.label ?? null);
	}, [sessionId]);
	const commitScanRename = () => {
		if (!sessionId) return;
		renameRecentUpload(sessionId, scanRenameDraft);
		const match = loadRecentUploads().find((u) => u.sessionId === sessionId);
		setScanLabel(match?.label ?? null);
		setRenamingScan(false);
	};
	const [showMeasurePanel, setShowMeasurePanel] = useState(false);
	const [showLiveRoomCreate, setShowLiveRoomCreate] = useState(false);
	const [challengeMeasurements, setChallengeMeasurements] = useState<MeasurementSummary[]>([]);
	const [liveRoomDockOpen, setLiveRoomDockOpen] = useState(Boolean(liveRoom));
	const [openPinnedNote, setOpenPinnedNote] = useState<{ noteId: string; pane: CinePane } | null>(null);
	const segmentationShadowRef = useRef<Uint8Array | null>(null);
	const authoritativeMeasurementsRef = useRef(liveRoom?.state.measurements);
	authoritativeMeasurementsRef.current = liveRoom?.state.measurements;
	const initialLiveMeasurementsAppliedRef = useRef<string | null>(null);
	const initialChallengeMeasurementAppliedRef = useRef<string | null>(null);
	const challengeTimedOutRef = useRef(false);
	const challengeLengthMeasurement = useMemo(
		() => [...challengeMeasurements].reverse().find((measurement) => measurement.tool === LENGTH_TOOL) ?? null,
		[challengeMeasurements],
	);
	const serializedChallengeMeasurement = useMemo(
		() => challengeLengthMeasurement ? serializeMeasurement(challengeLengthMeasurement.uid) : null,
		[challengeLengthMeasurement],
	);
	const restoredChallengeAttemptId = soloChallenge?.attempt.attempt_id;
	const restoredChallengeMarker = soloChallenge?.marker ?? null;
	const restoredChallengeMeasurement = soloChallenge?.measurement ?? null;
	// Shareable-link state: brief "copied" confirmation, and a guard so a deep-link's view
	// state is applied exactly once after the volume finishes loading.
	const [shareCopied, setShareCopied] = useState(false);
	const shareStateAppliedRef = useRef(false);
	const [viewMode, setViewMode] = useState<ViewMode>("mpr");
	const focusedPane = useFocusedPane({
		viewMode,
		referenceLinesOn,
		onInteraction: liveRoom?.stopFollowing,
	});

	// Which pane gets the lion's share of the grid while in "mpr" view — no-op in the
	// single-view / 3d-fullscreen modes, which already give one pane 100% of the stage.
	const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>("grid");
	const [activePreset, setActivePreset] = useState<string>("Soft Tissue");
	const [_tooltip, setToolTip] = useState({
		visible: false,
		x: 0,
		y: 0,
		text: "",
	});

	// On by default: hovering an organ names it without having to find and
	// enable the tool first. The View menu item still toggles it off.
	const [hoverIdentifyEnabled, setHoverIdentifyEnabled] = useState(true);

	// The viewer fills the window itself and every pane handles its own wheel
	// (slice scroll), so the page must never scroll underneath it. Without this,
	// a wheel tick the pane doesn't consume (end of the stack, over the 3D pane,
	// a toolbar) scrolls the whole window and the layout visibly jumps.
	useEffect(() => {
		const html = document.documentElement;
		const body = document.body;
		const prev = {
			htmlOverflow: html.style.overflow,
			bodyOverflow: body.style.overflow,
			htmlOverscroll: html.style.overscrollBehavior,
		};
		html.style.overflow = "hidden";
		body.style.overflow = "hidden";
		html.style.overscrollBehavior = "none";
		return () => {
			html.style.overflow = prev.htmlOverflow;
			body.style.overflow = prev.bodyOverflow;
			html.style.overscrollBehavior = prev.htmlOverscroll;
		};
	}, []);
	const [hoverOrganTip, setHoverOrganTip] = useState({
		visible: false,
		x: 0,
		y: 0,
		text: "",
		color: "transparent",
	});
	const hasActiveTarget = activeSegment != null;

	useEffect(() => {
		if (!hasActiveTarget && activeToolbarTool) {
			setActiveToolbarTool(null);
			setEditMode(null);
		}
	}, [hasActiveTarget]);
	// const location = useLocation();
	// Load and render visualization on first render

	// Single owner for the primary mouse button, by priority:
	useEffect(() => {
		if (editMode === "brush" || editMode === "eraser") {
			setActiveMeasurementTool(null);
			setActiveMaskEditTool(editMode === "brush" ? EDIT_BRUSH : EDIT_ERASER);
		} else if (activeToolbarTool === "pointSegment" || activeToolbarTool === "boxSegment") {
			// AI prompt tools: release the primary button from ALL navigation tools
			// (crosshair AND pan) so a React-side drag owns the mouse exclusively.
			// toggleCrosshairTool(false) would re-arm PanTool, causing the viewport
			// to pan while the user draws a box. releasePromptMouseButton() leaves
			// no Cornerstone tool active on primary.
			setActiveMeasurementTool(null);
			setActiveMaskEditTool(null);
			releasePromptMouseButton();
		} else if (editMode === "smartfill") {
			setActiveMeasurementTool(null);
			setActiveMaskEditTool(null);
			toggleCrosshairTool(false);
		} else if (activeMeasureTool) {
			setActiveMaskEditTool(null);
			setActiveMeasurementTool(activeMeasureTool);
		} else {
			setActiveMaskEditTool(null);
			setActiveMeasurementTool(null);
			toggleCrosshairTool(crosshairToolActive);
		}
	}, [editMode, activeToolbarTool, activeMeasureTool, crosshairToolActive]);



	useEffect(() => {
		if (editMode !== "lasso") lasso.reset();
	}, [editMode]);

	useEffect(() => {
		const unsubscribe = subscribeToCrosshairChanges((mm) => {
			setCrosshairMm([
				mm[0],
				mm[1],
				mm[2],
			]);
			// Coalesced: a scroll through 40 slices reads as one "navigated to…" line.
			sessionRef.current?.log(
				"navigate",
				`Navigated to (${mm.slice(0, 3).map((v) => v.toFixed(0)).join(", ")}) mm`,
				1500
			);
		});

		return unsubscribe;
	}, [])

	// ---- Reading session: capture, key images, lifecycle ------------------------------

	// Capture the visible panes (with annotations). During a session the shot joins the
	// session's key images; outside one it downloads as a single side-by-side PNG.
	const takeSnapshot = useCallback(async (label?: string) => {
		const images = await captureViewportImages();
		if (!images.length) return;
		const session = sessionRef.current;
		if (session) {
			session.addShot(label ?? "Key image", images);
			session.log("screenshot", label ?? `Key image (${images.map((im) => im.name).join(", ")})`);
		} else {
			const composite = await composeImagesSideBySide(images);
			if (!composite) return;
			const link = document.createElement("a");
			link.href = composite;
			link.download = `case${caseId}_snapshot.png`;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
		}
	}, [caseId]);

	// Downscale a screenshot so the vision model gets a small, fast-to-process
	// image (full-res panes make local vision models slow and prone to timeout).
	const downscaleDataUrl = (dataUrl: string, maxDim = 768): Promise<string> =>
		new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
				if (scale >= 1) return resolve(dataUrl);
				const c = document.createElement("canvas");
				c.width = Math.round(img.width * scale);
				c.height = Math.round(img.height * scale);
				const ctx = c.getContext("2d");
				if (!ctx) return resolve(dataUrl);
				// JPEG has no alpha: paint the CT viewer's black ground first so a
				// source with transparent pixels does not decode as white fringing.
				ctx.fillStyle = "#000";
				ctx.fillRect(0, 0, c.width, c.height);
				ctx.drawImage(img, 0, 0, c.width, c.height);
				resolve(c.toDataURL("image/jpeg", 0.85));
			};
			img.onerror = () => resolve(dataUrl);
			img.src = dataUrl;
		});

	// Capture for the AI assistant: the three MPR panes (via the shared helper)
	// plus the 3D pane's WebGL canvas — the four views the user sees in the 2×2
	// grid. The segmentation masks are left VISIBLE so the model can identify
	// each organ by its color (paired with the mask legend). Images are
	// downscaled before returning so the vision model responds quickly.
	// Wait for a frame that has actually been presented. rAF never fires in a
	// background tab, so cap the wait rather than hanging the capture.
	const nextPresentedFrame = () =>
		new Promise<void>((resolve) => {
			const done = () => resolve();
			const timer = window.setTimeout(done, 250);
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					window.clearTimeout(timer);
					done();
				})
			);
		});

	// A WebGL readback that lost its drawing buffer comes out as one flat color —
	// the "black 3D screenshot". Sample the CAPTURED IMAGE (not the canvas, which
	// may have been redrawn since) so a dead capture is caught here instead of
	// being sent to the vision model, which would then confidently describe it.
	const imageLooksBlank = (dataUrl: string): Promise<boolean> =>
		new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				try {
					const probe = document.createElement("canvas");
					probe.width = 32;
					probe.height = 32;
					const ctx = probe.getContext("2d", { willReadFrequently: true });
					if (!ctx) return resolve(false);
					ctx.drawImage(img, 0, 0, probe.width, probe.height);
					const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
					let min = 255;
					let max = 0;
					for (let i = 0; i < data.length; i += 4) {
						const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
						if (luma < min) min = luma;
						if (luma > max) max = luma;
					}
					resolve(max - min < 4);
				} catch {
					resolve(false); // unreadable — assume the shot is usable
				}
			};
			img.onerror = () => resolve(true);
			img.src = dataUrl;
		});

	const captureAllViews = useCallback(async () => {
		const shots: { name: string; dataUrl: string }[] = await captureViewportImages();
		if (INCLUDE_3D_PANE_IN_SNAPSHOTS) {
			try {
				const pane = document.querySelector<HTMLElement>(".render");
				const paneVisible = !pane || pane.offsetParent !== null;
				if (paneVisible) {
					// Draw a frame and read the pixels back in one synchronous step;
					// querying the canvas and reading it later races the compositor.
					let url = captureMeshCanvas();

					if (!url) {
						const canvas =
							document.querySelector<HTMLCanvasElement>("canvas[data-bodymaps-3d]") ??
							pane?.querySelector<HTMLCanvasElement>("canvas") ??
							null;
						if (canvas && canvas.width) {
							await nextPresentedFrame();
							url = canvas.toDataURL("image/png");
						}
					}

					if (url && url.length > 128 && !(await imageLooksBlank(url))) {
						shots.push({ name: "3d", dataUrl: url });
					}
				}
			} catch (error) {
				console.warn("[BodyMaps AI] 3D capture skipped", error);
			}
		}
		// Downscale all shots for fast vision inference.
		return Promise.all(
			shots.map(async (s) => ({ name: s.name, dataUrl: await downscaleDataUrl(s.dataUrl) }))
		);
	}, []);

	// Color → organ legend for the currently visible masks, so the vision model
	// can name each colored region correctly instead of guessing.
	const getMaskLegend = useCallback((): { organ: string; color: string }[] => {
		const legend: { organ: string; color: string }[] = [];
		for (const item of checkBoxData) {
			if (!checkState[item.id]) continue;
			const rgb = labelColorMap[item.id] ?? segmentation_category_colors[item.id];
			if (!rgb) continue;
			legend.push({ organ: item.label, color: rgbToColorName(rgb[0], rgb[1], rgb[2]) });
		}
		return legend;
	}, [checkBoxData, checkState, labelColorMap]);

	// Live drag-resize of the AI panel. During the drag we set the CSS var
	// directly on the page root (cheap, no React re-render) so the sidebar and
	// the CT views resize smoothly; on release we persist the width to state.
	const applyAiWidth = useCallback((clientX: number) => {
		const w = Math.min(760, Math.max(320, window.innerWidth - clientX));
		aiWidthRef.current = w;
		vpRootRef.current?.style.setProperty("--vp-ai-width", `${w}px`);
	}, []);

	const commitAiWidth = useCallback(() => {
		setAiWidth(aiWidthRef.current);
	}, []);

	const startReadingSession = async () => {
		if (sessionRef.current || sessionStarting) return;
		setSessionStarting(true);
		try {
			const session = await ReadingSession.start(String(caseId));
			sessionRef.current = session;
			setReadingSession(session);
			session.log(
				"session",
				session.micGranted
					? "Reading session started — narration recording"
					: "Reading session started — no microphone, events only"
			);
		} finally {
			setSessionStarting(false);
		}
	};

	const stopReadingSession = async () => {
		const session = sessionRef.current;
		if (!session) return;
		sessionRef.current = null;
		setReadingSession(null);
		// Snapshot the measurement inventory at stop time — it feeds the draft report.
		const measurements = getMeasurementSummaries().map((m) => ({
			tool: m.tool,
			label: m.label,
			value: m.value,
		}));
		const result = await session.stop();
		setSessionMeasurements(measurements);
		setSessionResult(result);
	};

	// If the user navigates away mid-session, release the microphone.
	useEffect(() => {
		return () => {
			void sessionRef.current?.stop();
			sessionRef.current = null;
		};
	}, []);

	// Completed measurements land in the session timeline and auto-capture a key image
	// (on the next frame, after the annotation has painted onto the SVG overlay).
	const liveRoomConnected = liveRoom?.connectionState === "connected" && !liveRoom.collaborationLocked;
	const sendLiveRoomDurable = liveRoom?.sendDurable;
	const setSoloChallengeMeasurement = soloChallenge?.setMeasurement;
	useEffect(() => {
		const unsubscribe = subscribeToMeasurementChanges((kind, m) => {
			if (isSoloChallenge) {
				const summaries = getMeasurementSummaries();
				setChallengeMeasurements(summaries);
				const latestLength = [...summaries].reverse().find((measurement) => measurement.tool === LENGTH_TOOL);
				setSoloChallengeMeasurement?.(latestLength ? serializeMeasurement(latestLength.uid) : null);
			}
			if (liveRoomConnected && sendLiveRoomDurable) {
				const recoverAuthoritativeMeasurement = () => {
					const authoritative = authoritativeMeasurementsRef.current?.[m.uid];
					if (authoritative) applyRemoteMeasurement(authoritative as SharedMeasurement);
					else removeRemoteMeasurement(m.uid);
				};
				if (kind === "removed") {
					void sendLiveRoomDurable("measurement.delete", { id: m.uid }, undefined, { onRejected: recoverAuthoritativeMeasurement });
				} else {
					const measurement = serializeMeasurement(m.uid);
					if (measurement) void sendLiveRoomDurable("measurement.upsert", { measurement }, undefined, { onRejected: recoverAuthoritativeMeasurement });
				}
			}
			if (kind === "completed") {
				track("viewer_measure");
			}
			if (kind === "completed" && sessionRef.current) {
				sessionRef.current.log("measure", `${toolDisplayName(m.tool)} measured: ${m.value}`);
				requestAnimationFrame(() => {
					void takeSnapshot(`${toolDisplayName(m.tool)} — ${m.value}`);
				});
			} else if (kind === "removed" && sessionRef.current) {
				sessionRef.current.log("measure", `Removed a ${toolDisplayName(m.tool)} measurement`);
			}
		});
		return unsubscribe;
	}, [takeSnapshot, liveRoomConnected, sendLiveRoomDurable, isSoloChallenge, setSoloChallengeMeasurement]);

	useEffect(() => {
		if (!soloChallenge || soloChallenge.result || soloChallenge.remainingSeconds > 0) return;
		if (challengeTimedOutRef.current) return;
		challengeTimedOutRef.current = true;
		void soloChallenge.submit(serializedChallengeMeasurement, true);
	}, [soloChallenge, soloChallenge?.remainingSeconds, soloChallenge?.result, serializedChallengeMeasurement]);

	useEffect(() => {
		if (!isSoloChallenge || !viewerReady || checkBoxData.length === 0) return;
		const visible = [true, ...checkBoxData.map(() => false)];
		const revealedLabel = soloChallenge?.result?.ground_truth.segmentation_label;
		const meshOrganId = soloChallenge?.result?.ground_truth.mesh_organ_id;
		if (revealedLabel && revealedLabel < visible.length) {
			visible[revealedLabel] = true;
			const revealColor: Color = [239, 68, 68, 255];
			registerNewSegmentColor(revealedLabel, revealColor);
			setLabelColorMap((current) => ({
				...current,
				[revealedLabel]: revealColor,
				...(meshOrganId ? { [meshOrganId]: revealColor } : {}),
			}));
		}
		setCheckState(visible);
		setVisibilities(visible);
		if (soloChallenge?.result) {
			setOpacityValue(76);
			setFillOpacity(0.76);
			const [start, end] = soloChallenge.result.ground_truth.reference_measurement_lps;
			if (start?.length === 3 && end?.length === 3) {
				const center: [number, number, number] = [
					(start[0] + end[0]) / 2,
					(start[1] + end[1]) / 2,
					(start[2] + end[2]) / 2,
				];
				moveCornerstoneCrosshairToMm(center);
				setCrosshairMm(center);
			}
		}
	}, [isSoloChallenge, soloChallenge?.result, viewerReady, checkBoxData]);

	// Quiz questions share only the server-authored viewer cue. Student navigation
	// remains local; masks and measurements stay hidden until the final reveal.
	useEffect(() => {
		if (!liveRoom || liveRoom.metadata.mode !== "quiz" || !viewerReady || !liveRoom.quiz) return;
		const quiz = liveRoom.quiz;
		if (quiz.phase === "question_open") {
			clearMeasurements();
			const hidden = [true, ...checkBoxData.map(() => false)];
			setCheckState(hidden);
			setVisibilities(hidden);
			const cue = quiz.current_question?.viewer_cue;
			if (cue?.crosshair_lps) {
				moveCornerstoneCrosshairToMm(cue.crosshair_lps);
				setCrosshairMm([...cue.crosshair_lps]);
			}
			return;
		}
		const revealCue = quiz.reveal?.viewer_cue;
		if (!revealCue?.show_lesion_overlay) return;
		const visible = [true, ...checkBoxData.map(() => false)];
		if (visible.length > 1) visible[1] = true;
		const revealColor: Color = [239, 68, 68, 255];
		registerNewSegmentColor(1, revealColor);
		setLabelColorMap((current) => ({ ...current, 1: revealColor }));
		setCheckState(visible);
		setVisibilities(visible);
		setOpacityValue(76);
		setFillOpacity(0.76);
		if (revealCue.crosshair_lps) {
			moveCornerstoneCrosshairToMm(revealCue.crosshair_lps);
			setCrosshairMm([...revealCue.crosshair_lps]);
		}
		if (revealCue.reference_measurement_lps) {
			applyRemoteMeasurement({
					id: `quiz-${liveRoom.metadata.quiz_pack_id ?? liveRoom.metadata.case_id}-reference-measurement`,
				tool: LENGTH_TOOL,
				points: revealCue.reference_measurement_lps,
				polyline: [],
					text: `${revealCue.reference_diameter_mm ?? 0} mm reference`,
				label: "Reference diameter",
				frame_of_reference: "",
				metadata: {},
			});
		}
	}, [
		liveRoom?.metadata.mode,
		liveRoom?.quiz?.phase,
		liveRoom?.quiz?.current_question?.id,
		liveRoom?.quiz?.reveal?.question_id,
		liveRoom?.metadata.case_id,
		liveRoom?.metadata.quiz_pack_id,
		liveRoom?.maskUrl,
		viewerReady,
		checkBoxData,
	]);

	useEffect(() => {
		if (!quizPractice || !viewerReady) return;
		const question = quizPractice.pack.questions[quizPractice.questionIndex];
		if (!quizPractice.result) {
			clearMeasurements();
			const hidden = [true, ...checkBoxData.map(() => false)];
			setCheckState(hidden);
			setVisibilities(hidden);
			const cue = question?.viewer_cue;
			if (cue?.crosshair_lps) {
				moveCornerstoneCrosshairToMm(cue.crosshair_lps);
				setCrosshairMm([...cue.crosshair_lps]);
			}
			return;
		}
		const conclusion = quizPractice.result.reveals.find((item) => item.question_id === "conclusion");
		const revealCue = conclusion?.viewer_cue;
		if (!revealCue) return;
		const visible = [true, ...checkBoxData.map(() => false)];
		if (revealCue.show_lesion_overlay && visible.length > 1) {
			visible[1] = true;
			const revealColor: Color = [239, 68, 68, 255];
			registerNewSegmentColor(1, revealColor);
			setLabelColorMap((current) => ({ ...current, 1: revealColor }));
		}
		setCheckState(visible);
		setVisibilities(visible);
		if (revealCue.show_lesion_overlay) {
			setOpacityValue(76);
			setFillOpacity(0.76);
		}
		if (revealCue.crosshair_lps) {
			moveCornerstoneCrosshairToMm(revealCue.crosshair_lps);
			setCrosshairMm([...revealCue.crosshair_lps]);
		}
		if (revealCue.reference_measurement_lps) {
			applyRemoteMeasurement({
				id: `quiz-${quizPractice.pack.pack_id}-reference-measurement`,
				tool: LENGTH_TOOL,
				points: revealCue.reference_measurement_lps,
				polyline: [],
				text: `${revealCue.reference_diameter_mm ?? 0} mm reference`,
				label: "Reference diameter",
				frame_of_reference: "",
				metadata: {},
			});
		}
	}, [
		quizPractice?.pack.pack_id,
		quizPractice?.questionIndex,
		quizPractice?.result,
		quizPractice?.maskUrl,
		viewerReady,
		checkBoxData,
	]);

	// A solo attempt is tab-scoped and survives refresh. Once Cornerstone is ready,
	// restore its saved marker and portable length annotation into the new viewports.
	useEffect(() => {
		if (
			!isSoloChallenge ||
			!acceptedViewerVolumeId ||
			initialChallengeMeasurementAppliedRef.current === acceptedViewerVolumeId
		) return;
		initialChallengeMeasurementAppliedRef.current = acceptedViewerVolumeId;
		clearMeasurements();
		setChallengeMeasurements([]);
		if (restoredChallengeMarker) {
			moveCornerstoneCrosshairToMm(restoredChallengeMarker);
			setCrosshairMm([...restoredChallengeMarker]);
		}
		if (restoredChallengeMeasurement) {
			applyRemoteMeasurement(restoredChallengeMeasurement);
			setChallengeMeasurements(getMeasurementSummaries());
		}
	}, [isSoloChallenge, acceptedViewerVolumeId, restoredChallengeAttemptId, restoredChallengeMarker, restoredChallengeMeasurement]);

	// Live Room durable state is loaded before Cornerstone.  Hydrate shared measurements
	// once the viewports exist, then apply later committed events incrementally.
	useEffect(() => {
		if (
			!liveRoom ||
			!acceptedViewerVolumeId ||
			initialLiveMeasurementsAppliedRef.current === acceptedViewerVolumeId
		) return;
		initialLiveMeasurementsAppliedRef.current = acceptedViewerVolumeId;
		if (liveRoom.metadata.mode !== "quiz") clearMeasurements();
		for (const measurement of Object.values(liveRoom.state.measurements)) {
			applyRemoteMeasurement(measurement as SharedMeasurement);
		}
	}, [liveRoom?.metadata.mode, liveRoom?.state.measurements, acceptedViewerVolumeId]);

	useEffect(() => {
		if (!liveRoom?.pendingEvents.length || !viewerReady) return;
		let appliedThrough = 0;
		for (const { event, replayed } of liveRoom.pendingEvents) {
			appliedThrough = Math.max(appliedThrough, event.seq);
			// Sender already has ordinary live edits. Replayed edits and server-generated
			// undo events must also be applied to the sender's newly loaded viewport.
			if (event.participant_id === liveRoom.participantId && !event.undo_of && !replayed) continue;
			const payload = event.payload as Record<string, unknown>;
			if (event.type === "measurement.upsert" && payload.measurement) {
				applyRemoteMeasurement(payload.measurement as SharedMeasurement);
			} else if (event.type === "measurement.delete" && payload.id) {
				removeRemoteMeasurement(String(payload.id));
			} else if (event.type === "mask.patch") {
				const patch = payload as unknown as LiveRoomMaskPatch;
				applyRemoteMaskRanges(patch.ranges, segmentationShadowRef.current);
			}
		}
		liveRoom.acknowledgeEvents(appliedThrough);
	}, [liveRoom?.pendingEvents, liveRoom?.participantId, liveRoom?.acknowledgeEvents, viewerReady]);

	// Client shadow + modified-slice RLE keeps brush traffic proportional to changed
	// voxels instead of serializing a full labelmap after every stroke.
	useEffect(() => {
		if (!liveRoom || !viewerReady || liveRoom.collaborationLocked) return;
		segmentationShadowRef.current = createSegmentationShadow();
		const unsubscribe = subscribeToSegmentationEdits((detail) => {
			const shadow = segmentationShadowRef.current;
			if (!shadow) return;
			const ranges = diffSegmentationFromShadow(shadow, detail?.modifiedSlicesToUse);
			if (!ranges.length || liveRoom.connectionState !== "connected") return;
			const segmentLabel = detail?.segmentIndex ?? ranges.find((range) => range.after > 0)?.after ?? 0;
			const operationId = crypto.randomUUID();
			void liveRoom.sendDurable("mask.patch", {
				operation_id: operationId,
				geometry_hash: liveRoom.metadata.geometry_hash,
				resolution: liveRoom.metadata.resolution,
				segment_label: segmentLabel,
				ranges,
			}, operationId, { onRejected: () => window.location.reload() });
		});
		return unsubscribe;
	}, [
		liveRoom?.connectionState,
		liveRoom?.sendDurable,
		liveRoom?.metadata.geometry_hash,
		liveRoom?.metadata.resolution,
		liveRoom?.collaborationLocked,
		viewerReady,
	]);

	// Publish camera/navigation state at the hook's 20 Hz cap.  Following suppresses
	// outbound view echoes; applying a leader's camera therefore stays one-way.
	useEffect(() => {
		if (!liveRoom || liveRoom.metadata.mode === "quiz" || !viewerReady || !renderingEngine) return;
		const publish = () => {
			if (liveRoom.followingId) return;
			// The server replaces each participant's view frame, so publish a fresh
			// complete MPR snapshot rather than the pane that raised the camera event.
			const view = getSharedMprView();
			if (!view) return;
			liveRoom.sendView({
				view: {
					...view,
					windowWidth,
					windowCenter,
					opacity: opacityValue,
					visibleOrgans: checkState,
				},
			});
		};
		const unsubscribe = subscribeToMprViewChanges(publish);
		publish();
		return unsubscribe;
	}, [liveRoom?.followingId, liveRoom?.sendView, viewerReady, renderingEngine, windowWidth, windowCenter, opacityValue, checkState]);

	useEffect(() => {
		if (!liveRoom?.followingId || liveRoom.metadata.mode === "quiz" || !viewerReady) return;
		const leader = liveRoom.participants.find((item) => item.participant_id === liveRoom.followingId);
		if (!leader?.view) return;
		applySharedMprView(leader.view);
		if (leader.view.windowWidth != null && leader.view.windowCenter != null) {
			handleWindowChange(leader.view.windowWidth, leader.view.windowCenter);
		}
		if (leader.view.opacity != null) {
			setOpacityValue(leader.view.opacity);
			setFillOpacity(leader.view.opacity / 100);
		}
		if (leader.view.visibleOrgans) setCheckState(leader.view.visibleOrgans);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveRoom?.followingId, liveRoom?.participants, viewerReady]);

	useEffect(() => {
		if (!liveRoom) return;
		if (liveRoom.metadata.mode === "quiz") {
			liveRoom.sendPresence({ plane: focusedPane.activePaneRef.current });
			return;
		}
		liveRoom.sendPresence({
			crosshair: crosshairMm,
			active_tool: editMode ?? activeMeasureTool ?? (crosshairToolActive ? "crosshair" : "pan"),
			plane: focusedPane.activePaneRef.current,
		});
	}, [liveRoom?.sendPresence, crosshairMm, editMode, activeMeasureTool, crosshairToolActive]);

	useEffect(() => {
		if (!liveRoom || (liveRoom.connectionState === "connected" && !liveRoom.collaborationLocked)) return;
		setEditMode(null);
		setShowAnnotationToolbar(false);
		setActiveMeasureTool(null);
	}, [liveRoom?.connectionState, liveRoom?.collaborationLocked]);



	const handleFlipHorizontal = () => {
		const pane = focusedPane.getFocusedPane()
		flipPaneHorizontal(pane);
		sessionRef.current?.log("view", `Flipped ${pane} horizontally`);
	};

	const handleRotate90Clockwise = () => {
		const pane = focusedPane.getFocusedPane()
		rotatePane90Clockwise(pane);
		sessionRef.current?.log("view", `Rotated ${pane} 90° clockwise`);
	};

	// Reads cinePlaying directly rather than through setState's functional-updater form —
	// React StrictMode double-invokes that form in dev to catch impure updaters, which would
	// call startCine/stopCine twice per click (this app runs in StrictMode; see the similar
	// double-run workarounds in dicomLocal.ts).
	const toggleCine = useCallback(() => {
		if (!viewerReady) return;
		const pane = focusedPane.getFocusedPane();
		if (cinePlaying) {
			stopCine();
			setCinePlaying(false);
			sessionRef.current?.log("view", "Stopped cine playback");
			return;
		}
		const ok = startCine(pane, cineFps);
		setCinePlaying(ok);
		if (ok) {
			sessionRef.current?.log("view", `Started cine playback (${pane}, ${cineFps} fps)`);
		} else {
			console.warn(`Cine playback failed to start for pane "${pane}"`);
		}
	}, [cinePlaying, focusedPane.getFocusedPane, cineFps, viewerReady]);

	useKeyboardShortcuts({
		takeSnapshot,
		toggleCine,
		setEditMode,
		setActiveMeasureTool,
		setCrosshairToolActive,
		setShowStats,
		setShowMetadata,
		setShowAnnotationToolbar, // was setShowEditPanel
		setShowMeasurePanel,
		getFocusedPane: focusedPane.getFocusedPane,
		sliceInfoRef,
		editMode,
		setZoomLevel,
		collaborationConnected: liveRoom?.connectionState === "connected",
		collaborationLocked: liveRoom?.collaborationLocked,
		onCollaborationUndo: liveRoom?.requestUndo,
		onUndo: handleUndo,
	});
	// Live-adjust the frame rate: if a clip is already running, restart it immediately at
	// the new speed rather than waiting for the next stop/start.
	const handleCineFpsChange = (fps: number) => {
		setCineFps(fps);
		if (cinePlaying) {
			stopCine();
			startCine(focusedPane.getFocusedPane(), fps);
		}
	};

	// Changing the layout invalidates the playing pane; stop rather than guess. Also
	// stop on unmount so the interval doesn't outlive the viewports.
	useEffect(() => {
		stopCine();
		setCinePlaying(false);
	}, [viewMode]);
	useEffect(() => () => stopCine(), []);
	useEffect(() => () => {
		if (windowReadoutTimerRef.current) clearTimeout(windowReadoutTimerRef.current);
	}, []);

	// View-mode changes belong in the reading timeline (skip the initial mount).
	const loggedViewMode = useRef<ViewMode | null>(null);
	useEffect(() => {
		if (loggedViewMode.current !== null && loggedViewMode.current !== viewMode) {
			sessionRef.current?.log(
				"view",
				`Switched to ${viewMode === "mpr" ? "MPR" : viewMode === "3d" ? "3D" : viewMode} view`
			);
		}
		loggedViewMode.current = viewMode;
	}, [viewMode]);

	// ---- Progressive resolution: background full-res stream + in-place swap --------

	const runEnhance = async () => {
		if (!pantsCase || !viewerReady || enhanceStartedRef.current) return;
		enhanceStartedRef.current = true;
		setEnhance({ state: "streaming", pct: 0 });
		// The HD stream is the only download in flight, so any progress event is ours.
		const unsubscribe = subscribeToVolumeProgress((loaded, total) => {
			if (total > 0) {
				setEnhance({ state: "streaming", pct: Math.min(100, Math.round((loaded / total) * 100)) });
			}
		});
		try {
			const newVolumeId = await upgradeCtVolume(`${API_BASE}/api/get-main-nifti/${pantsCase}.nii.gz`);
			if (!viewerReadyRef.current) return;
			if (!newVolumeId) {
				setEnhance({ state: "failed", pct: null });
				return;
			}
			setVolumeId(newVolumeId);
			// setVolumes resets the transfer function and rebuilds the labelmap actors —
			// re-apply the *current* window and organ visibility (live refs, not closures).
			handleWindowChange(windowRef.current.w, windowRef.current.c);
			setVisibilities([
				true,
				...checkBoxDataRef.current.map((item) => !!checkStateRef.current[item.id]),
			]);
			// The segmentation volume must be rebuilt at full-res too, or its voxel
			// grid stays on the old low-res spacing while the CT (and displayed
			// slice) is now full-res — brush strokes then compute against mismatched
			// grids and land on the wrong slice. Annotation stays gated (see
			// hdReady in the Annotate button) until this completes, since painting
			// mid-swap would hit the same mismatch this is meant to fix.
			if (segUrl) {
				const segOk = await upgradeSegmentationVolume(`${API_BASE}/api/get-segmentations/${pantsCase}.nii.gz`);
				if (!segOk) {
					// CT upgraded but mask didn't — don't claim "done" (which the
					// Annotate button treats as a green light) while the mask is
					// still misaligned. Report failed so the button stays disabled
					// and hdReady falls back to isHd if/when the case is reloaded.
					setEnhance({ state: "failed", pct: null });
					return;
				}
			}
			setEnhance({ state: "done", pct: 100 });
			sessionRef.current?.log("session", "Enhanced to full resolution");
		} catch {
			setEnhance({ state: "failed", pct: null });
		} finally {
			unsubscribe();
		}
	};

	// Keep the initial low-resolution viewer stable. Automatically swapping in a
	// full-resolution CT moments after the scan appears can blank the rendered
	// panes on an interrupted large-file transfer. Readers can still explicitly
	// request the full-resolution stream with the HD control once the first view
	// is confirmed usable.

	// ---- Shaded 3D volume rendering (Volume mode in the 3D pane) -------------------

	useEffect(() => {
		if (!viewerReady || threeDMode !== "volume" || !renderingEngine) return;
		const element = volume3DRef.current;
		if (!element) return;
		let disposed = false;
		setVolume3DFailed(false);
		(async () => {
			const ok = await enableVolume3D(element, volumePreset).catch(() => false);
			if (!disposed && !ok) setVolume3DFailed(true);
		})();
		return () => {
			disposed = true;
			disableVolume3D();
		};
		// volumePreset intentionally omitted — preset changes are applied in place below,
		// without tearing the viewport down.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [threeDMode, viewerReady, renderingEngine]);

	useEffect(() => {
		if (threeDMode === "volume") applyVolume3DPreset(volumePreset);
	}, [volumePreset, threeDMode]);

	// Track the CT download to show an accurate ETA while the case loads. We follow the
	// largest-total stream (the CT volume, not the smaller segmentation) and derive the
	// remaining time from the average measured throughput since the download started.
	useEffect(() => {
		if (!loading) return;
		dlTotalsRef.current = {};
		setDlPct(null);
		setDlDone(false);
		const unsub = subscribeToVolumeProgress((loaded, total, volumeId) => {
			if (!total || total <= 0) return;
			dlTotalsRef.current[volumeId] = total;
			// Only track the biggest volume (CT); ignore the smaller seg progress stream.
			let biggestId = volumeId;
			let biggestTotal = 0;
			for (const [id, t] of Object.entries(dlTotalsRef.current)) {
				if (t > biggestTotal) { biggestTotal = t; biggestId = id; }
			}
			if (volumeId !== biggestId) return;
			if (loaded >= total) { setDlDone(true); setDlPct(100); return; }
			if (loaded > 0) {
				setDlPct(Math.min(100, Math.max(0, Math.round((loaded / total) * 100))));
			}
		});
		return unsub;
	}, [loading, ctUrl]);

	useEffect(() => {
		// Guards against a stale async load winning a race: if ctUrl/segUrl change
		// mid-load (e.g. HD toggle or navigation), the first renderVisualization can
		// resolve after the second and clobber state with the wrong case's result.
		let cancelled = false;
		const controller = new AbortController();
		let disposeLoaded: (() => void) | undefined;
		let loadTimedOut = false;
		let loadDeadline: number | undefined;
		viewerReadyRef.current = false;
		setViewerReady(false);
		setAcceptedViewerVolumeId(null);
		setDicomError(null);
		initialLiveMeasurementsAppliedRef.current = null;
		initialChallengeMeasurementAppliedRef.current = null;
		setLoading(true);
		enhanceStartedRef.current = false;
		setEnhance({ state: "idle", pct: null });
		setRenderingEngine(null);
		setViewportIds([]);
		setVolumeId(null);
		const acceptLoadedViewer = (result: Awaited<ReturnType<typeof renderVisualization>>) => {
			if (cancelled) {
				result.dispose();
				return false;
			}
			disposeLoaded = result.dispose;
			setRenderingEngine(result.renderingEngine);
			setViewportIds(result.viewportIds);
			setVolumeId(result.volumeId);
			setAcceptedViewerVolumeId(result.volumeId);
			viewerReadyRef.current = true;
			setViewerReady(true);
			setLoading(false);
			return true;
		};
		const startLoadDeadline = () => {
			loadDeadline = window.setTimeout(() => {
				loadTimedOut = true;
				controller.abort();
			}, VIEWER_LOAD_TIMEOUT_MS);
		};
		const clearLoadDeadline = () => {
			if (loadDeadline !== undefined) {
				window.clearTimeout(loadDeadline);
				loadDeadline = undefined;
			}
		};
		const reportLoadError = (error: unknown, fallback: string) => {
			if (cancelled) return;
			if (error instanceof DOMException && error.name === "AbortError" && !loadTimedOut) return;
			console.error(error);
			setDicomError(
				loadTimedOut
					? "This scan has not finished after five minutes. You can retry this case."
					: error instanceof Error && error.message
						? error.message
						: fallback
			);
			setLoading(false);
		};
		const setup = async () => {
			// Local DICOM/NIfTI have no server-side segmentation — don't seed the static
			// 32-organ catalog for them; checkBoxData should only ever contain segments
			// the user actually creates (via createNewAnnotationClass), so hasAnySegments
			// reflects reality instead of always being true.
			if (!isLocal) {
				const checkBoxData = segmentation_categories.map((filename, i) => ({
					label: filenameToName(filename),
					id: i + 1,
				}));
				setCheckBoxData(checkBoxData);
				const initialState = [true];
				checkBoxData.forEach((item) => {
					initialState[item.id] = !isSoloChallenge && !isQuizPractice && liveRoom?.metadata.mode !== "quiz";
				});
				setCheckState(initialState);
			} else {
				setCheckBoxData([]);
				setCheckState([true]);
			}
		
			const max = Math.max(...Object.keys(labelColorMap).map((key) => parseInt(key)));
			const cmap: ColorLUT = Array.from({ length: max + 1 }, () => [0, 0, 0, 0]);
			for (const key in labelColorMap) {
				cmap[parseInt(key)] = labelColorMap[parseInt(key)];
			}
		
			// Local DICOM: build imageIds from the picked files instead of NIfTI URLs.
			// No segmentation layer exists for these scans.
			if (isDicom) {
				if (!axial_ref.current || !sagittal_ref.current || !coronal_ref.current) return;
				const files = getLocalDicomFiles();
				if (!files.length) {
					// Deep link or reload without files in memory — go pick a folder.
					window.location.href = "/upload";
					return;
				}
				try {
					const { imageIds } = await loadLocalDicomSeries(files);
					if (cancelled) return;
					const result = await renderVisualization(
						axial_ref.current,
						sagittal_ref.current,
						coronal_ref.current,
						cmap,
						"",
						undefined,
						setLoading,
						{ ctImageIds: imageIds, resourceKey: "local-dicom", signal: controller.signal }
					);
					if (cancelled) return void result.dispose();
					// Non-CT DICOM (MR/PET/…) needs its own window, not the CT presets —
					// seed the sliders from the scan's VOI so the initial-window effect
					// applies the right level instead of clipping the image flat.
					if (result.initialVoi) {
						setWindowWidth(result.initialVoi.windowWidth);
						setWindowCenter(result.initialVoi.windowCenter);
						setActivePreset("");
					}
					// Same idea for the 3D pane: CT transfer functions render MR as an
					// opaque slab, so switch the preset set to Cornerstone's MR presets.
					if (getCurrentVolumeModality() === "MR") {
						setVolume3DPresets(VOLUME_3D_PRESETS_MR);
						setVolumePreset(VOLUME_3D_PRESETS_MR[0].name);
					}
					acceptLoadedViewer(result);
				} catch (e) {
					if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
					console.error(e);
					setDicomError(e instanceof Error ? e.message : "Failed to load the DICOM series.");
					setLoading(false);
				}
				return;
			}

			// Local NIfTI: load the picked .nii/.nii.gz (decompressed to a blob URL) through
			// the normal Cornerstone volume path with no segmentation layer. This gives the
			// full viewer — 3D volume pane and annotation tools — same as a local DICOM.
			if (isLocalNifti) {
				if (!axial_ref.current || !sagittal_ref.current || !coronal_ref.current) return;
				const rawUrl = await loadLocalNiftiAsRawBlobUrl();
				// StrictMode double-invokes this effect in dev: if this run was already
				// cleaned up, bail BEFORE renderVisualization — otherwise this (stale) run
				// would destroy the live run's rendering engine mid-load ("this.destroy()
				// has been called"). renderVisualization shares one global engine.
				if (cancelled) return;
				if (!rawUrl) {
					// Deep link or reload without a file in memory — go pick one.
					window.location.href = "/upload";
					return;
				}
				try {
					const result = await renderVisualization(
						axial_ref.current,
						sagittal_ref.current,
						coronal_ref.current,
						cmap,
						rawUrl,
						undefined,
						setLoading,
						{ resourceKey: "local-nifti", signal: controller.signal }
					);
					acceptLoadedViewer(result);
				} catch (e) {
					if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
					console.error(e);
					setDicomError(e instanceof Error ? e.message : "Failed to load the NIfTI file.");
					setLoading(false);
				}
				return;
			}

			if (
				!ctUrl ||
				// Solo quiz modes are CT-only until submission unlocks their reveal masks.
				// Requiring that hidden mask here leaves the viewer loading forever.
				(!segUrl && !isCvCase && !isQuizPractice && !isSoloChallenge) ||
				!axial_ref.current ||
				!sagittal_ref.current ||
				!coronal_ref.current ||
				// !render_ref.current ||
				cmap.length === 0
			) {
				return;
			}

			try {
				const loadDeadlineAt = Date.now() + VIEWER_LOAD_TIMEOUT_MS;
				startLoadDeadline();
				let attempt = 0;
				while (!cancelled) {
					try {
						const result = await awaitViewerLoadOrAbort(
							renderVisualization(
								axial_ref.current,
								sagittal_ref.current,
								coronal_ref.current,
								cmap,
								ctUrl,
								segUrl ?? undefined,
								setLoading,
								{ resourceKey: ctUrl, signal: controller.signal }
							),
							controller.signal,
							(result) => result.dispose()
						);

						clearLoadDeadline();
						acceptLoadedViewer(result);
						break;
					} catch (e) {
						const remainingMs = loadDeadlineAt - Date.now();
						if (
							controller.signal.aborted ||
							!isRetryableViewerLoadError(e) ||
							remainingMs <= 0
						) {
							clearLoadDeadline();
							reportLoadError(e, "Failed to load the viewer.");
							break;
						}

						const retryDelay = Math.min(
							VIEWER_RETRY_MAX_DELAY_MS,
							VIEWER_RETRY_BASE_DELAY_MS * 2 ** attempt,
							remainingMs
						);
						attempt += 1;
						try {
							await waitForViewerRetry(retryDelay, controller.signal);
						} catch (retryError) {
							clearLoadDeadline();
							reportLoadError(retryError, "Failed to load the viewer.");
							break;
						}
					}
				}
			} catch (e) {
				clearLoadDeadline();
				reportLoadError(e, "Failed to load the viewer.");
			}

			// const { nv, cmapCopy } = await create3DVolume(
			// 	render_ref,
			// 	segUrl,
			// 	labelColorMap,
			// 	(mm) => moveCornerstoneCrosshairToMm(mm as [number, number, number])
			// );
			// cmapRef.current = cmapCopy;
			// setNV(nv);

			// // Cornerstone → NiiVue: when crosshair moves in any 2D view, sync to 3D
			// subscribeToCrosshairChanges((mm) => {
			// 	moveNiiVueCrosshairToMm(nv, mm);
			// });
		};

		setup();

		return () => {
			cancelled = true;
			clearLoadDeadline();
			viewerReadyRef.current = false;
			controller.abort();
			disposeLoaded?.();
		};
		// refs have stable identity, so they aren't real deps; the loads key off
		// ctUrl/segUrl/labelColorMap.
	}, [
		ctUrl,
		segUrl,
		isDicom,
		isLocalNifti,
		isSoloChallenge,
		liveRoom?.metadata.mode,
		axial_ref,
		sagittal_ref,
		coronal_ref,
		// labelColorMap intentionally excluded — creating a new class updates
		// this map and would otherwise retrigger the CT/volume setup effect.
	]);
	// Toggle checkbox state
	//   useEffect(() => {
	//   const fetchColorMap = async () => {
	//     try {
	//       // const cached = sessionStorage.getItem(cacheKey);
	//       // if (cached) {
	//       //   setLabelColorMap(JSON.parse(cached));
	//       //   return;
	//       // }
	//       setProgress(0.15)
	//       const response = await fetch(`${APP_CONSTANTS.API_ORIGIN}/api/get-label-colormap/${pantsCase}`);
	//       const lut = await response.json();
	//       const parsedMap: {[key: number]: Color}= {};
	//       for (const labelId in lut) {
	//         const color = lut[labelId];
	//         if (color && color.R !== undefined) {
	//           const arr: Color = [color.R, color.G, color.B, color.A ?? 255];
	//           parsedMap[Number(labelId)] = arr;
	//         }
	//       }
	//       setLabelColorMap(parsedMap);

	//       setProgress(0.7)
	//     } catch (err) {
	//       console.warn("❗ Failed to fetch colormap:", err);
	//     }
	//   };

	//   fetchColorMap();
	// }, [pantsCase]);

	// Update VOI (window/level) settings
	const handleWindowChange = (
		newWidth: number | null,
		newCenter: number | null
	) => {
		const _width = Math.max(newWidth ?? windowWidth, 1);
		const _center = newCenter ?? windowCenter;

		setWindowWidth(_width);
		setWindowCenter(_center);
		// Coalesced: a slider drag logs as one final "W/L" line, not dozens.
		sessionRef.current?.log("window", `Window/level set to W ${_width} / L ${_center}`, 1200);

		if (!renderingEngine || !viewportIds.length || !volumeId) return;

		const windowLow = _center - _width / 2;
		const windowHigh = _center + _width / 2;

		viewportIds.forEach((viewportId) => {
			const viewport = renderingEngine.getViewport(viewportId);
			// Labelmap representations can become the viewport's default actor after
			// quiz reveal. Windowing that actor paints its zero-valued background gray
			// and hides the CT, so always target the known CT volume actor instead.
			const actor = viewport.getActors().find((entry) => entry.referencedId === volumeId)
				?? viewport.getDefaultActor();
			if (!actor) return;

			const tf = (actor.actor.getProperty() as vtkVolumeProperty).getRGBTransferFunction(0);
			tf.setMappingRange(windowLow, windowHigh);
			tf.updateRange();
			viewport.render();
		});
	};

	// Apply window settings once the engine/viewports/volume are ready. Intentionally not
	// keyed on windowWidth/Center/handleWindowChange — the slider already applies live
	// changes; this just seeds the initial window after load.
	useEffect(() => {
		if (renderingEngine && viewportIds.length && volumeId) {
			handleWindowChange(windowWidth, windowCenter);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [renderingEngine, viewportIds, volumeId]);

	// Track each pane's current/total slice for the "245/519" caption + drag scrollbar.
	// Re-subscribes on every volume (re)load, since a fresh render tears down the old
	// viewport elements the previous subscription's listeners were attached to.
	useEffect(() => {
		if (!renderingEngine || !viewportIds.length || !volumeId) return;
		const unsubscribe = subscribeToSliceChanges((pane, info) => {
			setSliceInfo((prev) => (prev[pane]?.current === info.current && prev[pane]?.total === info.total
				? prev
				: { ...prev, [pane]: info }));
		});
		return unsubscribe;
	}, [renderingEngine, viewportIds, volumeId]);

	// A pin popover belongs to its visible slice. Close it as soon as navigation
	// leaves that note's plane tolerance so returning later never resurrects stale UI.
	useEffect(() => {
		if (!openPinnedNote || !liveRoom) return;
		const note = liveRoom.state.notes[openPinnedNote.noteId];
		if (
			!note
			|| note.plane !== openPinnedNote.pane
			|| !worldToVisiblePaneCanvas(openPinnedNote.pane, note.world)
		) {
			setOpenPinnedNote(null);
		}
	}, [liveRoom?.state.notes, openPinnedNote, sliceInfo]);

	// Apply the reference-lines toggle once the engine/viewports/volume are ready, and
	// re-apply on both a user toggle and a volume reload (a fresh tool group always starts
	// with every tool disabled).
	useEffect(() => {
		if (renderingEngine && viewportIds.length && volumeId) {
			setReferenceLinesEnabled(referenceLinesOn, focusedPane.activePaneRef.current);
		}
	}, [referenceLinesOn, renderingEngine, viewportIds, volumeId]);

	// Apply a shared deep-link's view state once the volume is ready (orientation, window,
	// opacity, hidden organs, crosshair). Runs a single time — after that the URL is just a
	// snapshot and the user is free to change things.
	useEffect(() => {
		if (shareStateAppliedRef.current || !viewerReady) return;
		if (!renderingEngine || !viewportIds.length || !volumeId) return;
		shareStateAppliedRef.current = true;

		const shared = decodeViewerState(new URLSearchParams(window.location.search));
		if (shared.view) setViewMode(shared.view);
		if (shared.ww != null && shared.wc != null) handleWindowChange(shared.ww, shared.wc);
		if (shared.opacity != null) {
			setOpacityValue(shared.opacity);
			setFillOpacity(shared.opacity / 100);
		}
		if (shared.hidden?.length) {
			// The checkState effect below applies the visibility change (Cornerstone + NiiVue).
			setCheckState((prev) => {
				const next = [...prev];
				for (const id of shared.hidden!) if (id < next.length) next[id] = false;
				return next;
			});
		}
		// Move the crosshair last, after a paint, so the viewports are laid out and the
		// reference lines land on the intended focal point.
		if (shared.crosshair) {
			requestAnimationFrame(() => moveCornerstoneCrosshairToMm(shared.crosshair!));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewerReady, renderingEngine, viewportIds, volumeId]);

	// Build a shareable URL that reproduces the current view, and copy it to the clipboard.
	const handleShare = async () => {
		const hidden = checkState.reduce<number[]>((acc, visible, id) => {
			if (id > 0 && !visible) acc.push(id);
			return acc;
		}, []);
		const params = encodeViewerState({
			view: viewMode,
			ww: windowWidth,
			wc: windowCenter,
			opacity: opacityValue,
			hidden,
			crosshair: getCrosshairMm() ?? undefined,
			hd: isHd,
		});
		const qs = params.toString();
		const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ""}`;
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			// Clipboard blocked (e.g. insecure context) — fall back to a prompt so the link
			// is still copyable by hand.
			window.prompt("Copy this link to share the current view:", url);
		}
		setShareCopied(true);
		window.setTimeout(() => setShareCopied(false), 1600);
	};

	// The Measure button shows the active tool's icon (including magnify, now folded into
	// the same flyout/state), or the ruler when nothing is active.
	const measureToolActive = activeMeasureTool !== null;
	const ActiveMeasureIcon = MEASURE_TOOLS.find((t) => t.name === activeMeasureTool)?.Icon ?? IconRuler2;

	// Group-level "something inside is active" flags, so each collapsed toolbar dropdown
	// still visually reflects its contents' state without having to be open.
	const viewGroupActive = hoverIdentifyEnabled || referenceLinesOn;
	const panelsGroupActive = showOrganDetails || showStats || showMetadata || showMeasurePanel;
	const collaborationDisabled = !viewerReady || Boolean(liveRoom && (
		liveRoom.connectionState !== "connected" || liveRoom.collaborationLocked
	));

	// The Layout ▾ trigger shows the pane-layout preset's name when one is active
	// (it's the more specific choice), otherwise the current view mode.
	const layoutTriggerLabel =
		viewMode === "mpr" && layoutPreset !== "grid"
			? LAYOUT_PRESETS.find((p) => p.id === layoutPreset)?.label ?? VIEW_MODE_SHORT_LABEL.mpr
			: VIEW_MODE_SHORT_LABEL[viewMode];

	// Center on an organ (from the sidebar): move both the 2D MPR crosshair and the 3D
	// (NiiVue) crosshair — the Cornerstone move suppresses its change event, so the 3D
	// view has to be synced explicitly — and make sure the organ is visible there.
	const handleJumpToOrgan = (label: number) => {
		const centroid = getOrganCentroids()?.[label];
		if (!centroid) return; // organ not present in this scan
		moveCornerstoneCrosshairToMm(centroid);
		setCrosshairMm(centroid);
		sessionRef.current?.log(
			"organ",
			`Jumped to ${checkBoxData.find((o) => o.id === label)?.label ?? `organ ${label}`}`
		);
		// if (NV) moveNiiVueCrosshairToMm(NV, centroid);
		setCheckState((prev) => {
			if (prev[label]) return prev;
			const next = [...prev];
			next[label] = true;
			return next;
		});
	};

	const handleOrganHighlight = useCallback((organName: string, centroidMm?: [number, number, number]) => {
		if (centroidMm) {
			moveCornerstoneCrosshairToMm(centroidMm);
			setCrosshairMm(centroidMm);
		}
		const idx = segmentation_categories.findIndex(
			(cat) => cat === organName || cat.startsWith(organName)
		);
		if (idx === -1) return;
		const labelId = idx + 1;
		setCheckState((prev) => {
			if (!preIsolateCheckStateRef.current) {
				preIsolateCheckStateRef.current = prev;
			}
			const next = prev.map(() => false);
			next[0] = true;
			next[labelId] = true;
			return next;
		});
	}, []);

	const handleClearIsolation = useCallback(() => {
		if (preIsolateCheckStateRef.current) {
			setCheckState(preIsolateCheckStateRef.current);
			preIsolateCheckStateRef.current = null;
		}
	}, []);

	const handleHideOrgans = useCallback((organNames: string[]) => {
		setCheckState(prev => {
			if (!preIsolateCheckStateRef.current) {
				preIsolateCheckStateRef.current = [...prev];
			}
			const next = [...prev];
			organNames.forEach(name => {
				const idx = segmentation_categories.findIndex(
					cat => cat === name || cat.startsWith(name)
				);
				if (idx >= 0) next[idx + 1] = false;
			});
			return next;
		});
	}, []);



	// Resize Cornerstone + NiiVue when view mode changes. resize(immediate, keepCamera):
	// keepCamera defaults to true, which preserved the zoom/pan from a single (fullscreen)
	// view when returning to MPR — leaving the image zoomed/offset. Pass false and reset
	// each camera so every viewport cleanly re-fits its new size.
	useEffect(() => {
		// Run after the grid/layout change has been applied AND painted (double rAF), so
		// resize() measures the final element sizes — a fixed timeout could fire too early
		// and bake in a wrong canvas size (panes ending up smaller than their cells).
		let raf1 = 0;
		let raf2 = 0;
		const apply = () => {
			if (renderingEngine) {
				renderingEngine.resize(true, false);
				viewportIds.forEach((id) => {
					const vp = renderingEngine.getViewport(id) as { resetCamera?: () => void };
					vp?.resetCamera?.();
				});
				renderingEngine.render();
			}
			if (NV) NV.resizeListener();
		};
		raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(apply);
		});
		return () => {
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
		};
	}, [viewMode, layoutPreset, showAISidebar, renderingEngine, NV, viewportIds]);

	// Apply zoom to the Cornerstone viewports whenever the toolbar slider changes.
	// (Previously ZoomHandle owned this side effect; the slider now lives in the toolbar.)
	useEffect(() => {
		if (!renderingEngine || !viewportIds.length) return;
		setZoom(zoomLevel);
	}, [zoomLevel, renderingEngine, viewportIds]);

	// Keep the WebGL viewports fitted to the stage as it resizes — when the toolbar is
	// shown/hidden (stage grows/shrinks), the toolbar wraps, or the window resizes.
	// keepCamera=true preserves the user's zoom/pan (unlike the view-mode switch above,
	// which deliberately re-fits each pane).
	useEffect(() => {
		const el = stageRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			renderingEngine?.resize(true, true);
			NV?.resizeListener();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [renderingEngine, NV]);

	const handlePresetClick = (preset: typeof CT_PRESETS[number]) => {
		setActivePreset(preset.name);
		handleWindowChange(preset.width, preset.center);
		showWindowReadoutBriefly();
		sessionRef.current?.log("preset", `Applied ${preset.name} window`);
	};

	// Shows the W/L readout and (re)starts its fade-out timer. Called only from actual
	// user interaction (brightness/contrast sliders, presets) — not from the initial-load
	// or deep-link window apply, which shouldn't pop the readout unprompted.
	const showWindowReadoutBriefly = () => {
		setWindowReadoutVisible(true);
		if (windowReadoutTimerRef.current) clearTimeout(windowReadoutTimerRef.current);
		windowReadoutTimerRef.current = setTimeout(() => setWindowReadoutVisible(false), 2000);
	};

	const panelStyle = (panel: "axial" | "sagittal" | "coronal" | "3d"): React.CSSProperties => {
		if (viewMode === "mpr") return {};
		// 3D: overlay the render pane fullscreen but LEAVE the Cornerstone panes untouched
		// in their grid cells. The render pane is the *last* grid item, so pulling it out of
		// flow doesn't reflow the other three — their viewports stay valid, so switching back
		// to MPR is instant (no resize/re-fit of the 2D views, no animation, correct sizes).
		if (viewMode === "3d") {
			if (panel === "3d") return { position: "absolute", inset: 0, zIndex: 20 };
			// Keep the pane mounted at its normal grid size (no display:none — that's
			// what preserves the "instant, no resize" swap back to MPR described above),
			// but strip it from paint and hit-testing entirely. Previously this branch
			// left these panes fully visible/interactive and relied on the 3D pane's
			// z-index to visually cover them — but the slice scrollbar/counter overlays
			// (rendered by renderPaneOverlays, see below) carry their own z-index for
			// sitting above the Cornerstone canvas, which could equal or exceed the 3D
			// pane's z-index:20 and bleed through on top of it.
			return { visibility: "hidden", pointerEvents: "none" };
		}
		// 2D single view: collapse the grid to one cell and hide the rest.
		return viewMode === panel ? {} : { display: "none" };
	};

	// Grid placement for the asymmetric layout presets (see LAYOUT_PRESETS): the primary
	// pane spans a wide first column across all 3 rows, the other three stack down a
	// narrow second column in a fixed order. No-op outside "mpr" — the other view modes
	// already give a single pane the whole stage via panelStyle above — and for the
	// default "grid" preset, which just falls back to the plain 2×2 CSS grid.
	const paneGridStyle = (panel: ViewMode): React.CSSProperties => {
		if (viewMode !== "mpr" || layoutPreset === "grid") return {};
		const primary = LAYOUT_PRESET_PRIMARY[layoutPreset];
		if (panel === primary) return { gridColumn: "1", gridRow: "1 / span 3" };
		const secondaries = LAYOUT_PANE_ORDER.filter((p) => p !== primary);
		return { gridColumn: "2", gridRow: `${secondaries.indexOf(panel) + 1}` };
	};

	// Overlay UI for one MPR pane: the slice drag-scrollbar + "245/519" caption (bottom
	// right, only once slice info has arrived for that pane), and the W/L readout (bottom
	// left, only while showWindowReadoutBriefly's fade timer hasn't expired). Rendered as
	// siblings of the Cornerstone-owned pane div, inside the shared .vp-pane-wrap — never
	// as children of that div itself, since Cornerstone manages its children imperatively
	// and mixing React-rendered children into the same node risks the two fighting over
	// the same DOM nodes.
	const renderPaneOverlays = (pane: CinePane) => {
		// Never show 2D slice-counter/W-L overlays while the 3D pane is fullscreen —
		// these are the elements that were bleeding through on top of the 3D render.
		if (viewMode === "3d") return null;
		const info = sliceInfo[pane];
		const paneElement = pane === "axial"
			? axial_ref.current
			: pane === "sagittal"
				? sagittal_ref.current
				: coronal_ref.current;
		const pinnedNotes = liveRoom
			? Object.values(liveRoom.state.notes).flatMap((note) => {
				if (note.plane !== pane) return [];
				const position = worldToVisiblePaneCanvas(pane, note.world);
				if (!position || position[0] < 0 || position[1] < 0) return [];
				return [{
					note,
					position,
					opensLeft: Boolean(paneElement && position[0] > paneElement.clientWidth * 0.62),
					opensAbove: Boolean(paneElement && position[1] > paneElement.clientHeight * 0.62),
				}];
			})
			: [];
		const challengeMarkerPosition = soloChallenge?.marker
			? worldToVisiblePaneCanvas(pane, soloChallenge.marker)
			: null;
		return (
			<>
				{challengeMarkerPosition && challengeMarkerPosition[0] >= 0 && challengeMarkerPosition[1] >= 0 && (
					<span
						className="edu-finding-marker"
						style={{ left: challengeMarkerPosition[0], top: challengeMarkerPosition[1] }}
						aria-label="Locked finding marker"
					/>
				)}
				{pinnedNotes.map(({ note, position, opensLeft, opensAbove }) => {
					const popoverId = `lr-note-popover-${pane}-${note.id}`;
					const isOpen = openPinnedNote?.noteId === note.id && openPinnedNote.pane === pane;
					return (
					<div
						className="lr-note-anchor"
						key={note.id}
						style={{ left: position[0], top: position[1] }}
						data-horizontal={opensLeft ? "left" : "right"}
						data-vertical={opensAbove ? "above" : "below"}
						onKeyDown={(event) => {
							if (event.key === "Escape") setOpenPinnedNote(null);
						}}
					>
						<button
							className="lr-note-pin"
							title={`${note.author}: ${note.text}`}
							aria-label={`Pinned note from ${note.author}: ${note.text}`}
							aria-expanded={isOpen}
							aria-controls={popoverId}
							onClick={(event) => {
								event.stopPropagation();
								setOpenPinnedNote(isOpen ? null : { noteId: note.id, pane });
							}}
						>
							<span />
						</button>
						{isOpen && (
							<div
								className="lr-note-popover"
								id={popoverId}
								role="dialog"
								aria-labelledby={`${popoverId}-author`}
								aria-describedby={`${popoverId}-text`}
								onClick={(event) => event.stopPropagation()}
							>
								<header>
									<div>
										<span>PINNED NOTE</span>
										<strong id={`${popoverId}-author`}>{note.author}</strong>
									</div>
									<button type="button" aria-label="Close pinned note" onClick={() => setOpenPinnedNote(null)}><IconX size={15} /></button>
								</header>
								<p id={`${popoverId}-text`}>{note.text}</p>
								<footer>
									<span>{note.organ_label || pane}</span>
									<span>{note.world.map((value) => Math.round(value)).join(", ")} mm</span>
								</footer>
							</div>
						)}
					</div>
					);
				})}
				{liveRoom?.participants
					.filter((participant) => participant.participant_id !== liveRoom.participantId && participant.cursor?.pane === pane)
					.map((participant) => (
						<div
							className="lr-remote-cursor"
							key={participant.participant_id}
							style={{
								left: `${Math.max(0, Math.min(1, participant.cursor!.x)) * 100}%`,
								top: `${Math.max(0, Math.min(1, participant.cursor!.y)) * 100}%`,
								color: participant.color,
							}}
						>
							<span>{participant.name}</span>
						</div>
					))}
				{info && info.total > 1 && (
					<>
						<input
							type="range"
							className="vp-slice-scrollbar"
							min={0}
							max={info.total - 1}
							step={1}
							value={info.current}
							onChange={(e) => setPaneSliceIndex(pane, Number(e.target.value))}
							aria-label={`${pane} slice`}
						/>
						<SliceJumpInput ref={sliceJumpWrapRef} pane={pane} info={info} />
					</>
				)}
				<div className={`vp-window-readout${windowReadoutVisible ? " vp-window-readout--visible" : ""}`}>
					W {Math.round(windowWidth)} · L {Math.round(windowCenter)}
				</div>
				{activeToolbarTool === "boxSegment" && boxSegment.pane === pane && boxSegment.liveBox && (() => {
					const [start, end] = boxSegment.liveBox;
					const left = Math.min(start[0], end[0]);
					const top = Math.min(start[1], end[1]);
					const width = Math.abs(end[0] - start[0]);
					const height = Math.abs(end[1] - start[1]);
					return (
						<div
							style={{
								position: "absolute",
								left, top, width, height,
								border: "1.5px dashed #6fd3ff",
								background: "rgba(111, 211, 255, 0.12)",
								pointerEvents: "none",
								zIndex: 40,
							}}
						/>
					);
				})()}
			</>
		);
	};

	// Update segmentation visibility when state changes
	useEffect(() => {
		if (viewerReady && checkState) {
			const checkStateArr = [
				true, // ID=0 background 永远可见
				...checkBoxData.map((item) => !!checkState[item.id]),
			];
			// const visible = checkStateArr.map((item, idx) => item === true ? idx - 1 : null).filter((item) => item !== null);
			// if (visible.length !== checkBoxData.length+1 && visible.length !== 1) {
			// 	visible.splice(0, 1);
			// 	console.log(visible.map((item) => segmentation_categories[item]));
			// 	create3DVolumeFew(render_ref, labelColorMap, getPanTSId(pantsCase ?? "1"), visible);
			// }
			// else {
			// updateVisibilities(NV, checkStateArr, sessionKey, cmapRef.current);
			// }
			setVisibilities(checkStateArr);
		}
	}, [
		checkState,
		checkBoxData,
		viewerReady,
	]);

	const handleOpacityOnSliderChange = (
		event: React.ChangeEvent<HTMLInputElement>
	) => {
		const value = Number(event.target.value);
		setOpacityValue(value);
		setFillOpacity(value / 100);
		sessionRef.current?.log("opacity", `Fill opacity set to ${value}%`, 1200);
	};

	const handleOutlineOpacityChange = (
		event: React.ChangeEvent<HTMLInputElement>
	) => {
		const value = Number(event.target.value);
		setOutlineOpacityValue(value);
		setOutlineOpacity(value / 100);
		sessionRef.current?.log("opacity", `Border opacity set to ${value}%`, 1200);
	};


	// Per-organ volume (cm³) + mean HU — the existing quantitative layer the backend
	// already computes for the PDF report, surfaced inline. Fetched once, on first open.
	const loadOrganStats = async () => {
		if (organStats || statsLoading) return;
		setStatsLoading(true);
		setStatsError(false);
		try {
			const fd = new FormData();
			fd.append("sessionKey", String(caseId));
			const res = await fetch(`${API_BASE}/api/mask-data`, { method: "POST", body: fd });
			const data = await res.json();
			// The endpoint returns its errors with HTTP 200 + an `error` field, so check both.
			if (!res.ok || data.error) {
				throw new Error(data.error || `HTTP ${res.status}`);
			}
			setOrganStats((data.organ_metrics ?? []) as OrganStat[]);
		} catch (e) {
			console.error(e);
			setStatsError(true);
		} finally {
			setStatsLoading(false);
		}
	};

	// Load the population norms (static asset) + this case's full metadata row (sex/age
	// for the percentile panel, plus the rest for the case-metadata panel). Both fail
	// soft: no norms or no metadata row simply means those panels omit that data.
	// demographicsTriedRef (not "!demographics", which a case with no matching row would
	// never satisfy) guards the fetch so a missing row is only looked up once, not on
	// every panel open.
	const loadPercentileContext = async () => {
		if (!normsTried.current) {
			normsTried.current = true;
			const norms = await loadOrganNorms();
			if (norms) setOrganNorms(norms);
		}
		// Only dataset cases carry metadata; reuse the existing search endpoint (exact
		// case-id match) rather than adding a per-case metadata route.
		if (!demographicsTriedRef.current && pantsCase) {
			demographicsTriedRef.current = true;
			try {
				const res = await fetch(
					`${API_BASE}/api/search?caseid=${encodeURIComponent(pantsCase)}&per_page=1`
				);
				const data = await res.json();
				const item = Array.isArray(data.items) ? data.items[0] : null;
				if (item) {
					// Number(null) is 0, which would wrongly bucket a missing age as "0-9" —
					// so treat null/undefined/"" as unknown (null) explicitly.
					const ageRaw = item.age;
					const ageNum =
						ageRaw === null || ageRaw === undefined || ageRaw === ""
							? NaN
							: Number(ageRaw);
					setDemographics({
						sex: item.sex ?? null,
						age: Number.isFinite(ageNum) ? ageNum : null,
					});
					setCaseMetadata(item);
				}
			} catch {
				/* percentile/metadata panels just fall back to their "not available" state */
			}
		}
	};

	// Watches the HD upgrade kicked off by the Annotate button (see
	// handleAnnotateClick below). Once it resolves, either open the
	// annotation toolbar/SegmentsPopup (success — this is the moment the
	// loading overlay disappears and both pop in together) or just clear
	// the loading flag (failure — the button goes back to its normal
	// resting state so the person can try again).
	useEffect(() => {
		if (!annotateHdLoading) return;
		if (enhance.state === "done") {
			setAnnotateHdLoading(false);
			setShowAnnotationToolbar(true);
		} else if (enhance.state === "failed") {
			setAnnotateHdLoading(false);
		}
	}, [enhance.state, annotateHdLoading]);

	// The Annotate button is never disabled for "HD not loaded yet" —
	// clicking it always does something. If HD is already ready, it just
	// toggles the ribbon like any other toolbar button. If not, it
	// immediately kicks off the HD upgrade (reusing an in-flight one
	// rather than starting a second) and shows the full-screen loading
	// overlay; the toolbar/SegmentsPopup only appear once that finishes
	// (see the effect above), since painting before the full-res
	// segmentation volume exists would edit a mask on the wrong grid.
	const handleAnnotateClick = () => {
		if (collaborationDisabled) return;
		const hdReadyNow = isHd || enhance.state === "done";
		if (hdReadyNow) {
			handleToggleAnnotationToolbar();
			return;
		}
		setAnnotateHdLoading(true);
		if (enhance.state === "idle") void runEnhance();
	};

	const handleToggleAnnotationToolbar = () => {
		const opening = !showAnnotationToolbar;
		setShowAnnotationToolbar(opening);
		if (!opening) {
			// Closing (deselecting the Annotate button): drop whatever class
			// was targeted — the isolation effect above reacts to
			// activeCatalogOrganId/activeSegment both going null by putting
			// every segmentation mask back to visible — and back out of
			// whatever tool/edit mode was active, so the toolbar and popup
			// (both driven by the same `open`/`showAnnotationToolbar` prop)
			// close together instead of the target/tool state lingering
			// invisibly after the UI has visually gone away.
			setActiveCatalogOrganId(null);
			setActiveSegmentState(null);
			setEditMode(null);
			setActiveToolbarTool(null);
		}
	};

	// Every OTHER main-toolbar icon (crosshair, measure, view, cine, layout,
	// window preset, adjust, download, HD) needs to close the annotation
	// toolbar/SegmentsPopup the same way pressing Annotate again does —
	// previously only the Annotate button itself (and a couple of the
	// right-side panel togglers like Stats/Metadata/Measurements) ran this
	// teardown, so clicking e.g. Crosshair or Measure while annotating left
	// the horizontal toolbar and the class popup visibly open even though
	// navigation/measurement mode had taken over underneath them. Mirrors
	// the closing branch of handleToggleAnnotationToolbar exactly, just
	// gated on "was it open" instead of always toggling.
	const closeAnnotationToolbarIfOpen = () => {
		if (!showAnnotationToolbar) return;
		setShowAnnotationToolbar(false);
		setActiveCatalogOrganId(null);
		setActiveSegmentState(null);
		setEditMode(null);
		setActiveToolbarTool(null);
	};

	const handleToggleStats = () => {
		// The right-side slot is shared by stats / metadata / measurements / mask editing.
		setShowMetadata(false);
		setShowMeasurePanel(false);
		setShowAnnotationToolbar(false);
		setEditMode(null);
		setActiveToolbarTool(null);
		setShowStats((v) => !v);
		loadOrganStats();
		loadPercentileContext();
	};

	const handleToggleMetadata = () => {
		setShowStats(false);
		setShowMeasurePanel(false);
		setShowAnnotationToolbar(false);
		setEditMode(null);
		setActiveToolbarTool(null);
		setShowMetadata((v) => !v);
		loadPercentileContext();
	};

	const handleToggleAISidebar = () => {
		if (liveRoom?.metadata.mode === "quiz") return;
		const opening = !showAISidebar;

		if (opening) track("assistant_open");
		setShowAISidebar(opening);

		if (opening) {
			setShowStats(false);
			setShowMetadata(false);
			setShowMeasurePanel(false);
			setShowAnnotationToolbar(false);
			setEditMode(null);
			setActiveToolbarTool(null);
			void loadOrganStats();
			void loadPercentileContext();
		}
};
// Trigger typecheck using the latest AI assistant files.
const aiActions = useMemo(() => buildViewerActions({
	checkBoxData,
	setCheckState,
	setOpacityValue,
	handleWindowChange,
	setViewModeFn: setViewMode,
	setActiveMeasureToolFn: setActiveMeasureTool,
	caseId: String(caseId),
	apiBase: API_BASE,
}), [checkBoxData, caseId, handleWindowChange]);

const statRows = useMemo(
() =>
organStats
? computeStatRows(
organStats,
organNorms,
demographics?.sex ?? null,
demographics?.age ?? null
)
: [],
[organStats, organNorms, demographics]
);
const flaggedOrgans = useMemo(() => summarizeOutOfRange(statRows), [statRows]);
const customOrgans = useMemo(
    () => checkBoxData.filter((o) => o.id > segmentation_categories.length),
    [checkBoxData]
);


const organCatalog = useMemo(() => {
	if (!hasSegmentationVolume()) {
		// Segmentation not cached yet — show the full static list rather than
		// spamming isSegmentPresent before there's anything to check.
		return segmentation_categories.map((filename, i) => ({ id: i + 1, label: filenameToName(filename) }));
	}

	const withPresence = segmentation_categories
		.map((filename, i) => ({ id: i + 1, label: filenameToName(filename) }))
		.filter((o) => isSegmentPresent(o.id));

	if (withPresence.length === 0) {
		return segmentation_categories.map((filename, i) => ({ id: i + 1, label: filenameToName(filename) }));
	}
	return withPresence;
}, [renderingEngine, viewportIds, volumeId, checkBoxData, loading]);

// Logical Operators' "With segment" dropdown should only offer organs that
// actually exist in this scan (same presence check organCatalog already
// does), plus any custom classes the user created themselves (those are
// real by definition — no presence check needed). checkBoxData on its own
// is the raw 32-organ catalog seeded at load, not filtered by presence.
const logicalOpSegments = useMemo(() => {
	const presentIds = new Set(organCatalog.map((o) => o.id));
	return checkBoxData.filter((s) => s.id > segmentation_categories.length || presentIds.has(s.id));
}, [checkBoxData, organCatalog]);

const [logicalOp, setLogicalOp] = useState<LogicalOperation>("copy");
const [logicalOpSourceId, setLogicalOpSourceId] = useState<number | null>(null);
const [logicalOpBypassMasking, setLogicalOpBypassMasking] = useState(true);
const aiAvailableOrgans = useMemo(() => {
	const measuredOrgans = (organStats ?? [])
		.filter((metric) =>
			typeof metric.volume_cm3 === "number" &&
			Number.isFinite(metric.volume_cm3) &&
			metric.volume_cm3 > 0 &&
			metric.volume_cm3 !== 999999
		)
		.map((metric) => metric.organ_name);

	return measuredOrgans.length > 0
		? measuredOrgans
		: checkBoxData.map((organ) => organ.label);
}, [organStats, checkBoxData]);

	// hex "#rrggbb" convert to Cornerstone's [r,g,b,a] Color (0 to 255)
	const hexToColor = (hex: string): Color => {
		const n = parseInt(hex.slice(1), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; // Isolate red, blue, green, all values
	};

	// [r,g,b,a] Color back to "#rrggbb" hex — needed when a segment gets a
	// color assigned on the backend (e.g. islands split creating new classes)
	// and the UI's color state, which is keyed by hex, needs to pick it up.
	const colorToHex = (color: Color): string => {
		const [r, g, b] = color;
		return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
	};

	const handleCreateClass = (name: string, colorHex: string): CheckBoxData | null => {
		const trimmed = name.trim();
		const dup = checkBoxData.some((s) => s.label.toLowerCase() === trimmed.toLowerCase());
		if (dup) return null; // name collides with an existing organ (catalog or custom)
	
		const result = createNewAnnotationClass(trimmed, hexToColor(colorHex));
		if (!result) return null;
	
		const newOrgan: CheckBoxData = { id: result.segmentIndex, label: trimmed };
		setCheckBoxData((prev) => [...prev, newOrgan]);
		setCheckState((prev) => {
			const next = [...prev];
			next[result.segmentIndex] = true;
			return next;
		});
		setLabelColorMap((prev) => ({ ...prev, [result.segmentIndex]: result.color }));
		setSegmentColorsHex((prev) => ({ ...prev, [result.segmentIndex]: colorHex }));

		// A brand-new class is almost always the thing the person immediately
		// wants to draw into — targeting it automatically saves the extra
		// "now go click it in the list" round trip every other tool already
		// spares them for. Also drops any catalog-organ target, since a
		// custom class and a catalog organ are mutually exclusive targets.
		setActiveSegmentState(result.segmentIndex);
		setActiveCatalogOrganId(null);

		sessionRef.current?.log("edit", `Created new class "${trimmed}"`, 2000);
		return newOrgan;
	};
	const handleMouseClick = async (e: MouseEvent) => {
		const idx = getOrganLabelOnClick();
		if (idx === undefined || typeof idx !== "number") {
			setToolTip({
				visible: false,
				x: 0,
				y: 0,
				text: "",
			})
			return;
		};
		const label = resolveOrganLabel(idx) ?? "Unknown";
		setToolTip({
			visible: true,
			x: e.clientX + 10,
			y: e.clientY + 10,
			text: label
		});
	};


	// Mousemove handler for the "hover to identify" tool — resolves the organ under the
	// cursor for one specific pane (via canvasToWorld, not the crosshair) and floats a
	// tooltip next to the pointer. No-ops entirely while the tool is off.
	const handlePaneHover = (pane: CinePane) => (e: MouseEvent) => {
		if (liveRoom?.metadata.mode === "review") {
			const bounds = e.currentTarget.getBoundingClientRect();
			liveRoom.sendPresence({
				cursor: {
					pane,
					x: (e.clientX - bounds.left) / Math.max(1, bounds.width),
					y: (e.clientY - bounds.top) / Math.max(1, bounds.height),
				},
				plane: pane,
			});
		}
		if (!hoverIdentifyEnabled) return;
		const idx = getOrganLabelAtPoint(pane, e.clientX, e.clientY);
		if (!idx) {
			setHoverOrganTip((t) => (t.visible ? { ...t, visible: false } : t));
			return;
		}
		const rawLabel = resolveOrganLabel(idx);
		setHoverOrganTip({
			visible: true,
			x: e.clientX + 14,
			y: e.clientY + 14,
			text: rawLabel?? "Unknown",
			// Same LUT the mask overlay is rendered with, so the swatch/border always
			// matches the color the organ is actually painted in the pane.
			color: colorToCss(labelColorMap[idx]),
		});
	};

	const handlePaneHoverLeave = (pane: CinePane) => () => {
		if (liveRoom?.metadata.mode === "review") liveRoom.sendPresence({ cursor: null });
		setHoverOrganTip((t) => (t.visible ? { ...t, visible: false } : t));
		// Without this, BrushTool can leave its circular cursor painted in the
		// pane you just moved out of instead of it reading as one cursor that
		// travels with the mouse across axial/sagittal/coronal — see
		// clearMaskEditCursor's own comment in CornerstoneNifti2 for why.
		if (activeToolbarTool === "paint" || activeToolbarTool === "erase") {
			clearMaskEditCursor(pane);
		}
	};

	const navBack = () => {
		window.location.href = liveRoom
			? appRootRelativeUrl(`/case/${liveRoom.metadata.case_id}`)
			: soloChallenge
				? `/case/${soloChallenge.challenge.case_id}`
				: quizPractice
					? `/case/${quizPractice.pack.case_id}`
					: "/dashboard";
	};
	// const PREVIEW_IDS = [1, 17, 30, 35, 121];

	// if (PREVIEW_IDS.filter((id) => id === Number(pantsCase)).length === 0) {
	// 	navigate("/");
	// 	return null;
	// }

	return (
		<div
			ref={vpRootRef}
			className={`VisualizationPage${showAISidebar ? " ai-panel-open" : ""}${showAnnotationToolbar ? " annotation-open" : ""}${liveRoom ? " is-live-room" : ""}${soloChallenge ? " is-solo-challenge" : ""}${quizPractice ? " is-quiz-practice" : ""}`}
			onPointerDownCapture={(event) => {
				if (!liveRoom?.followingId) return;
				const target = event.target as HTMLElement;
				if (!target.closest(".lr-header, .lr-dock")) liveRoom.stopFollowing();
			}}
			style={{
				display: "flex",
				overflow: "hidden",
				flexDirection: "column",
				height: "100dvh",
				["--vp-ai-width" as string]: `${aiWidth}px`,
				// When the AI sidebar opens, shrink the app to the left of it so the
				// CT views reflow beside the panel instead of being covered by it
				// (the fixed sidebar occupies --vp-ai-width on the right). The
				// showAISidebar resize effect re-fits the viewports to the new width.
				width: showAISidebar ? "calc(100vw - var(--vp-ai-width, 400px))" : "100vw",
				transition: "width 180ms ease",
			} as React.CSSProperties}>
			{liveRoom && (
				<LiveRoomHeader
					room={liveRoom}
					dockOpen={liveRoomDockOpen}
					onToggleDock={() => setLiveRoomDockOpen((value) => !value)}
				/>
			)}
			{soloChallenge && <SoloChallengeHeader controller={soloChallenge} />}
			{quizPractice && <QuizPracticeHeader controller={quizPractice} />}
		
			{/* ---- Top toolbar (PYCAD-style). Lives in normal flow, so it sits ABOVE the
			     viewports and never overlays them. Always visible - no show/hide toggle. ---- */}
			<div
				className="vp-topbar"
				ref={topbarRef}
			>
				<button
					className="vp-iconbtn"
					title="Back to dashboard"
					aria-label="Back to dashboard"
					onClick={() => navBack()}
					>
						<IconHome size={20} color="white" />
					</button>

					<span className="vp-tb-divider" />

					{/* Case / session identity. For a personal upload with a local record,
					    show + edit the same friendly name the Upload page shows -- both
					    read/write recentUploads, so renaming here updates it there too. */}
					<div className="vp-tb-id">
						<span className="vp-tb-id__eyebrow">{sessionId ? "Session" : "Case"}</span>
						{renamingScan ? (
							<input
								autoFocus
								value={scanRenameDraft}
								onChange={(e) => setScanRenameDraft(e.target.value)}
								onBlur={commitScanRename}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitScanRename();
									else if (e.key === "Escape") setRenamingScan(false);
								}}
								className="vp-tb-id__val vp-tb-id__rename-input"
							/>
						) : (
							<span className="vp-tb-id__val-row">
								<span className="vp-tb-id__val">{sessionId && scanLabel ? scanLabel : caseId}</span>
								{sessionId && scanLabel && (
									<button
										type="button"
										className="vp-tb-id__rename-btn"
										title="Rename scan"
										aria-label="Rename scan"
										onClick={() => { setScanRenameDraft(scanLabel); setRenamingScan(true); }}
									>
										<IconPencil size={12} />
									</button>
								)}
							</span>
						)}
					</div>
					<span className="vp-tb-divider" />

					{/* Layout ▾ — view mode (MPR/Axial/Sag/Cor/3D) and, while in MPR, the
					    pane-layout preset (which pane is enlarged) — both are "ways to view /
					    arrange the scan," so they share one dropdown instead of two permanently
					    visible rows of segmented buttons. Stays open on selection (a config
					    panel, not a pick-and-dismiss menu) so both pickers can be used in one visit. */}
					<div className="vp-toolgroup" ref={layoutFlyout.groupRef}>
						<button
							ref={layoutFlyout.btnRef}
							className={`vp-tb-mini vp-tb-mini--flyout ${layoutFlyout.open ? "vp-tb-mini--active" : ""}`}
							onClick={layoutFlyout.toggle}
							aria-label="Layout"
							aria-haspopup="menu"
							aria-expanded={layoutFlyout.open}
						>
							<span>{layoutTriggerLabel}</span>
							<IconChevronDown size={13} />
						</button>
						{layoutFlyout.open && layoutFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--config"
									role="menu"
									ref={layoutFlyout.menuRef}
									style={{ position: "fixed", top: layoutFlyout.pos.top, left: layoutFlyout.pos.left }}
								>
									<span className="vp-panel__title">View</span>
									<div className="vp-seg" role="group" aria-label="View layout">
										{VIEW_MODE_OPTIONS.map(({ mode, label }) => (
											<button
												key={mode}
												onClick={() => setViewMode(mode)}
												className={`vp-seg__btn ${viewMode === mode ? "vp-seg__btn--active" : ""}`}
											>{label}</button>
										))}
									</div>
									{viewMode === "mpr" && (
										<>
											<span className="vp-panel__title">Panes</span>
											<div className="vp-seg vp-seg--pane-layout" role="group" aria-label="Pane layout">
												{LAYOUT_PRESETS.map(({ id, label }) => (
													<button
														key={id}
														onClick={() => { track("viewer_change_layout"); setLayoutPreset(id); }}
														className={`vp-seg__btn ${layoutPreset === id ? "vp-seg__btn--active" : ""}`}
													>{label}</button>
												))}
											</div>
										</>
									)}
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Window ▾ — CT presets. Trigger shows the active preset's name; stays
					    open (a config panel) so presets can be flipped through quickly. */}
					<div className="vp-toolgroup" ref={windowFlyout.groupRef}>
						<button
							ref={windowFlyout.btnRef}
							className={`vp-tb-mini vp-tb-mini--flyout ${windowFlyout.open ? "vp-tb-mini--active" : ""}`}
							onClick={windowFlyout.toggle}
							aria-label="CT window preset"
							aria-haspopup="menu"
							aria-expanded={windowFlyout.open}
						>
							<span>{activePreset || "Window"}</span>
							<IconChevronDown size={13} />
						</button>
						{windowFlyout.open && windowFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--config"
									role="menu"
									ref={windowFlyout.menuRef}
									style={{ position: "fixed", top: windowFlyout.pos.top, left: windowFlyout.pos.left }}
								>
									{CT_PRESETS.map((preset) => (
										<button
											key={preset.name}
											className={`vp-flyout__item ${activePreset === preset.name ? "is-active" : ""}`}
											role="menuitem"
											onClick={() => handlePresetClick(preset)}
										>
											<span>{preset.name}</span>
										</button>
									))}
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Adjust ▾ — mask fill/border opacity, brightness, contrast, zoom, plus
					    center/reset. A live panel (stays open) so the sliders can be dragged
					    without the menu closing after each change. */}
					<div className="vp-toolgroup" ref={adjustFlyout.groupRef}>
						<button
							ref={adjustFlyout.btnRef}
							className={`vp-tool ${adjustFlyout.open ? "vp-tool--active" : ""}`}
							onClick={adjustFlyout.toggle}
							aria-label="Adjust"
							aria-haspopup="menu"
							aria-expanded={adjustFlyout.open}
						>
							<IconAdjustmentsHorizontal size={20} color={adjustFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Adjust</span>
						</button>
						{adjustFlyout.open && adjustFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--adjust"
									role="menu"
									ref={adjustFlyout.menuRef}
									style={{ position: "fixed", top: adjustFlyout.pos.top, left: adjustFlyout.pos.left }}
								>
									{!isLocal && (
										<>
											<label className="vp-tb-slider" title="Mask fill opacity">
												<span className="vp-tb-slider__label">Fill</span>
												<input
													type="range" min="0" max="100" step="1" className="vp-range"
													aria-label="Mask fill opacity"
													value={opacityValue}
													onChange={handleOpacityOnSliderChange}
												/>
												<span className="vp-tb-slider__val">{Math.round(opacityValue)}%</span>
											</label>
											<label className="vp-tb-slider" title="Mask border opacity">
												<span className="vp-tb-slider__label">Border</span>
												<input
													type="range" min="0" max="100" step="1" className="vp-range"
													aria-label="Mask border opacity"
													value={outlineOpacityValue}
													onChange={handleOutlineOpacityChange}
												/>
												<span className="vp-tb-slider__val">{Math.round(outlineOpacityValue)}%</span>
											</label>
										</>
									)}
									<label className="vp-tb-slider" title="Brightness (window level)">
										<span className="vp-tb-slider__label">Brt</span>
										<input
											type="range" min="-1000" max="1000" step="1" className="vp-range"
											aria-label="Brightness"
											value={windowCenter * -1}
											onChange={(e) => {
												handleWindowChange(null, Number(e.target.value) * -1);
												showWindowReadoutBriefly();
											}}
										/>
									</label>
									<label className="vp-tb-slider" title="Contrast (window width)">
										<span className="vp-tb-slider__label">Con</span>
										<input
											type="range" min="1" max="2000" step="1" className="vp-range"
											aria-label="Contrast"
											value={windowWidth}
											onChange={(e) => {
												handleWindowChange(Number(e.target.value), null);
												showWindowReadoutBriefly();
											}}
										/>
									</label>
									<label className="vp-tb-slider" title="Zoom">
										<span className="vp-tb-slider__label">Zoom</span>
										<input
											type="range" min="0.5" max="2" step="0.05" className="vp-range"
											aria-label="Zoom"
											value={zoomLevel}
											onChange={(e) => setZoomLevel(Number(e.target.value))}
										/>
										<span className="vp-tb-slider__val">{zoomLevel.toFixed(1)}×</span>
									</label>
									<div className="vp-flyout--adjust__actions">
										<button className="vp-tb-mini" onClick={() => centerOnCursor()} title="Center on crosshair">Center</button>
										<button
											className="vp-tb-mini"
											onClick={() => {
												// Also undoes any oblique-plane rotation from the crosshair's
												// rotate handles, back to standard axial/sagittal/coronal.
												resetMprOrientation();
												zoomToFit();
												setZoomLevel(1);
											}}
											title="Reset zoom, pan & MPR orientation"
										>Reset</button>
									</div>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Tools */}
									<div className="vp-toolrow vp-tb-tools">
										{/* Crosshair stays inline — it's the default/most-used navigation mode, not
										    worth burying behind a menu. Everything else below is grouped into
										    dropdowns (same portal-flyout pattern as Measure/Cine originally used)
										    so the bar reads as ~9 clusters instead of ~20 individual icons. */}
										<button
												className={`vp-tool ${crosshairToolActive && !activeMeasureTool && !editMode && activeToolbarTool !== "pointSegment" && activeToolbarTool !== "boxSegment" ? "vp-tool--active" : ""}`}
												onClick={() => {
													setEditMode(null);
													setActiveMeasureTool(null);
													setCrosshairToolActive((prev) => !prev);
												}}
												aria-label="Crosshair mode"
											>
												<IconPointer size={20} color={crosshairToolActive && !activeMeasureTool && !editMode && activeToolbarTool !== "pointSegment" && activeToolbarTool !== "boxSegment" ? "#08090b" : "white"} />
												<span className="vp-tool__tip">Crosshair</span>
											</button>

											{/* Measure ▾ — measurement tools + the magnify loupe (shares the same
											    primary-mouse-tool slot) + clear. */}
											<div className="vp-toolgroup" ref={measureFlyout.groupRef}>
												<button
													ref={measureFlyout.btnRef}
												className={`vp-tool ${measureToolActive || measureFlyout.open ? "vp-tool--active" : ""}`}
												onClick={measureFlyout.toggle}
												disabled={collaborationDisabled}
													aria-label="Measurement tools"
													aria-haspopup="menu"
													aria-expanded={measureFlyout.open}
												>
													<ActiveMeasureIcon size={20} color={measureToolActive || measureFlyout.open ? "#08090b" : "white"} />
													<span className="vp-tool__caret" />
													<span className="vp-tool__tip">Measure</span>
												</button>
												{measureFlyout.open && measureFlyout.pos &&
													createPortal(
														<div
															className="vp-flyout"
															role="menu"
															ref={measureFlyout.menuRef}
															style={{ position: "fixed", top: measureFlyout.pos.top, left: measureFlyout.pos.left }}
														>
															{MEASURE_TOOLS.map(({ name, label, Icon, key: hotkey }) => (
																<button
																	key={name}
																	className={`vp-flyout__item ${activeMeasureTool === name ? "is-active" : ""}`}
															role="menuitem"
															disabled={collaborationDisabled}
																	onClick={() => {
																		setEditMode(null);
																		setActiveMeasureTool((p) => (p === name ? null : name));
																		measureFlyout.close();
																	}}
																>
																	<Icon size={18} />
																	<span>{label}</span>
																	<span className="vp-flyout__kbd">{hotkey}</span>
																</button>
															))}
															<button
																className="vp-flyout__item"
														role="menuitem"
														disabled={collaborationDisabled}
																onClick={() => {
																	clearMeasurements();
																	measureFlyout.close();
																}}
															>
																<IconTrash size={18} />
																<span>Clear measurements</span>
															</button>
														</div>,
														document.body
													)}
											</div>

											{/* View ▾ — hover-identify + reference lines (toggles) and flip/rotate
											    (one-shot actions on the focused pane). */}
											<div className="vp-toolgroup" ref={viewFlyout.groupRef}>
												<button
													ref={viewFlyout.btnRef}
													className={`vp-tool ${viewGroupActive || viewFlyout.open ? "vp-tool--active" : ""}`}
													onClick={viewFlyout.toggle}
													aria-label="View options"
													aria-haspopup="menu"
													aria-expanded={viewFlyout.open}
												>
													<IconEye size={20} color={viewGroupActive || viewFlyout.open ? "#08090b" : "white"} />
													<span className="vp-tool__caret" />
													<span className="vp-tool__tip">View</span>
												</button>
												{viewFlyout.open && viewFlyout.pos &&
													createPortal(
														<div
															className="vp-flyout"
															role="menu"
															ref={viewFlyout.menuRef}
															style={{ position: "fixed", top: viewFlyout.pos.top, left: viewFlyout.pos.left }}
														>
															<button
																className={`vp-flyout__item ${hoverIdentifyEnabled ? "is-active" : ""}`}
																role="menuitem"
																title="Name the organ under the cursor"
																onClick={() => {
																	setHoverIdentifyEnabled((v) => !v);
																	setHoverOrganTip((t) => (t.visible ? { ...t, visible: false } : t));
																	viewFlyout.close();
																}}
															>
																<IconScanEye size={18} />
																<span>{hoverIdentifyEnabled ? "Hover identify: on" : "Hover identify"}</span>
															</button>
															<button
																className={`vp-flyout__item ${referenceLinesOn ? "is-active" : ""}`}
																role="menuitem"
																title="Dotted line in the other panes for whichever pane you scroll"
																onClick={() => {
																	setReferenceLinesOn((v) => !v);
																	viewFlyout.close();
																}}
															>
																<IconGrid3x3 size={18} />
																<span>{referenceLinesOn ? "Reference lines: on" : "Reference lines"}</span>
															</button>
															<button
																className="vp-flyout__item"
																role="menuitem"
																title="The focused pane — last one scrolled or clicked"
																onClick={() => {
																	handleFlipHorizontal();
																	viewFlyout.close();
																}}
															>
																<IconFlipHorizontal size={18} />
																<span>Flip horizontal</span>
															</button>
															<button
																className="vp-flyout__item"
																role="menuitem"
																title="The focused pane — last one scrolled or clicked"
																onClick={() => {
																	handleRotate90Clockwise();
																	viewFlyout.close();
																}}
															>
																<IconRotateClockwise size={18} />
																<span>Rotate 90° clockwise</span>
															</button>
														</div>,
														document.body
													)}
											</div>

											{/* Cine ▾ — the one flyout that stays open on click: a live mini-panel
											    (play/pause + FPS side by side), not a pick-and-dismiss menu. */}
											<div className="vp-toolgroup" ref={cineFlyout.groupRef}>
												<button
													ref={cineFlyout.btnRef}
													className={`vp-tool ${cinePlaying || cineFlyout.open ? "vp-tool--active" : ""}`}
													onClick={cineFlyout.toggle}
													aria-label="Cine controls"
													aria-haspopup="menu"
													aria-expanded={cineFlyout.open}
												>
													{cinePlaying ? (
														<IconPlayerPause size={20} color={cineFlyout.open ? "#08090b" : "white"} />
													) : (
														<IconPlayerPlay size={20} color={cineFlyout.open ? "#08090b" : "white"} />
													)}
													<span className="vp-tool__tip">
														{cinePlaying ? `Cine playing (${cineFps} fps) — click for controls` : "Cine controls (V to play)"}
													</span>
												</button>
												{cineFlyout.open && cineFlyout.pos &&
													createPortal(
														<div
															className="vp-flyout vp-flyout--cine"
															role="menu"
															ref={cineFlyout.menuRef}
															style={{ position: "fixed", top: cineFlyout.pos.top, left: cineFlyout.pos.left }}
														>
															<button
																className={`vp-tool vp-tool--cine-play ${cinePlaying ? "vp-tool--active" : ""}`}
																onClick={toggleCine}
																aria-label={cinePlaying ? "Pause cine playback" : "Play cine playback"}
															>
																{cinePlaying ? (
																	<IconPlayerPause size={20} color="#08090b" />
																) : (
																	<IconPlayerPlay size={20} color="white" />
																)}
															</button>
															<label className="vp-tb-slider vp-tb-slider--cine" title="Cine playback speed">
																<span className="vp-tb-slider__label">FPS</span>
																<input
																	type="range" min="1" max="100" step="1" className="vp-range"
																	aria-label="Cine frames per second"
																	value={cineFps}
																	onChange={(e) => handleCineFpsChange(Number(e.target.value))}
																/>
																<span className="vp-tb-slider__val">{cineFps}</span>
															</label>
														</div>,
														document.body
													)}
											</div>

											{/* Undo/redo stay standalone (not grouped) — they're used constantly
											    during a review and shouldn't cost an extra click to reach. Cover
											    measurements as well as mask edits; ⌘Z/⇧⌘Z work everywhere too.
											    Wrapped in undoRedoGroupRef so clicking either button never closes
											    an already-open annotation ribbon (see the topbar's onClick above) —
											    undo/redo history is independent of ribbon visibility. */}
											<div ref={undoRedoGroupRef} style={{ display: "contents" }}>
												<button
													className="vp-tool"
												onClick={() => liveRoom ? liveRoom.requestUndo() : handleUndo()}
												disabled={collaborationDisabled}
													aria-label="Undo"
												>
													<IconArrowBackUp size={20} color="white" />
													<span className="vp-tool__tip">Undo (⌘Z) — measurements & mask edits</span>
												</button>
												<button
													className="vp-tool"
													onClick={() => redoMaskEdit()}
													disabled={Boolean(liveRoom)}
													aria-label="Redo"
												>
													<IconArrowForwardUp size={20} color="white" />
													<span className="vp-tool__tip">Redo (⇧⌘Z)</span>
												</button>
											</div>
											
											{!isLocal && !soloChallenge && liveRoom?.metadata.mode !== "quiz" && (() => {
												// Annotating on the low-res stream would edit a mask that
												// doesn't line up with the eventual full-res volume — but
												// the button itself is never disabled for that reason
												// anymore. Instead, clicking it while HD isn't ready kicks
												// off the HD upgrade immediately and shows a full-screen
												// loading overlay; the toolbar only opens once that
												// finishes (see handleAnnotateClick / annotateHdLoading).
													const hdReady = isHd || enhance.state === "done";
													const annotationDisabled = collaborationDisabled;
												return (
													<button
														ref={annotatePencilRef}
														className={`vp-tool ${showAnnotationToolbar ? "vp-tool--active" : ""} ${annotationDisabled ? "vp-tool--disabled" : ""} ${annotateHdLoading ? "vp-tool--busy" : ""}`}
														onClick={handleAnnotateClick}
															disabled={annotationDisabled}
															aria-disabled={annotationDisabled}
														aria-label="Annotate"
														aria-pressed={showAnnotationToolbar}
													>
														<IconPencil size={20} color={showAnnotationToolbar ? "#08090b" : "white"} />
														<span className="vp-tool__tip">
															{hdReady ? "Annotate" : "Annotate — loads HD resolution first"}
														</span>
													</button>
												);
											})()}

											{/* Capture ▾ — snapshot, voice-narrated reading session, share link. */}
											{!soloChallenge && <div className="vp-toolgroup" ref={captureFlyout.groupRef}>
												<button
													ref={captureFlyout.btnRef}
													className={`vp-tool ${readingSession ? "vp-tool--rec" : ""} ${captureFlyout.open ? "vp-tool--active" : ""}`}
													onClick={captureFlyout.toggle}
													aria-label="Capture and session tools"
													aria-haspopup="menu"
													aria-expanded={captureFlyout.open}
												>
													<IconCamera size={20} color={captureFlyout.open ? "#08090b" : "white"} />
													<span className="vp-tool__caret" />
													<span className="vp-tool__tip">
														{readingSession ? "Recording — capture / share" : "Capture"}
													</span>
												</button>
												{captureFlyout.open && captureFlyout.pos &&
													createPortal(
														<div
															className="vp-flyout"
															role="menu"
															ref={captureFlyout.menuRef}
															style={{ position: "fixed", top: captureFlyout.pos.top, left: captureFlyout.pos.left }}
														>
															<button
																className="vp-flyout__item"
																role="menuitem"
																onClick={() => {
																	void takeSnapshot();
																	captureFlyout.close();
																}}
															>
																<IconCamera size={18} />
																<span>Snapshot</span>
																<span className="vp-flyout__kbd">S</span>
															</button>
															<button
																className={`vp-flyout__item ${readingSession ? "is-active" : ""}`}
																role="menuitem"
																disabled={sessionStarting}
																onClick={() => {
																	if (readingSession) void stopReadingSession();
																	else void startReadingSession();
																	captureFlyout.close();
																}}
															>
																<IconMicrophone size={18} />
																<span>
																	{readingSession
																		? "Stop reading session"
																		: sessionStarting
																			? "Starting…"
																			: "Record reading session"}
																</span>
															</button>
															{!isLocal && (
																<button
																	className="vp-flyout__item"
																	role="menuitem"
																	onClick={() => {
																		void handleShare();
																		captureFlyout.close();
																	}}
																>
																	{shareCopied ? <IconCheck size={18} /> : <IconShare size={18} />}
																	<span>{shareCopied ? "Link copied!" : "Share this view"}</span>
																</button>
															)}
														</div>,
														document.body
													)}
											</div>}

											{/* Panels ▾ — every side-panel opener in one place (organs list, organ
											    stats, case metadata, measurements). */}
											{!soloChallenge && <div className="vp-toolgroup" ref={panelsFlyout.groupRef}>
												<button
													ref={panelsFlyout.btnRef}
													className={`vp-tool ${panelsGroupActive || panelsFlyout.open ? "vp-tool--active" : ""}`}
													onClick={panelsFlyout.toggle}
													aria-label="Panels"
													aria-haspopup="menu"
													aria-expanded={panelsFlyout.open}
												>
													<IconLayoutSidebarRight size={20} color={panelsGroupActive || panelsFlyout.open ? "#08090b" : "white"} />
													<span className="vp-tool__caret" />
													<span className="vp-tool__tip">Panels</span>
												</button>
												{panelsFlyout.open && panelsFlyout.pos &&
													createPortal(
														<div
															className="vp-flyout"
															role="menu"
															ref={panelsFlyout.menuRef}
															style={{ position: "fixed", top: panelsFlyout.pos.top, left: panelsFlyout.pos.left }}
														>
															{!isLocal && (
																<button
																	className={`vp-flyout__item ${showOrganDetails ? "is-active" : ""}`}
																	role="menuitem"
																	onClick={() => {
																		if (showOrganDetails) {
																			setShowOrganDetails(false);
																		} else {
																			setShowStats(false);
																			setShowMetadata(false);
																			setShowMeasurePanel(false);
																			setShowOrganDetails(true);
																		}
																		panelsFlyout.close();
																	}}
																>
																	<IconStack2 size={18} />
																	<span>Organs</span>
																</button>
															)}
															{!isLocal && (
																<button
																	className={`vp-flyout__item ${showStats ? "is-active" : ""}`}
																	role="menuitem"
																	onClick={() => {
																		handleToggleStats();
																		panelsFlyout.close();
																	}}
																>
																	<IconChartBar size={18} />
																	<span>Organ stats</span>
																</button>
															)}
															{!isLocal && (
																<button
																	className={`vp-flyout__item ${showMetadata ? "is-active" : ""}`}
																	role="menuitem"
																	onClick={() => {
																		handleToggleMetadata();
																		panelsFlyout.close();
																	}}
																>
																	<IconId size={18} />
																	<span>Case metadata</span>
																</button>
															)}
															<button
																className={`vp-flyout__item ${showMeasurePanel ? "is-active" : ""}`}
																role="menuitem"
																onClick={() => {
																	setShowStats(false);
																	setShowMetadata(false);
																	setShowAnnotationToolbar(false);
																	setEditMode(null);
																	setActiveToolbarTool(null);										
																	setShowMeasurePanel((v) => !v);
																	panelsFlyout.close();
																}}
															>
																<IconListDetails size={18} />
																<span>Measurements</span>
																<span className="vp-flyout__kbd">M</span>
															</button>
														</div>,
														document.body
													)}
											</div>}

											{/* Report and Download stay standalone and separate (not grouped with
											    each other) — distinct export actions users reach for independently. */}
											{!isLocal && !soloChallenge && !quizPractice && !liveRoom && (
												<button
													className="vp-tool"
													onClick={() => {
														track("report_open");
														setViewMode("3d");
														setShowReportScreen(true);
													}}
													aria-label="Open report"
												>
													<IconReport size={20} color="white" />
													<span className="vp-tool__tip">Report</span>
												</button>
											)}

											{/* HD and AI stay inline: HD is a live status indicator (streaming %),
											    and AI is a headline feature — neither belongs buried in a menu. */}
											{!liveRoom && !soloChallenge && !quizPractice && !sessionId && localAvailable && (
												<button
													className={`vp-tool ${isHd || enhance.state === "done" ? "vp-tool--active" : ""} ${enhance.state === "streaming" ? "vp-tool--busy" : ""}`}
													onClick={() => {
														closeAnnotationToolbarIfOpen();
														// Full-res streams in automatically and swaps in place; the button
														// is the status + manual trigger, with reload as the failure path.
														if (isHd) toggleHd();
														else if (enhance.state === "idle") void runEnhance();
														else if (enhance.state === "failed") toggleHd();
													}}
													aria-label="Full resolution"
												>
													<span style={{ fontFamily: "var(--vp-mono)", fontSize: "12px", fontWeight: 700 }}>
														{enhance.state === "streaming" ? `${enhance.pct ?? 0}%` : "HD"}
													</span>
													<span className="vp-tool__tip">
														{isHd
															? "Full res · click for fast"
															: enhance.state === "streaming"
																? `Enhancing to full resolution… ${enhance.pct ?? 0}%`
																: enhance.state === "done"
																	? "Full resolution ✓"
																	: enhance.state === "failed"
																		? "Enhance failed — click to reload in HD"
																		: "Load full resolution"}
													</span>
												</button>
											)}
											{!isLocal && !soloChallenge && (
												<button
													type="button"
													className={`vp-tool ${showAISidebar ? "vp-tool--active" : ""}`}
													onClick={handleToggleAISidebar}
													aria-label={
														showAISidebar
														? "Close BodyMaps AI"
														: "Open BodyMaps AI"
													}
													aria-expanded={showAISidebar}
												>
													<span
														style={{
															fontFamily: "var(--vp-mono)",
															fontSize: "12px",
															fontWeight: 700,
														}}
													>
														AI
													</span>
													<span className="vp-tool__tip">
														{showAISidebar ? "Close BodyMaps AI" : "BodyMaps AI"}
													</span>
												</button>
											)}
											{!liveRoom && params.caseId && (
												<button
													type="button"
													className="vp-tool"
													onClick={() => setShowLiveRoomCreate(true)}
													aria-label="Start Live Room"
												>
													<IconUsersGroup size={17} />
													<span className="vp-tool__tip">Live Room</span>
												</button>
											)}
										</div>
				</div>

			{/* Body row: left dock (Organs) · stage · right docks (stats/measurements/
			     edit/AI). Docked panels sit IN FLOW beside the viewports — they push the
			     stage narrower instead of overlaying it (same principle as the toolbar
			     above pushing it down). The stage's ResizeObserver refits the canvases
			     whenever a dock opens or closes. */}
			<div className="vp-body">
				{!isLocal && !soloChallenge && (
					<OrganCheckbox
						setCheckState={setCheckState}
						checkState={checkState}
						sessionId={sessionId}
						setShowOrganDetails={setShowOrganDetails}
						showOrganDetails={showOrganDetails}
						labelColorMap={labelColorMap}
						onJumpToOrgan={handleJumpToOrgan}
						customOrgans={customOrgans}
					/>
				)}

			{/* Stage — fills the space below the toolbar; the viewports live here. */}
			<div className="vp-stage" ref={stageRef}>

				{loading ? (
					<div className="vp-loading">
						<div className="vp-spinner" />
						<div className="vp-loading__text">Preparing case {caseId}…</div>
						{pantsCase && (dlDone || dlPct != null) && (
							<div className="vp-progress">
								<div className="vp-progress__head">
									<span className="vp-progress__label">
										{dlDone ? "Finalizing…" : "Loading scan"}
									</span>
									{!dlDone && dlPct != null && (
										<span className="vp-progress__pct">{dlPct}%</span>
									)}
								</div>
								<div className="vp-progress__track">
									<div
										className={`vp-progress__fill ${dlDone ? "is-finalizing" : ""}`}
										style={dlDone ? undefined : { width: `${dlPct ?? 0}%` }}
									/>
								</div>
							</div>
						)}
					</div>
				) : null}
				<div
					className="visualization-container"
					ref={VisualizationContainer_ref}
					style={{
						overflow: "hidden",
						// Collapse to a single cell only for the 2D single views. MPR keeps a grid
						// (2×2 by default, or a wide primary column + narrow stacked column for an
						// asymmetric layout preset); 3D also keeps the 2×2 grid underneath since it
						// just overlays the render pane on top of it.
						...(viewMode !== "mpr" && viewMode !== "3d"
							? { gridTemplateColumns: "1fr", gridTemplateRows: "1fr" }
							: viewMode === "mpr" && layoutPreset !== "grid"
								? { gridTemplateColumns: "2fr 1fr", gridTemplateRows: "1fr 1fr 1fr" }
								: {}),
					}}
				>
					<div
						className="vp-pane-wrap"
						style={{ ...panelStyle("axial"), ...paneGridStyle("axial") }}
						onMouseUp={(e) => { smartFill.handleMouseUp(); boxSegment.handleMouseUp("axial")(e); }}>
						<div
							className={`axial ${loading ? "" : "vp-pane vp-pane--axial"}${hoverIdentifyEnabled ? " vp-pane--hover-identify" : ""}${editMode === "smartfill" || morphPicker.picking ? " vp-pane--edit-cursor" : ""}`}
							data-label="Axial"
							ref={axial_ref}
							onClick={(e) => { handleMouseClick(e); pointSegment.handleClick("axial")(e); }}
							onDoubleClick={activeDrawTool.handleDoubleClick("axial")}
							onMouseDown={(e) => {
								focusedPane.handleMouseDown("axial")();
								smartFill.handleMouseDown("axial")(e);
								morphPicker.handlePaneClick("axial")(e);
								activeDrawTool.handleClick("axial")(e);
								levelTracing.handleClick("axial")(e);
								boxSegment.handleMouseDown("axial")(e);
							}}
							onMouseMove={(e) => {
								handlePaneHover("axial")(e);
								smartFill.handleMouseMove("axial")(e);
								activeDrawTool.handleMouseMove("axial")(e);
								levelTracing.handleMouseMove("axial")(e);
								boxSegment.handleMouseMove("axial")(e);
							}}
							onMouseLeave={handlePaneHoverLeave("axial")}
							onWheel={focusedPane.handleWheel("axial")}
						></div>
						{!loading && renderPaneOverlays("axial")}
						{editMode === "smartfill" && (
							<svg
								className="vp-smartfill-overlay"
								style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30 }}
							>
								{smartFill.preview.axial.fg
									.filter((p) => p.slice === (sliceInfo.axial?.current ?? -1))
									.map((p, i) => (
										<circle key={`fg${i}`} cx={p.pos[0]} cy={p.pos[1]} r={5} fill="#68ACE5" stroke="#08090b" strokeWidth={1.5} />
									))}
								{smartFill.preview.axial.bg
									.filter((p) => p.slice === (sliceInfo.axial?.current ?? -1))
									.map((p, i) => (
										<circle key={`bg${i}`} cx={p.pos[0]} cy={p.pos[1]} r={5} fill="#000000" stroke="#08090b" strokeWidth={1.5} />
									))}
							</svg>
						)}
						{editMode === "lasso" && activeDrawTool.pane === "axial" && (
							<LiveWireOverlay
							pane="axial"
							anchorPointsCanvas={activeDrawTool.anchorsCanvas}
							cornerPointsCanvas={activeDrawTool.cornersCanvas}
							nearClose={activeDrawTool.nearClose}
							livePreviewPath={activeDrawTool.livePreviewPath}
						/>
						)}
						{editMode === "lasso" && activeDrawTool.pane === "axial" && (
							<CloseLoopHint nearClose={activeDrawTool.nearClose} anchor={activeDrawTool.cornersCanvas[0]} />
						)}
						{activeToolbarTool === "levelTracing" && levelTracing.previewPane === "axial" && levelTracing.previewPath && (
						<svg
							className="vp-leveltrace-overlay"
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30 }}
						>
							<polygon
								points={levelTracing.previewPath.map((p) => `${p[0]},${p[1]}`).join(" ")}
								fill="rgba(0, 45, 114, 0.22)"
								stroke="#002d72"
								strokeWidth={2}
							/>
						</svg>
					)}
					{brushPreviewActive &&
						(activeToolbarTool === "paint" || activeToolbarTool === "erase") &&
						focusedPane.getFocusedPane() === "axial" && (
							<div
								className="vp-brush-preview"
								style={{
									width: diameterMm * getPanePxPerMm(axial_ref.current),
									height: diameterMm * getPanePxPerMm(axial_ref.current),
								}}
							/>
						)}
				</div>
					<div
						className="vp-pane-wrap"
						style={{ ...panelStyle("sagittal"), ...paneGridStyle("sagittal") }}
						onMouseUp={(e) => { smartFill.handleMouseUp(); boxSegment.handleMouseUp("sagittal")(e); }}>
					<div
						className={`sagittal ${loading ? "" : "vp-pane vp-pane--sagittal"}${hoverIdentifyEnabled ? " vp-pane--hover-identify" : ""}${editMode === "smartfill" || morphPicker.picking ? " vp-pane--edit-cursor" : ""}`}
						data-label="Sagittal"
						ref={sagittal_ref}
						onClick={(e) => { handleMouseClick(e); pointSegment.handleClick("sagittal")(e); }}
						onDoubleClick={activeDrawTool.handleDoubleClick("sagittal")}
						onMouseDown={(e) => {
							focusedPane.handleMouseDown("sagittal")();
							smartFill.handleMouseDown("sagittal")(e);
							morphPicker.handlePaneClick("sagittal")(e);
							activeDrawTool.handleClick("sagittal")(e);
							levelTracing.handleClick("sagittal")(e);
							boxSegment.handleMouseDown("sagittal")(e);
						}}
						onMouseMove={(e) => {
							handlePaneHover("sagittal")(e);
							smartFill.handleMouseMove("sagittal")(e);
							activeDrawTool.handleMouseMove("sagittal")(e);
							levelTracing.handleMouseMove("sagittal")(e);
							boxSegment.handleMouseMove("sagittal")(e);
						}}
						onMouseLeave={handlePaneHoverLeave("sagittal")}
						onWheel={focusedPane.handleWheel("sagittal")}
					></div>
						{!loading && renderPaneOverlays("sagittal")}
						{editMode === "smartfill" && (
							<svg
								className="vp-smartfill-overlay"
								style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30 }}
							>
								{smartFill.preview.sagittal.fg
									.filter((p) => p.slice === (sliceInfo.sagittal?.current ?? -1))
									.map((p, i) => (
										<circle key={`fg${i}`} cx={p.pos[0]} cy={p.pos[1]} r={5} fill="#68ACE5" stroke="#08090b" strokeWidth={1.5} />
									))}
								{smartFill.preview.sagittal.bg
									.filter((p) => p.slice === (sliceInfo.sagittal?.current ?? -1))
									.map((p, i) => (
										<circle key={`bg${i}`} cx={p.pos[0]} cy={p.pos[1]} r={5} fill="#000000" stroke="#08090b" strokeWidth={1.5} />
									))}
							</svg>
						)}
						{editMode === "lasso" && activeDrawTool.pane === "sagittal" && (
							<LiveWireOverlay
								pane="sagittal"
								anchorPointsCanvas={activeDrawTool.anchorsCanvas}
								cornerPointsCanvas={activeDrawTool.cornersCanvas}
								nearClose={activeDrawTool.nearClose}
								livePreviewPath={activeDrawTool.livePreviewPath}
							/>
						)}
						{editMode === "lasso" && activeDrawTool.pane === "sagittal" && (
							<CloseLoopHint nearClose={activeDrawTool.nearClose} anchor={activeDrawTool.cornersCanvas[0]} />
						)}
						{activeToolbarTool === "levelTracing" && levelTracing.previewPane === "sagittal" && levelTracing.previewPath && (
						<svg
							className="vp-leveltrace-overlay"
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30 }}
						>
							<polygon
								points={levelTracing.previewPath.map((p) => `${p[0]},${p[1]}`).join(" ")}
								fill="rgba(0, 45, 114, 0.22)"
								stroke="#002d72"
								strokeWidth={2}
							/>
						</svg>
					)}
					{brushPreviewActive &&
						(activeToolbarTool === "paint" || activeToolbarTool === "erase") &&
						focusedPane.getFocusedPane() === "sagittal" && (
							<div
								className="vp-brush-preview"
								style={{
									width: diameterMm * getPanePxPerMm(sagittal_ref.current),
									height: diameterMm * getPanePxPerMm(sagittal_ref.current),
								}}
							/>
						)}
					</div>

					<div
						className="vp-pane-wrap"
						style={{ ...panelStyle("coronal"), ...paneGridStyle("coronal") }}
						onMouseUp={(e) => { smartFill.handleMouseUp(); boxSegment.handleMouseUp("coronal")(e); }}>
					<div
						className={`coronal ${loading ? "" : "vp-pane vp-pane--coronal"}${hoverIdentifyEnabled ? " vp-pane--hover-identify" : ""}${editMode === "smartfill" || morphPicker.picking ? " vp-pane--edit-cursor" : ""}`}
						data-label="Coronal"
						ref={coronal_ref}
						onClick={(e) => { handleMouseClick(e); pointSegment.handleClick("coronal")(e); }}
						onDoubleClick={activeDrawTool.handleDoubleClick("coronal")}
						onMouseDown={(e) => {
							focusedPane.handleMouseDown("coronal")();
							smartFill.handleMouseDown("coronal")(e);
							morphPicker.handlePaneClick("coronal")(e);
							activeDrawTool.handleClick("coronal")(e);
							levelTracing.handleClick("coronal")(e);
							boxSegment.handleMouseDown("coronal")(e);


						}}
						onMouseMove={(e) => {
							handlePaneHover("coronal")(e);
							smartFill.handleMouseMove("coronal")(e);
							activeDrawTool.handleMouseMove("coronal")(e);
							levelTracing.handleMouseMove("coronal")(e);
							boxSegment.handleMouseMove("coronal")(e);
						}}
						onMouseLeave={handlePaneHoverLeave("coronal")}
						onWheel={focusedPane.handleWheel("coronal")}
					></div>
					{!loading && renderPaneOverlays("coronal")}
						{editMode === "smartfill" && (
							<svg
								className="vp-smartfill-overlay"
								style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30 }}
							>
								{smartFill.preview.coronal.fg
									.filter((p) => p.slice === (sliceInfo.coronal?.current ?? -1))
									.map((p, i) => (
										<circle key={`fg${i}`} cx={p.pos[0]} cy={p.pos[1]} r={5} fill="#68ACE5" stroke="#08090b" strokeWidth={1.5} />
									))}
								{smartFill.preview.coronal.bg
									.filter((p) => p.slice === (sliceInfo.coronal?.current ?? -1))
									.map((p, i) => (
										<circle key={`bg${i}`} cx={p.pos[0]} cy={p.pos[1]} r={5} fill="#000000" stroke="#08090b" strokeWidth={1.5} />
									))}
							</svg>
						)}
						{editMode === "lasso" && activeDrawTool.pane === "coronal" && (
							<LiveWireOverlay
								pane="coronal"
								anchorPointsCanvas={activeDrawTool.anchorsCanvas}
								cornerPointsCanvas={activeDrawTool.cornersCanvas}
								nearClose={activeDrawTool.nearClose}
								livePreviewPath={activeDrawTool.livePreviewPath}
							/>
						)}
						{editMode === "lasso" && activeDrawTool.pane === "coronal" && (
							<CloseLoopHint nearClose={activeDrawTool.nearClose} anchor={activeDrawTool.cornersCanvas[0]} />
						)}

						{activeToolbarTool === "levelTracing" && levelTracing.previewPane === "coronal" && levelTracing.previewPath && (
						<svg
							className="vp-leveltrace-overlay"
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30 }}
						>
							<polygon
								points={levelTracing.previewPath.map((p) => `${p[0]},${p[1]}`).join(" ")}
								fill="rgba(0, 45, 114, 0.22)"
								stroke="#002d72"
								strokeWidth={2}
							/>
						</svg>
					)}
					{brushPreviewActive &&
						(activeToolbarTool === "paint" || activeToolbarTool === "erase") &&
						focusedPane.getFocusedPane() === "coronal" && (
							<div
								className="vp-brush-preview"
								style={{
									width: diameterMm * getPanePxPerMm(coronal_ref.current),
									height: diameterMm * getPanePxPerMm(coronal_ref.current),
								}}
							/>
						)}
					</div>

					<div className={`render ${loading ? "" : "vp-pane vp-pane--render"}`} data-label="3D" style={{ ...panelStyle("3d"), ...paneGridStyle("3d") }}>
						<div className="canvas">
							{threeDMode === "volume" ? (
								volume3DFailed ? (
									<div className="vp-3d-empty">
										Volume rendering isn't available here
										<span>(needs GPU/WebGL rendering)</span>
									</div>
								) : (
									// Shaded ray-cast rendering of the CT itself (Cornerstone VOLUME_3D).
									<div className="vp-vol3d" ref={volume3DRef} />
								)
							) : isLocal ? (
								// Meshes come from the case's segmentation on the server — a local
								// DICOM scan has none.
								<div className="vp-3d-empty">
									No organ meshes for local DICOM
									<span>(switch to Volume rendering above)</span>
								</div>
											) : (
								<SegmentationMeshViewer caseId={caseId} isSession={!!sessionId && !pantsCase} crosshairMm={crosshairMm} checkState={meshCheckState} loading={loading} opacity={opacityValue} customOrgans={customOrgans} labelColorMap={labelColorMap} />
							)}
						</div>
						{!loading && (
							<div className="vp-3dbar">
								{!isLocal && (
									<button
										className={`vp-3dbar__btn ${threeDMode === "mesh" ? "is-active" : ""}`}
										onClick={() => setThreeDMode("mesh")}
									>
										Meshes
									</button>
								)}
								<button
									className={`vp-3dbar__btn ${threeDMode === "volume" ? "is-active" : ""}`}
									onClick={() => {
										setThreeDMode("volume");
										sessionRef.current?.log("view", "Switched 3D pane to volume rendering");
									}}
								>
									Volume
								</button>
								{threeDMode === "volume" && !volume3DFailed && (
									<span className="vp-3dbar__presets">
										{volume3DPresets.map((preset) => (
											<button
												key={preset.name}
												className={`vp-3dbar__btn vp-3dbar__btn--preset ${volumePreset === preset.name ? "is-active" : ""}`}
												onClick={() => setVolumePreset(preset.name)}
											>
												{preset.label}
											</button>
										))}
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
			{liveRoom && liveRoomDockOpen && (
				<LiveRoomDock
					room={liveRoom}
					crosshair={crosshairMm}
					activePlane={focusedPane.getFocusedPane()}
					onClose={() => setLiveRoomDockOpen(false)}
				/>
			)}
			{soloChallenge && soloChallenge.taskDockOpen && (
				<SoloChallengeDock
					controller={soloChallenge}
					crosshair={crosshairMm}
					measurement={challengeLengthMeasurement}
					serializedMeasurement={serializedChallengeMeasurement}
					onSetMarker={() => {
						if (crosshairMm) soloChallenge.setMarker([...crosshairMm]);
					}}
					onActivateMeasure={() => {
						setCrosshairToolActive(false);
						setActiveMeasureTool(LENGTH_TOOL);
					}}
					onSubmit={() => void soloChallenge.submit(serializedChallengeMeasurement)}
				/>
			)}
			{quizPractice && quizPractice.dockOpen && (
				<QuizPracticeDock controller={quizPractice} />
			)}
			</div>
			{hoverOrganTip.visible && (
				<div
					className="vp-organ-tip"
					style={{ left: hoverOrganTip.x, top: hoverOrganTip.y, borderLeftColor: hoverOrganTip.color }}
				>
					<span className="vp-organ-tip__swatch" style={{ background: hoverOrganTip.color }} />
					{hoverOrganTip.text}
				</div>
			)}

			{showStats && (
				<div className="vp-stats">
					<div className="vp-stats__head">
						<span className="vp-panel__title">Organ Statistics</span>
						<div className="vp-stats__actions">
							{statRows.length > 0 && (
								<>
									<button
										className="vp-stats__export"
										onClick={() => downloadStats(statRows, "csv", caseId)}
										title="Download as CSV"
									>
										CSV
									</button>
									<button
										className="vp-stats__export"
										onClick={() => downloadStats(statRows, "json", caseId)}
										title="Download as JSON"
									>
										JSON
									</button>
								</>
							)}
							<button
								className="vp-stats__close"
								onClick={() => setShowStats(false)}
								aria-label="Close organ statistics"
							>
								×
							</button>
						</div>
					</div>
					{statsLoading ? (
						<div className="vp-stats__msg">Computing…</div>
					) : statsError ? (
						<div className="vp-stats__msg">
							Organ statistics aren't available for this case here.
							<br />
							<span style={{ opacity: 0.7 }}>
								(They're computed from the dataset volumes on the server.)
							</span>
						</div>
					) : statRows.length > 0 ? (
						<>
							{flaggedOrgans.length > 0 && (
								<div className="vp-stats__summary">
									<strong>{flaggedOrgans.length}</strong>{" "}
									{flaggedOrgans.length === 1 ? "organ" : "organs"} outside the p5–p95 range:{" "}
									{flaggedOrgans
										.map((o) => `${o.label} (p${Math.round(o.percentile)})`)
										.join(", ")}
								</div>
							)}
							<div className={`vp-stats__table${organNorms ? " vp-stats__table--pct" : ""}`}>
								<div className="vp-stats__row vp-stats__row--head">
									<span>Organ</span>
									<span>Volume</span>
									<span>Mean HU</span>
									{organNorms && <span title="Volume percentile vs the dataset">%ile</span>}
								</div>
								{statRows.map((r, i) => {
									const flagged = r.percentile !== null && (r.percentile < 5 || r.percentile > 95);
									const expanded = expandedStatRow === i;
									return (
										<React.Fragment key={`${r.organ_name}-${i}`}>
											<div
												className={`vp-stats__row vp-stats__row--expandable${i % 2 === 1 ? " vp-stats__row--odd" : ""}`}
												role="button"
												tabIndex={0}
												aria-expanded={expanded}
												onClick={() => setExpandedStatRow(expanded ? null : i)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														setExpandedStatRow(expanded ? null : i);
													}
												}}
											>
												<span>
													<span className={`vp-stats__chevron${expanded ? " vp-stats__chevron--open" : ""}`}>
														›
													</span>
													{r.label}
													{r.truncated && (
														<span className="vp-stats__truncated-flag" title="Mask reaches the volume edge — metrics may be clipped">
															⚠
														</span>
													)}
												</span>
												<span>{r.volume_cm3 === null || r.truncated ? "NA" : `${Math.round(r.volume_cm3)} cm³`}</span>
												<span>{r.mean_hu === null ? "NA" : Math.round(r.mean_hu)}</span>
												{organNorms && (
													<span
														className={`vp-stats__pct${flagged ? " vp-stats__pct--flag" : ""}`}
														title={
															r.percentile !== null
																? `${Math.round(r.percentile)}th percentile vs ${describeBasis(r.basis as string)} (n=${r.n})`
																: "No reference group for this organ"
														}
													>
														{r.percentile !== null ? (
															<>
																<span className="vp-stats__pctnum">p{Math.round(r.percentile)}</span>
																<PercentileBar percentile={r.percentile} flagged={flagged} />
															</>
														) : (
															"—"
														)}
													</span>
												)}
											</div>
											{expanded && (
												<div className="vp-stats__detail">
													<div className="vp-stats__detail-item">
														<span>Median HU</span>
														<span>{fmtStat(r.median)}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Std Dev HU</span>
														<span>{fmtStat(r.standard_deviation)}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Min HU</span>
														<span>{fmtStat(r.min_value)}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Max HU</span>
														<span>{fmtStat(r.max_value)}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Skewness</span>
														<span>{fmtStat(r.skewness, 2)}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Kurtosis</span>
														<span>{fmtStat(r.kurtosis, 2)}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Voxel Count</span>
														<span>{r.voxel_count === null || r.truncated ? "—" : r.voxel_count.toLocaleString()}</span>
													</div>
													<div className="vp-stats__detail-item">
														<span>Truncated</span>
														<span>{r.truncated ? "Yes" : "No"}</span>
													</div>
												</div>
											)}
										</React.Fragment>
									);
								})}
							</div>
						</>
					) : (
						<div className="vp-stats__msg">No organ data available.</div>
					)}
				</div>
			)}

			{showMetadata && (
				<div className="vp-stats">
					<div className="vp-stats__head">
						<span className="vp-panel__title">Case Metadata</span>
						<button
							className="vp-stats__close"
							onClick={() => setShowMetadata(false)}
							aria-label="Close case metadata"
						>
							×
						</button>
					</div>
					{!pantsCase ? (
						<div className="vp-stats__msg">
							Case metadata is only available for dataset cases.
						</div>
					) : !caseMetadata ? (
						<div className="vp-stats__msg">
							{demographicsTriedRef.current
								? "No metadata available for this case."
								: "Loading…"}
						</div>
					) : (
						<div className="vp-meta__list">
							{METADATA_FIELDS.map(({ key, label }, i) => (
								<div className={`vp-meta__row${i % 2 === 1 ? " vp-meta__row--odd" : ""}`} key={key}>
									<span className="vp-meta__label">{label}</span>
									<span className="vp-meta__value">
										{formatMetaValue(key, caseMetadata[key])}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{showMeasurePanel && (
				<MeasurementPanel
					onClose={() => setShowMeasurePanel(false)}
					onJump={(mm) => setCrosshairMm(mm)}
				/>
			)}
			{/* Kept mounted (display toggles) so the chat history survives open/close. */}
			{!soloChallenge && liveRoom?.metadata.mode !== "quiz" && <AISidebar
				open={showAISidebar}
				onClose={() => setShowAISidebar(false)}
				caseId={String(caseId)}
				sessionId={sessionId}
				availableOrgans={aiAvailableOrgans}
				viewerState={{
					view: viewMode,
					opacity: opacityValue,
					windowWidth,
					windowCenter,
					zoomLevel,
				}}
				organMetrics={organStats ?? []}
				demographics={demographics}
				actions={aiActions}
				captureViewport={captureAllViews}
				getMaskLegend={getMaskLegend}
				onResize={applyAiWidth}
				onResizeEnd={commitAiWidth}
				/>}
			{/* Full-screen blurred loading overlay while the Annotate button's
				forced HD upgrade is in flight (see handleAnnotateClick). The
				annotation toolbar and SegmentsPopup stay closed (both gated
				on showAnnotationToolbar) until this resolves, so there's
				never a window where the ribbon is up but painting would hit
				the still-low-res segmentation grid. */}
			{annotateHdLoading && (
				<div className="vp-annotate-hd-overlay" role="status" aria-live="polite">
					<div className="vp-annotate-hd-overlay__spinner" aria-hidden="true" />
					<div className="vp-annotate-hd-overlay__label">
						Loading HD resolution{enhance.state === "streaming" && enhance.pct != null ? ` — ${enhance.pct}%` : "…"}
					</div>
				</div>
			)}
			<AnnotationToolbar
				open={showAnnotationToolbar}
				// So the ribbon can draw its little pointer arrow back up to
				// the pencil button that opened it (see the pointer-tracking
				// effect in AnnotationToolbar.tsx).
				anchorRef={annotatePencilRef}
				hasSegments={hasSegments}
				hasActiveTarget={hasActiveTarget}
				activeTool={activeToolbarTool}
				onToolChange={handleToolbarToolChange}
				diameterMm={diameterMm}
				onDiameterChange={handleDiameterChange}
				onDiameterPreviewChange={setBrushPreviewActive}
				scissorsOptions={scissorsOptions}
				onScissorsOptionsChange={setScissorsOptions}
				renderFlyout={renderAnnotationFlyout}
				scissorsPointCount={scissors.anchorsCanvas.length}
				onScissorsCancel={scissors.cancel}
				targetKey={activeCatalogOrganId ?? activeSegment}
				popupRef={annotationPopupRef}
				popupDragRef={annotationPopupDragRef}
				popupMinRef={annotationPopupMinRef}
				sliceJumpRef={sliceJumpWrapRef}
			/>
			{/* Point/box-segment SUCCESS/ERROR overlay. Reuses the exact same centered
			    GuidedStepModal (blurred backdrop + "Got it") that Copy across
			    slices/Fill between slices use for their own success step,
			    rather than a small bottom-of-screen pill — consistent with
			    every other guided-flow tool's confirmation. Rendered once
			    globally (not per-pane, since a point-prompt submit doesn't
			    stay anchored to one pane the way a box-drag does). */}
			{(pointSegment.status === "success" || pointSegment.status === "error" ||
			  boxSegment.status === "success" || boxSegment.status === "error") && (() => {
				const active =
					pointSegment.status === "success" || pointSegment.status === "error"
						? pointSegment
						: boxSegment;
				return (
					<GuidedStepModal
						title={active.status === "success" ? "Success" : "No change"}
						instruction={active.statusMessage ?? ""}
						primaryLabel="Got it"
						onPrimary={active.dismissStatus}
					/>
				);
			})()}
			<SegmentsPopup
				open={showAnnotationToolbar}
				segments={customOrgans}
				colors={segmentColorsHex}
				visibility={segmentVisibility}
				activeSegmentId={activeSegment}
				onSelect={(id) => {
					setActiveSegment(id);
					setActiveCatalogOrganId(null);
					if (id != null) jumpCrosshairToSegmentCentroid(id);
				}}
				onRename={handleRenameSegment}
				onColorChange={handleSegmentColorChange}
				onToggleVisibility={handleToggleSegmentVisibility}
				onDelete={handleDeleteSegment}
				onCreate={handleCreateClass}
				organCatalog={organCatalog}
				activeCatalogOrganId={activeCatalogOrganId}
				onSelectCatalogOrgan={handleSelectCatalogOrgan}
				containerRef={annotationPopupRef}
				dragHandleRef={annotationPopupDragRef}
				minButtonRef={annotationPopupMinRef}
				showOnlyTargetMask={showOnlyTargetMask}
				onShowOnlyTargetMaskChange={setShowOnlyTargetMask}
				hasActiveTarget={hasActiveTarget}
			/>
			{/* A failed or stalled volume must never leave a reader on a black screen. */}
			{dicomError && (
				<div className="vp-loading" role="alert">
					<div className="flex flex-col items-center gap-4" style={{ maxWidth: 420, textAlign: "center" }}>
						<div className="vp-loading__text">{dicomError}</div>
						{isLocal ? (
							<button className="vp-btn" onClick={() => { window.location.href = "/upload"; }}>
								Back to upload
							</button>
						) : (
							<div className="flex gap-3">
								<button className="vp-btn" onClick={() => { window.location.reload(); }}>
									Retry case
								</button>
								<button className="vp-btn" onClick={() => { window.location.href = "/dashboard"; }}>
									Back to dataset
								</button>
							</div>
						)}
					</div>
				</div>
			)}

			{readingSession && (
				<SessionHUD
					session={readingSession}
					onSnapshot={() => { void takeSnapshot(); }}
					onStop={() => { void stopReadingSession(); }}
				/>
			)}

			{sessionResult && (
				<SessionSummary
					result={sessionResult}
					measurements={sessionMeasurements}
					onDiscard={() => setSessionResult(null)}
				/>
			)}

			{
				showReportScreen && (
					<ReportScreen
						id={caseId}
						onClose={() => {
							setShowReportScreen(false);
							handleClearIsolation();
							setViewMode("mpr");
						}}
						onOrganHighlight={handleOrganHighlight}
						onClearHighlight={handleClearIsolation}
						onHideOrgans={handleHideOrgans}
						onViewChange={(view) => setViewMode(view as ViewMode)}
					/>
				)
			}

			{!liveRoom && params.caseId && (
				<LiveRoomCreateDialog
					caseId={params.caseId}
					open={showLiveRoomCreate}
					onClose={() => setShowLiveRoomCreate(false)}
				/>
			)}

			{liveRoom?.connectionState === "expired" && (
				<div className="lr-room-ended" role="alert">
					<div>
						<h2>Live Room expired</h2>
						<p>Temporary room data was deleted. Canonical dataset case remains unchanged.</p>
						<a className="lr-button lr-button--primary" href={`/case/${liveRoom.metadata.case_id}`}>Return to case</a>
					</div>
				</div>
			)}

		</div >
	);
}

export default VisualizationPage;
