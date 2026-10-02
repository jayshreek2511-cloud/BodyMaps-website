import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
	IconBrush,
	IconEraser,
	IconScissors,
	IconRipple,
	IconArrowsDiagonal,
	IconDroplet,
	IconMathFunction,
	IconWand,
	IconStack2,
	IconCopy,
	IconWaveSine,
	IconCircleDashed,
	IconClick,
	IconBoxModel2,
} from "@tabler/icons-react";
import "./AnnotationToolbar.css";
import NumberSliderField from "../NumberSliderField";
import { FlyoutArrow, FlyoutPanel, MenuColumn, MenuRow, MenuDivider, useFlyout } from "./FlyoutPrimitives";
import type { GuidedFlowControls } from "../segmentation/SliceAnchorPickerUI";

// sessionStorage keys: once the overview tour (or first-target hint) has
// been seen, it won't auto-open again FOR THE REST OF THIS TAB SESSION.
// Deliberately sessionStorage rather than localStorage — these are meant to
// re-appear on every fresh page load/reload, not just once ever per browser.
const OVERVIEW_WALKTHROUGH_SEEN_KEY = "mm_annotation_walkthrough_seen";
// Guided-flow (Continue / Start over / Exit) explainer. Each guided tool
// (Grow from Seeds, Copy across slices, Fill between slices, Islands) gets
// its OWN "seen" flag — so seeing the explainer for one doesn't suppress it
// for the others — even though several of them share the same wording.
const GUIDED_HINT_SEEN_KEY_PREFIX = "mm_annotation_guided_hint_seen_";

export type PrimaryEditTool =
	| "paint" | "erase" | "scissors" | "levelTracing"
	| "margin" | "smoothing" | "islands" | "logicalOperators"
	| "growFromSeeds" | "fillBetweenSlices" | "copyAcrossSlices" | "hollow"
	| "pointSegment" | "boxSegment"
	| null;
export type ScissorsOperation = "eraseInside" | "eraseOutside" | "fillInside" | "fillOutside";
export type ScissorsSliceCut = "unlimited" | "positive" | "negative" | "symmetric";

export interface ScissorsOptions {
	operation: ScissorsOperation;
	/** When on, each placed point snaps to the nearest strong intensity edge
	 *  within a small radius (like Photoshop's magnetic lasso). */
	magnetEnabled?: boolean;
}

interface AnnotationToolbarProps {
	open: boolean;
	hasSegments: boolean;
	hasActiveTarget: boolean;
	activeTool: PrimaryEditTool;
	onToolChange: (tool: PrimaryEditTool) => void;
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	onDiameterPreviewChange?: (active: boolean) => void;
	scissorsOptions: ScissorsOptions;
	onScissorsOptionsChange: (opts: ScissorsOptions) => void;
	scissorsPointCount: number;
	onScissorsCancel: () => void;

	/** Id of whatever class/organ is currently targeted. Not used for editing
	 *  logic here — only watched so the ribbon can deselect the active tool
	 *  when the target changes (see the reset effect below). */
	targetKey: number | null;

	// `onApplied`: one-shot tools (margin, smoothing, islands, logical
	// operators, grow-from-seeds, hollow, ...) call this once their Apply
	// button runs, to deselect the tool (see LIVE_COMMIT_TOOLS for tools that
	// skip this). `onCloseSettings` closes just the settings flyout without
	// deselecting the tool — used by level tracing (auto-close on mode pick)
	// and the guided-overlay tools (close once their full-screen walkthrough
	// takes over).
	renderFlyout: (tool: Exclude<PrimaryEditTool, null>, onApplied: () => void, onCloseSettings: () => void, onGuidedControlsChange: (controls: GuidedFlowControls | null) => void) => React.ReactNode;
	/** Fired whenever a guided slice-anchor pick flow (Copy/Fill across
	 *  slices) becomes active or finishes — true for the flow's entire
	 *  lifecycle (both click steps, the ready-to-apply confirm, and while
	 *  committing), not just the literal picking sub-phase, since the
	 *  crosshair shouldn't be live for any of it: clicking a pane during a
	 *  guided pick is meant to choose a slice/anchor, not move the
	 *  crosshair. The caller (VisualizationPage) uses this to suppress
	 *  Crosshairs for the duration. */
	onGuidedPickingChange?: (active: boolean) => void;

	popupRef?: React.RefObject<HTMLDivElement | null>;
	popupDragRef?: React.RefObject<HTMLDivElement | null>;
	popupMinRef?: React.RefObject<HTMLButtonElement | null>;
	sliceJumpRef?: React.RefObject<HTMLDivElement | null>;

	/** The pencil/Annotate button in the main toolbar (VisualizationPage)
	 *  that opens this ribbon. The ribbon itself renders as a centered
	 *  popout regardless of where that button sits, but this ref lets it
	 *  draw a small pointer arrow back up to the button — see the
	 *  pointer-tracking effect below and .atb--horizontal__pointer. */
	anchorRef?: React.RefObject<HTMLElement | null>;

}

const TOOL_DEFS: Array<{ id: Exclude<PrimaryEditTool, null>; label: string; Icon: typeof IconBrush; description: string }> = [	
	{ id: "paint", label: "Brush", Icon: IconBrush, description: "Paint freehand with a round brush." },
	{ id: "erase", label: "Erase", Icon: IconEraser, description: "Erase parts of a shape manually." },
	{ id: "scissors", label: "Scissors", Icon: IconScissors, description: "Lasso tool using anchor points." },
	{ id: "levelTracing", label: "Level Tracing", Icon: IconRipple, description: "Traces the boundary of similar intensity around cursor." },
	{ id: "margin", label: "Margin", Icon: IconArrowsDiagonal, description: "Grow or shrink by a specified margin size." },
	{ id: "smoothing", label: "Smoothing", Icon: IconWaveSine, description: "Smooth class boundaries." },
	{ id: "islands", label: "Islands", Icon: IconDroplet, description: "Edit islands (connected components) in a class." },
	{ id: "logicalOperators", label: "Logical operators", Icon: IconMathFunction, description: "Apply logical operators or combine classes." },
	{ id: "growFromSeeds", label: "Grow from seeds", Icon: IconWand, description: "Grow a class from user-placed scribbles." },
	{ id: "fillBetweenSlices", label: "Fill between slices", Icon: IconStack2, description: "Interpolate a class's shape between two annotated slices." },
	{ id: "copyAcrossSlices", label: "Copy across slices", Icon: IconCopy, description: "Copy a class's shape from first to last slice." },
	{ id: "hollow", label: "Hollow", Icon: IconCircleDashed, description: "Make the class hollow by replacing it with a uniform-thickness shell." },
	{ id: "pointSegment", label: "AI Point Segment", Icon: IconClick, description: "Click a point to propose an AI segmentation for the active class." },
	{ id: "boxSegment", label: "AI Box Segment", Icon: IconBoxModel2, description: "Draw a 2D bounding box to propose an AI segmentation for the active class." },
];

const SCISSORS_OPERATIONS: { value: ScissorsOperation; label: string }[] = [
	{ value: "eraseInside", label: "Erase inside" },
	{ value: "eraseOutside", label: "Erase outside" },
	{ value: "fillInside", label: "Fill inside" },
	{ value: "fillOutside", label: "Fill outside" },
];

// Tools that don't have an ApplyButton — they commit directly on pointer
// interaction, so the rendering dot is the only feedback available.
const LIVE_COMMIT_TOOLS: Exclude<PrimaryEditTool, null>[] = ["paint", "erase", "scissors", "levelTracing", "pointSegment", "boxSegment"];

const MIN_DIAMETER_MM = 2;
const MAX_DIAMETER_MM = 40;

// Which "explain Continue / Start over / Exit" message a guided tool falls
// under. Grow from Seeds gets its own copy; the slice-range tools (Copy/Fill
// across slices) and Islands' pick-based ops (Remove picked/Keep picked)
// all drive the exact same three controls, so they share one message keyed
// off a single "seen" flag rather than repeating the popup three times.
type GuidedHintGroup = "growSeeds" | "sliceOps";
function guidedHintGroup(tool: PrimaryEditTool): GuidedHintGroup | null {
	if (tool === "growFromSeeds") return "growSeeds";
	if (tool === "copyAcrossSlices" || tool === "fillBetweenSlices" || tool === "islands") return "sliceOps";
	return null;
}
const GUIDED_HINT_COPY: Record<GuidedHintGroup, string> = {
	growSeeds:
		"Continue moves on once you've placed your seed scribbles. Start over clears every seed and lets you begin again. Exit leaves Grow from Seeds without changing anything.",
	sliceOps:
		"Start over clears any choices made and lets you pick again. Exit leaves the tool without changing anything.",
};

// Ribbon height, matches --atb-ribbon-h in CSS. Exported so SegmentsPopup
// can dock directly beneath the ribbon without duplicating the constant.
export const ANNOTATION_DOCK_WIDTH = 60;

function MagnetIcon({ active: _active }: { active?: boolean }) {
	// Always white — this row's background never goes solid light like an
	// .is-active MenuRow, so a dark stroke would be invisible here.
	const stroke = "#fff";
	return (
		<svg width="16" height="16" viewBox="0 0 20 20" fill="none">
			<path
				d="M6 3 L6 10 A4 4 0 0 0 14 10 L14 3"
				stroke={stroke}
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<path d="M6 3 H3 V7 H6" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
			<path d="M14 3 H17 V7 H14" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
			<path d="M2.5 12.5 L4.5 11.2 M17.5 12.5 L15.5 11.2" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
		</svg>
	);
}

function DiameterFlyout({
	title, diameterMm, onDiameterChange, onPreviewChange, fieldRef,
}: {
	title: string;
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	onPreviewChange?: (active: boolean) => void;
	/** Wraps the slider field so the walkthrough can spotlight its live rect. */
	fieldRef?: React.RefObject<HTMLDivElement>;
}) {
	return (
		<div className="seg-effect">
			<div ref={fieldRef}>
				<NumberSliderField
					label={title}
					value={diameterMm}
					onChange={onDiameterChange}
					min={MIN_DIAMETER_MM}
					max={MAX_DIAMETER_MM}
					step={0.5}
					unit="mm"
					ariaLabel={`${title} diameter`}
					onPreviewChange={onPreviewChange}
				/>
			</div>
		</div>
	);
}

function ScissorsFlyout({ options, onChange, onCloseSettings }: {
	options: ScissorsOptions;
	onChange: (opts: ScissorsOptions) => void;
	pointCount: number;
	onCancel: () => void;
	/** Closes the Scissors settings flyout once an operation is picked;
	 *  scissors itself stays equipped. */
	onCloseSettings: () => void;
}) {
	const set = <K extends keyof ScissorsOptions>(key: K, value: ScissorsOptions[K]) =>
		onChange({ ...options, [key]: value });

	// Brief "picked" state on the row before the settings flyout collapses.
	const pickOperation = (op: ScissorsOperation) => {
		set("operation", op);
		window.setTimeout(() => onCloseSettings(), 320);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 190 }}>
			<MenuColumn>
				<label className="atb-menu-row atb-menu-row--checkbox" title="Snap each point to the nearest strong intensity edge, like Photoshop's magnetic lasso">
					<span className="atb-menu-row__label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<MagnetIcon active={options.magnetEnabled} />
						Magnetic snap
					</span>
					<input
						type="checkbox"
						className="atb-menu-row__checkbox-input"
						// Undefined (never touched) reads as ON — the default people
						// want nearly all the time — while an explicit false (user
						// unchecked it) is respected.
						checked={options.magnetEnabled !== false}
						onChange={(e) => set("magnetEnabled", e.target.checked)}
					/>
				</label>
			</MenuColumn>

			<MenuDivider />

			<MenuColumn>
				{SCISSORS_OPERATIONS.map((op) => (
					<MenuRow
						key={op.value}
						label={op.label}
						// Reflects `options.operation` directly (not some local
						// "just picked" flag), so re-opening later always shows
						// the operation that's actually active.
						open={op.value === options.operation}
						onClick={() => pickOperation(op.value)}
					/>
				))}
			</MenuColumn>
		</div>
	);
}



// Portal-rendered tooltip — rendered to document.body and positioned via
// getBoundingClientRect of the hovered icon, so it's never clipped by the
// dock's own overflow:hidden/auto rules.
function IconTooltip({
	label, description, anchorRect,
}: {
	label: string;
	description: string;
	anchorRect: DOMRect | null;
}) {
	if (!anchorRect) return null;
	// Tooltip is centered above its icon by default (so it reads as an
	// annotation on the icon rather than colliding with whatever settings
	// flyout opens below the ribbon), but that puts it offscreen for icons
	// near either edge (Brush on the left, Hollow on the right) — clamp the
	// center point so the box (max-width 240) always stays fully within the
	// viewport, with a small margin.
	const halfWidth = 120;
	const margin = 8;
	const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
	const idealCenter = anchorRect.left + anchorRect.width / 2;
	const clampedCenter = Math.min(
		Math.max(idealCenter, halfWidth + margin),
		viewportWidth - halfWidth - margin
	);
	return createPortal(
		<div
			style={{
				position: "fixed",
				top: anchorRect.top - 10,
				left: clampedCenter,
				transform: "translate(-50%, -100%)",
				background: "#fff",
				color: "#111",
				borderRadius: 8,
				padding: "8px 10px",
				minWidth: 160,
				maxWidth: 240,
				boxShadow: "0 8px 24px -6px rgba(0,0,0,0.45)",
				zIndex: 500,
				pointerEvents: "none",
				fontFamily: "system-ui, sans-serif",
				whiteSpace: "normal",
			}}
		>
			<div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 2 }}>{label}</div>
			<div style={{ fontSize: 11.5, lineHeight: 1.35, color: "#333" }}>{description}</div>
		</div>,
		document.body
	);
}

export default function AnnotationToolbar({
	open, hasSegments, hasActiveTarget, activeTool, onToolChange,
	diameterMm, onDiameterChange, onDiameterPreviewChange, scissorsOptions, onScissorsOptionsChange,
	renderFlyout, scissorsPointCount, onScissorsCancel,
	targetKey,
	popupRef, popupDragRef, popupMinRef, onGuidedPickingChange, anchorRef,
}: AnnotationToolbarProps) {
	const [hoveredTool, setHoveredTool] = useState<string | null>(null);
	const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
	const iconRefs = useRef<Record<string, HTMLElement | null>>({});
	// Just the icon <button> itself, keyed the same as iconRefs — needed
	// only for LIVE_COMMIT_TOOLS, whose wrapper div also contains the
	// separate FlyoutArrow chevron beside the icon. Anchoring the settings
	// flyout to that wrapper (as iconRefs alone would) meant the computed
	// center included the arrow's own width, so the flyout's pointer sat
	// visibly right of the icon's true center instead of directly under
	// it. Anchoring to the icon button alone keeps the pointer centered on
	// the icon regardless of the arrow sitting beside it.
	const btnRefs = useRef<Record<string, HTMLElement | null>>({});

	// --- Walkthrough ----------------------------------------------------------
	// One overview tour that auto-opens on first visit (see effect below).
	const [overviewWalkthroughOpen, setOverviewWalkthroughOpen] = useState(false);
	// "Pick a class first" hint — shown when a disabled tool icon is clicked
	// (disabled buttons don't fire onClick, so this replaces that silent no-op).
	const [pickClassHintOpen, setPickClassHintOpen] = useState(false);
	const [pickClassHintRect, setPickClassHintRect] = useState<DOMRect | null>(null);
	// "Explain Continue/Start over/Exit" — shown the first time a guided flow
	// (Grow from Seeds, Copy/Fill-across-slices, Islands' pick ops) actually
	// surfaces those controls, once per flow family per session.
	const [guidedHintOpen, setGuidedHintOpen] = useState(false);
	const [guidedHintRect, setGuidedHintRect] = useState<DOMRect | null>(null);
	const [guidedHintText, setGuidedHintText] = useState<string>("");
	const guidedControlsBoxRef = useRef<HTMLDivElement>(null);
	const prevGuidedControlsRef = useRef<GuidedFlowControls | null>(null);
	const [, setPanelRect] = useState<DOMRect | null>(null);
	const [, setPanelDragRect] = useState<DOMRect | null>(null);
	const [, setDockRect] = useState<DOMRect | null>(null);
	const [, setDockDragRect] = useState<DOMRect | null>(null);
	const [, setDockMinRect] = useState<DOMRect | null>(null);
	const [, setPanelMinRect] = useState<DOMRect | null>(null);
	// Measured from refs the parent (VisualizationPage) hands in, since the
	// popup and slice-jump overlay live outside this component.
	const [, setPopupRectMeasured] = useState<DOMRect | null>(null);
	const [, setPopupDragRectMeasured] = useState<DOMRect | null>(null);
	const [, setPopupMinRectMeasured] = useState<DOMRect | null>(null);

	const fieldRef = useRef<HTMLDivElement>(null);
	const panelBodyRef = useRef<HTMLDivElement>(null);
	// Unstyled inner wrapper measured for --atb-panel-h (see JSX usage below
	// for why measuring the styled body directly caused runaway growth).
	const panelBodyContentRef = useRef<HTMLDivElement>(null);
	const panelMinRef = useRef<HTMLButtonElement>(null);
	const dockElRef = useRef<HTMLDivElement>(null);
	// Unstyled inner wrapper measured for --atb-ribbon-h. Observing the
	// styled dock element itself (which has `min-height: var(--atb-ribbon-h)`)
	// would be self-referential and grow without bound.
	const dockContentRef = useRef<HTMLDivElement>(null);
	const dockDragRef = useRef<HTMLDivElement>(null);

	// Measures the ribbon's real height into --atb-ribbon-h (consumed by
	// VisualizationPage.css to reserve space above the CT viewport), since a
	// hardcoded value drifts as row contents change.
	// useLayoutEffect so it lands before paint, avoiding a one-frame flash of
	// the CSS fallback height. Math.ceil + 1px pad absorbs sub-pixel rounding.
	useLayoutEffect(() => {
		const el = dockContentRef.current;
		if (!el) return;
		const sync = () => {
			const h = Math.ceil(el.getBoundingClientRect().height) + 1;
			document.documentElement.style.setProperty("--atb-ribbon-h", `${h}px`);
		};
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(el);
		return () => ro.disconnect();
		// `open` is a dependency (not `[]`) so this re-runs and picks up the
		// real element once the ribbon actually mounts.
	}, [open]);

	// Pointer-arrow tracking — keeps the little up-chevron
	// (.atb--horizontal__pointer) aligned under the pencil button and just
	// above the ribbon, regardless of where the screen-centered ribbon or
	// the button end up (window resizes, sidebar open/close reflowing the
	// main toolbar, etc). Stored as fixed viewport coordinates (not an
	// offset within the ribbon) since the chevron is rendered as a sibling
	// of the ribbon — see the render comment below for why. `null` hides
	// the chevron entirely rather than falling back to a guessed position,
	// since a wrong guess would point at nothing.
	// Size of the little rotated-square notch below, so the position math
	// and the CSS agree on how far it should straddle the ribbon's own
	// top border (half on each side, same technique FlyoutPrimitives uses
	// for `.atb-pop__pointer`).
	const POINTER_NOTCH_SIZE = 13;
	const [pointerPos, setPointerPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (!open) return;
		const sync = () => {
			const anchorEl = anchorRef?.current;
			const ribbonEl = dockElRef.current;
			if (!anchorEl || !ribbonEl) { setPointerPos(null); return; }
			const anchorRect = anchorEl.getBoundingClientRect();
			const ribbonRect = ribbonEl.getBoundingClientRect();
			const anchorCenterX = anchorRect.left + anchorRect.width / 2;
			// Clamped inside the ribbon's own horizontal bounds (with a
			// little inset) so a pencil button sitting far to one side
			// never pushes the notch off the ribbon's rounded corner.
			const left = Math.min(
				Math.max(anchorCenterX, ribbonRect.left + 14),
				ribbonRect.right - 14,
			);
			// Sits ON the ribbon's own top border (straddling it, half
			// above/half below) rather than floating free in the gap
			// above the ribbon — this is what actually reads as "grown
			// out of the ribbon" the way FlyoutPanel's own pointer grows
			// out of a settings flyout, instead of a separate decoration
			// hovering between the button and the ribbon with visible
			// space on both sides.
			setPointerPos({ left, top: ribbonRect.top - POINTER_NOTCH_SIZE / 2 });
		};
		sync();
		window.addEventListener("resize", sync);
		// Anchor and ribbon can both move without a window resize (e.g. the
		// AI sidebar toggling shifts the main toolbar's layout), so re-check
		// on any observed size change of either element too.
		const ro = new ResizeObserver(sync);
		if (anchorRef?.current) ro.observe(anchorRef.current);
		if (dockElRef.current) ro.observe(dockElRef.current);
		return () => {
			window.removeEventListener("resize", sync);
			ro.disconnect();
		};
	}, [open, anchorRef]);

	// The per-tool settings panel floats over the viewer (anchored under
	// whichever icon opened it — see `toolFlyout` below), so it never needs
	// to reserve space below the ribbon.
	useEffect(() => {
		document.documentElement.style.setProperty("--atb-panel-h", "0px");
	}, []);

	// Settings flyout — the small rectangle that opens under a tool's arrow.
	// Only one tool's settings are open at a time, always for whichever tool
	// is active. Guided-overlay tools (Grow-from-Seeds, Fill/Copy-Across-
	// Slices) render `keepMounted` (see GUIDED_OVERLAY_TOOLS above), so an
	// outside click here just hides the box without tearing down their state.
	// Mirrored into a ref so the outside-click handler below (created before
	// `guidedControls` state exists in source order) always reads the latest
	// published guided flow.
	const guidedControlsRef = useRef<GuidedFlowControls | null>(null);

	const toolFlyout = useFlyout(false, {
		scope: "top",
		// Outside click = full deselect for most tools. For a guided-overlay
		// tool, route through its own Exit handler so scribbles/anchors/picks
		// get cleared too. LIVE_COMMIT_TOOLS (brush, erase, scissors, level
		// tracing/"smart fill") are the exception: an outside click there
		// should only close the settings flyout — the icon stays selected
		// (white background) because the tool itself is still "live" and
		// ready to paint/cut on the next pointer interaction.
		onOutsideClose: () => {
			if (guidedControlsRef.current) {
				guidedControlsRef.current.onExit();
				return;
			}
			if (activeTool && LIVE_COMMIT_TOOLS.includes(activeTool)) return;
			onToolChange(null);
		},
	});

	// This component stays mounted while the toolbar is toggled off (see
	// `if (!open) return null` further down), so state has to be reset
	// explicitly on close — otherwise the flyout reopens anchored to a
	// stale/detached icon ref, and the active tool stays visually selected.
	useEffect(() => {
		if (open) return;
		// Exit any running guided flow so placed seeds/anchors/picks clear.
		guidedControlsRef.current?.onExit();
		toolFlyout.setOpen(false);
		toolFlyout.anchorRef.current = null;
		setGuidedControls(null);
		setHoveredTool(null);
		setHoveredRect(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Same reset, triggered by the TARGET changing (e.g. clicking a
	// different class) instead of the toolbar closing. Tracked via a ref so
	// this only fires on an actual change, not on first mount.
	const prevTargetKeyRef = useRef(targetKey);
	useEffect(() => {
		if (prevTargetKeyRef.current === targetKey) return;
		prevTargetKeyRef.current = targetKey;
		if (!open) return; // the toolbar-closed effect above already covers this case
		guidedControlsRef.current?.onExit();
		toolFlyout.setOpen(false);
		setGuidedControls(null);
		setHoveredTool(null);
		setHoveredRect(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetKey, open]);

	const openToolSettings = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!hasSegments || !hasActiveTarget) return;
		if (activeTool !== tool) onToolChange(tool);
		// LIVE_COMMIT_TOOLS anchor to their own icon button (btnRefs) so
		// the flyout centers on the icon, not the wider icon+arrow
		// wrapper — see the btnRefs comment above for why.
		toolFlyout.anchorRef.current = btnRefs.current[tool] ?? iconRefs.current[tool] ?? null;
		toolFlyout.setOpen(true);
	};
	const showTooltip = useCallback((id: string) => {
		const el = iconRefs.current[id];
		setHoveredRect(el ? el.getBoundingClientRect() : null);
		setHoveredTool(id);
	}, []);
	const hideTooltip = useCallback((id: string) => {
		setHoveredTool((cur) => (cur === id ? null : cur));
		setHoveredRect((cur) => (hoveredTool === id ? null : cur));
	}, [hoveredTool]);


	// Recompute every spotlight target while the overview walkthrough is
	// open. Runs on every render while open (cheap: a handful of
	// getBoundingClientRect calls) so it stays correct across panel drags,
	// minimize/expand, and window resizes — none of which have one single
	// event to hook reliably given both panels are freely draggable.
	useLayoutEffect(() => {
		if (!overviewWalkthroughOpen) return;
		const measure = () => {
			setPanelRect(panelBodyRef.current ? panelBodyRef.current.getBoundingClientRect() : null);
			setPanelDragRect(null);
			setDockRect(dockElRef.current ? dockElRef.current.getBoundingClientRect() : null);
			setDockDragRect(dockDragRef.current ? dockDragRef.current.getBoundingClientRect() : null);
			// The dock's minimize button doesn't have its own dedicated ref —
			// it's already tracked in iconRefs (keyed "__min") for the tooltip
			// system, so reuse that instead of threading through a second ref.
			const dockMinEl = iconRefs.current["__min"];
			setDockMinRect(dockMinEl ? dockMinEl.getBoundingClientRect() : null);
			setPanelMinRect(panelMinRef.current ? panelMinRef.current.getBoundingClientRect() : null);
			setPopupRectMeasured(popupRef?.current ? popupRef.current.getBoundingClientRect() : null);
			setPopupDragRectMeasured(popupDragRef?.current ? popupDragRef.current.getBoundingClientRect() : null);
			setPopupMinRectMeasured(popupMinRef?.current ? popupMinRef.current.getBoundingClientRect() : null);
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 200); // catches drag moves without their own event hook
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [overviewWalkthroughOpen, activeTool, popupRef, popupDragRef, popupMinRef]);

	// First-run auto-open: the moment this toolbar is opened (Annotate
	// pressed) with no target picked yet, show the overview tour once per
	// browser. Reopening the dock later (or already having a target) never
	// re-triggers it — there's no manual launcher to bring it back after.
	useEffect(() => {
		if (!open) return;
		if (hasActiveTarget) return;
		let alreadySeen = false;
		try {
			alreadySeen = typeof window !== "undefined" && window.sessionStorage.getItem(OVERVIEW_WALKTHROUGH_SEEN_KEY) === "1";
		} catch { /* sessionStorage unavailable — just show it */ }
		if (!alreadySeen) setOverviewWalkthroughOpen(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Same reasoning as the overview walkthrough's own measuring effect just
	// above: the popup can be dragged, so there's no single event to hook —
	// recompute on a short interval plus resize/scroll while the hint is
	// showing.
	useLayoutEffect(() => {
		if (!pickClassHintOpen) return;
		const measure = () => setPickClassHintRect(popupRef?.current ? popupRef.current.getBoundingClientRect() : null);
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 200);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [pickClassHintOpen, popupRef]);

	// The hint exists to explain why a click didn't do anything — once a
	// class actually gets picked there's nothing left to explain, so don't
	// make the person also remember to dismiss it themselves.
	useEffect(() => {
		if (hasActiveTarget) setPickClassHintOpen(false);
	}, [hasActiveTarget]);

	const dismissPickClassHint = useCallback(() => setPickClassHintOpen(false), []);

	const enabled = hasSegments && hasActiveTarget;

	// LIVE_COMMIT_TOOLS (paint/erase/scissors/level tracing) are "equip and
	// use" tools — clicking them just arms the tool, same as before, and they
	// stay equipped until something else is picked. Every other tool
	// (margin, smoothing, islands, logical operators, grow-from-seeds,
	// hollow, fill/copy across slices) is "click once, configure, apply" —
	// clicking the icon should immediately open its settings flyout right
	// there, the same way clicking Margin already opened its column of
	// options, instead of requiring a second click on the little arrow.
	const selectTool = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!enabled) return;
		if (activeTool === tool) {
			// Clicking the already-active tool again toggles it off entirely
			// (and closes whatever settings were open for it). For a guided
			// flow (Grow-from-Seeds, Fill/Copy-Across-Slices, Islands' pick
			// ops) this needs to be a real Exit — not just a deselect — so
			// any placed seeds/anchors/picks are cleared the same way they
			// would be if Exit had been pressed directly, rather than being
			// silently left behind for the next time this tool is opened.
			if (guidedControlsRef.current) { guidedControlsRef.current.onExit(); return; }
			toolFlyout.setOpen(false);
			onToolChange(null);
			return;
		}
		if (LIVE_COMMIT_TOOLS.includes(tool)) {
			toolFlyout.setOpen(false);
			onToolChange(tool);
		} else {
			openToolSettings(tool);
		}
	};

	// Exit / Start over / Continue for whatever guided modal flow
	// (Grow-from-seeds, Copy/Fill-across-slices, Islands' pick ops) is
	// currently running, published up by the tool itself — rendered as
	// fixed black/white buttons in the ribbon below so they're always in
	// the same place regardless of which guided tool is active, instead of
	// each tool floating its own controls over the canvas.
	const [guidedControls, setGuidedControls] = useState<GuidedFlowControls | null>(null);
	useEffect(() => {
		guidedControlsRef.current = guidedControls;
	}, [guidedControls]);
	useEffect(() => {
		onGuidedPickingChange?.(guidedControls != null);
	}, [guidedControls, onGuidedPickingChange]);

	// Small non-blocking hint shown right next to the cursor when Continue
	// is clicked while `continueDisabled` — e.g. "Mark at least one point
	// first" for Grow-from-seeds before any seed scribble exists. Cleared
	// automatically after a beat, and any time the guided flow becomes
	// unblocked or exits.
	const [continueBlockedHint, setContinueBlockedHint] = useState<{ x: number; y: number; message: string } | null>(null);
	const continueBlockedHintTimeoutRef = useRef<number | null>(null);
	useEffect(() => {
		if (!guidedControls?.continueDisabled) setContinueBlockedHint(null);
	}, [guidedControls?.continueDisabled]);
	useEffect(() => () => {
		if (continueBlockedHintTimeoutRef.current != null) window.clearTimeout(continueBlockedHintTimeoutRef.current);
	}, []);
	useEffect(() => {
		if (!activeTool) setGuidedControls(null);
	}, [activeTool]);

	// Fires once, on the null -> present transition (not on every re-render
	// while a flow is already running), the first time this session that a
	// given guided-flow family actually shows its Continue/Start over/Exit
	// controls. Skipped while `busy` — those controls aren't on screen yet
	// (see the `guidedControls.busy` branch in the render below).
	useEffect(() => {
		const wasPresent = prevGuidedControlsRef.current;
		prevGuidedControlsRef.current = guidedControls;
		if (wasPresent || !guidedControls || guidedControls.busy) return;
		const group = guidedHintGroup(activeTool);
		if (!group || !activeTool) return;
		// Per-tool key (not per-group) — Grow from Seeds having been seen
		// shouldn't suppress the explainer for Copy across slices, Fill
		// between slices, or Islands, and vice versa between those three.
		const seenKey = `${GUIDED_HINT_SEEN_KEY_PREFIX}${activeTool}`;
		let alreadySeen = false;
		try {
			alreadySeen = typeof window !== "undefined" && window.sessionStorage.getItem(seenKey) === "1";
		} catch { /* sessionStorage unavailable — just show it */ }
		if (alreadySeen) return;
		setGuidedHintText(GUIDED_HINT_COPY[group]);
		setGuidedHintOpen(true);
		try {
			if (typeof window !== "undefined") window.sessionStorage.setItem(seenKey, "1");
		} catch { /* not worth blocking on */ }
	}, [guidedControls, activeTool]);

	// Once the flow's controls go away (tool exited/deselected) or flip into
	// `busy` (buttons swap for the "Applying…" indicator), the hint no
	// longer has anything to point at, so close it automatically.
	useEffect(() => {
		if (!guidedControls || guidedControls.busy) setGuidedHintOpen(false);
	}, [guidedControls]);

	useLayoutEffect(() => {
		if (!guidedHintOpen) return;
		const measure = () => setGuidedHintRect(guidedControlsBoxRef.current ? guidedControlsBoxRef.current.getBoundingClientRect() : null);
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 200); // controls sit in a fixed ribbon, but keep parity with the other live-measured hints
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [guidedHintOpen]);

	const dismissGuidedHint = useCallback(() => setGuidedHintOpen(false), []);

	// Signals "applied" from one-shot tool flyouts — closes settings and
	// clears the tool's active highlight, same as clicking the icon again.
	const handleToolApplied = useCallback(() => {
		toolFlyout.setOpen(false);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onToolChange]);

	const activeDef = activeTool ? TOOL_DEFS.find((t) => t.id === activeTool) : null;
	// Portal straight to <body>: VisualizationPage's root has
	// overflow:hidden, which clips fixed-position descendants' paint.
	if (typeof document === "undefined") return null;
	// Stays mounted always and lets CSS (is-open/is-closed) animate it,
	// instead of `open` gating a hard unmount that couldn't animate out.
	return createPortal(
		<>
		{/* Connects the ribbon back to the pencil button that opened it —
			now built the exact same way FlyoutPanel connects its own
			settings panels to the icon/row that spawned them (see
			`.atb-pop__pointer` in FlyoutPrimitives.css): a small square,
			rotated 45°, colored and bordered to match the ribbon itself,
			straddling the ribbon's own top edge so it visibly grows out
			of the ribbon's shape instead of floating as a separate glyph
			in the gap above it (which is what the plain IconChevronUp
			here used to do, and why it never read as "connected").

			Rendered as a SIBLING of `.atb-shell` (not a descendant of it)
			for the same reason as before: `.atb-shell` carries a CSS
			`transform` for its open/close slide + centering, and per spec
			any transformed ancestor becomes the containing block for its
			`position: fixed` descendants — a notch nested inside it would
			have its "fixed" left/top resolved against the shell's own
			box, not the viewport, even though pointerPos below is real
			viewport coordinates from getBoundingClientRect(). Only
			rendered once we have a real measured position, so it never
			flashes at a wrong default location. */}
		{pointerPos !== null && (
			<div
				className="atb--horizontal__pointer"
				style={{ left: pointerPos.left, top: pointerPos.top }}
				aria-hidden="true"
			/>
		)}
		<div className={`atb-shell ${open ? "is-open" : "is-closed"}`}>
		<div
			ref={dockElRef}
			className={`atb atb--horizontal ${!enabled ? "atb--disabled" : ""}`}
			role="toolbar"
			aria-orientation="horizontal"
		>
			<div ref={dockContentRef} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 13}}>
				{TOOL_DEFS.map(({ id, label, Icon, description }) => {
					// Only equip-and-use tools (paint/erase/scissors/level tracing)
					// get a settings arrow; other tools open settings on icon click.
					const hasSettingsArrow =
						LIVE_COMMIT_TOOLS.includes(id) && id !== "pointSegment" && id !== "boxSegment";
					const settingsOpenHere = toolFlyout.open && activeTool === id;
					return (
						<div
							key={id}
							ref={(el) => { iconRefs.current[id] = el; }}
							style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
							onMouseEnter={() => showTooltip(id)}
							onMouseLeave={() => hideTooltip(id)}
						>
							<button
								ref={(el) => { if (hasSettingsArrow) btnRefs.current[id] = el; }}
								className={`atb__btn ${activeTool === id ? "is-active" : ""}`}
								onClick={() => { if (enabled) selectTool(id); else setPickClassHintOpen(true); }}
								aria-label={label}
								aria-disabled={!enabled}
								onFocus={() => showTooltip(id)}
								onBlur={() => hideTooltip(id)}
							>
								<Icon size={20} />
							</button>
							{hasSettingsArrow && (
								<FlyoutArrow
									open={settingsOpenHere}
									onClick={() => {
										// Mirrors the main icon button's disabled-click handling above:
										// the arrow previously called openToolSettings unconditionally,
										// even when `enabled` was false, silently opening a tool's
										// settings flyout with no class selected. Route it through the
										// same "pick a class first" walkthrough popout instead.
										if (!enabled) { setPickClassHintOpen(true); return; }
										if (settingsOpenHere) toolFlyout.setOpen(false);
										else openToolSettings(id);
									}}
									label={`${label} settings`}
								/>
							)}
							{hoveredTool === id && (
								<IconTooltip
									label={label}
									description={
										!hasSegments
											? `${description} (no volume loaded)`
											: !hasActiveTarget
												? `${description}`
												: description
									}
									anchorRect={hoveredRect}
								/>
							)}
						</div>
					);
				})}
			</div>

			{/* Exit / Start over / Continue for the running guided flow
			    (Grow-from-seeds, Copy/Fill-across-slices, Islands) — fixed in
			    the ribbon, not floating over the canvas. No title/label text
			    identifying which guided flow is running is shown here — just
			    the controls themselves (see guidedControlsBoxRef below, used
			    only to anchor the one-time Continue/Start over/Exit explainer
			    popup, not for a visible label). */}
			{guidedControls && (
				<div
					ref={guidedControlsBoxRef}
					style={{
						flexShrink: 0,
						display: "flex",
						alignItems: "center",
						gap: 15,
						marginLeft: 14,
						paddingLeft: 14,
						borderLeft: "1px solid rgba(255, 255, 255, 0.09)",
					}}
				>
					{/* Local, self-contained keyframes for the Continue button's
					    glow-pulse below — kept here rather than in the shared
					    stylesheet since it's only ever used by this one button. */}
					<style>{`
						@keyframes seg-effect-continue-pulse {
							0% { box-shadow: 0 0 0 0 rgba(104, 172, 229, 0.55); }
							70% { box-shadow: 0 0 0 8px rgba(104, 172, 229, 0); }
							100% { box-shadow: 0 0 0 0 rgba(104, 172, 229, 0); }
						}
					`}</style>

					{guidedControls.busy ? (
						// Once the commit is running there's nothing left to cancel
						// or restart, so swap to the same pulsing-dot indicator.
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								fontSize: 11.5,
								fontWeight: 700,
								color: "rgba(255,255,255,0.75)",
								whiteSpace: "nowrap",
							}}
						>
							<span
								aria-hidden="true"
								style={{
									width: 7,
									height: 7,
									borderRadius: "50%",
									background: "var(--jhu-blue-accent, #68ACE5)",
									animation: "seg-effect-render-pulse 0.9s ease-in-out infinite",
								}}
							/>
							Applying…
						</span>
					) : (
						<>
							{/* Continue is shown whenever the guided flow provides a
							    handler for it (e.g. Grow from Seeds), always alongside
							    Start over and Exit. It stays clickable-looking but is
							    only actually enabled once `continueDisabled` clears
							    (e.g. after at least one seed point is marked) — a
							    click while still blocked doesn't call onContinue, it
							    just surfaces a small hint near the cursor instead. */}
							{guidedControls.onContinue && (
								<button
									type="button"
									onClick={(e) => {
										if (guidedControls.continueDisabled) {
											if (continueBlockedHintTimeoutRef.current != null) window.clearTimeout(continueBlockedHintTimeoutRef.current);
											setContinueBlockedHint({
												x: e.clientX,
												y: e.clientY,
												message: guidedControls.continueHint || "Mark at least one point first",
											});
											continueBlockedHintTimeoutRef.current = window.setTimeout(() => setContinueBlockedHint(null), 1800);
											return;
										}
										guidedControls.onContinue?.();
									}}
									aria-disabled={!!guidedControls.continueDisabled}
									className="atb-guided__btn atb-guided__btn--continue"
									style={{
										animation: guidedControls.continueDisabled ? undefined : "seg-effect-continue-pulse 1.6s ease-in-out infinite",
										opacity: guidedControls.continueDisabled ? 0.5 : 1,
										cursor: guidedControls.continueDisabled ? "default" : "pointer",
									}}
								>
									{guidedControls.continueLabel || "Continue"}
								</button>
							)}
							<button
								type="button"
								onClick={guidedControls.onStartOver}
								className="atb-guided__btn atb-guided__btn--startover"
							>
								Start over
							</button>
							<button
								type="button"
								onClick={guidedControls.onExit}
								className="atb-guided__btn atb-guided__btn--exit"
							>
								Exit
							</button>
						</>
					)}
				</div>
			)}

			</div>{/* /dockContentRef */}
		</div>

			<FlyoutPanel
				open={enabled && !!activeTool && !!activeDef && toolFlyout.open}
				anchorRef={toolFlyout.anchorRef}
				panelRef={toolFlyout.panelRef}
				placement="below"
				// 200 matches MenuColumn's natural floor + panel padding, so
				// short one-shot flyouts (e.g. Smoothing) shrink to fit instead
				// of using a flat width regardless of content.
				minWidth={200}
				// Forces a reposition when settings reopen for a different tool
				// icon, so the panel doesn't stay glued under the previous one.
				anchorKey={activeTool}
				// Guided-overlay tools (GrowFromSeeds, Copy/FillAcrossSlices,
				// Islands) close settings the instant their overlay takes over
				// picking; keepMounted stops that from unmounting the picker
				// state and its body-portaled overlay. The tool itself still
				// unmounts normally when deselected (activeDef goes null).
				keepMounted
			>
				{activeDef && (
					<div
						ref={panelBodyRef}
						className="atb-corner-panel atb-corner-panel--floating"
					>
						<div className="atb-corner-panel__body">
							{/* Measured for --atb-panel-h. Deliberately unstyled — observing
							    the body div directly (which has min-height: var(--atb-panel-h))
							    would be self-referential and grow without bound. */}
							<div ref={panelBodyContentRef} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "inherit", flexWrap: "inherit" }}>
								<div ref={fieldRef}>
									{(activeTool === "paint" || activeTool === "erase") && (
										// NumberSliderField's own `label` prop already shows
										// "Brush"/"Erase" above the slider.
										<DiameterFlyout
											title={activeTool === "paint" ? "Brush Size" : "Eraser Size"}
											diameterMm={diameterMm}
											onDiameterChange={onDiameterChange}
											onPreviewChange={onDiameterPreviewChange}
										/>
									)}
									{activeTool === "scissors" && (
										<ScissorsFlyout
											options={scissorsOptions}
											onChange={onScissorsOptionsChange}
											pointCount={scissorsPointCount}
											onCancel={onScissorsCancel}
											onCloseSettings={() => toolFlyout.setOpen(false)}
										/>
									)}
									{activeTool && !["paint", "erase", "scissors", "pointSegment", "boxSegment"].includes(activeTool) && renderFlyout(activeTool, handleToolApplied, () => toolFlyout.setOpen(false), setGuidedControls)}
								</div>
							</div>
						</div>
					</div>
				)}
			</FlyoutPanel>
		</div>{/* /.atb-shell */}

		{open && pickClassHintOpen && pickClassHintRect && (
			<>
				{/* Traces the live popup rect so it stays aligned if the popup is
				    dragged or resized while showing. */}
				<div
					aria-hidden="true"
					style={{
						position: "fixed",
						top: pickClassHintRect.top,
						left: pickClassHintRect.left - 3,
						width: pickClassHintRect.width + 6,
						height: pickClassHintRect.height + 3,
						border: "2px dashed var(--jhu-blue-accent, #68ACE5)",
						borderRadius: 12,
						pointerEvents: "none",
						zIndex: 120,
						boxShadow: "0 0 0 4000px rgba(0,0,0,0.35)",
					}}
				/>
				<div
					role="dialog"
					aria-label="Pick a class first"
					style={{
						position: "fixed",
						top: pickClassHintRect.top,
						left: Math.max(12, pickClassHintRect.left - 300),
						width: 260,
						background: "#16181d",
						border: "1px solid rgba(255,255,255,0.14)",
						borderRadius: 12,
						boxShadow: "0 18px 44px -12px rgba(0,0,0,0.75)",
						padding: "14px 16px",
						zIndex: 121,
						color: "#fff",
					}}
				>
					<div style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.9)" }}>
						Select an existing class or create a custom one to start annotating.
					</div>
					<button
						type="button"
						onClick={dismissPickClassHint}
						style={{
							marginTop: 12,
							width: "100%",
							background: "#fff",
							color: "#08090b",
							border: "none",
							borderRadius: 8,
							fontSize: 12.5,
							fontWeight: 700,
							padding: "8px 0",
							cursor: "pointer",
						}}
					>
						Got it
					</button>
				</div>
			</>
		)}

		{open && guidedHintOpen && guidedHintRect && (
			<>
				{/* Same dashed-spotlight treatment as the pick-class/first-target
				    hints above, but wrapping the Continue/Start over/Exit cluster
				    itself so it's obvious which controls the card is describing. */}
				<div
					aria-hidden="true"
					style={{
						position: "fixed",
						top: guidedHintRect.top - 8,
						left: guidedHintRect.left - 8,
						width: guidedHintRect.width + 16,
						height: guidedHintRect.height + 16,
						border: "2px dashed var(--jhu-blue-accent, #68ACE5)",
						borderRadius: 12,
						pointerEvents: "none",
						zIndex: 120,
						boxShadow: "0 0 0 4000px rgba(0,0,0,0.35)",
					}}
				/>
				<div
					role="dialog"
					aria-label="Guided flow controls"
					style={{
						position: "fixed",
						top: guidedHintRect.bottom + 10,
						left: Math.max(12, Math.min(guidedHintRect.left, window.innerWidth - 292)),
						width: 260,
						background: "#16181d",
						border: "1px solid rgba(255,255,255,0.14)",
						borderRadius: 12,
						boxShadow: "0 18px 44px -12px rgba(0,0,0,0.75)",
						padding: "14px 16px",
						zIndex: 121,
						color: "#fff",
					}}
				>
					<div style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.9)" }}>
						{guidedHintText}
					</div>
					<button
						type="button"
						onClick={dismissGuidedHint}
						style={{
							marginTop: 12,
							width: "100%",
							background: "#fff",
							color: "#08090b",
							border: "none",
							borderRadius: 8,
							fontSize: 12.5,
							fontWeight: 700,
							padding: "8px 0",
							cursor: "pointer",
						}}
					>
						Got it
					</button>
				</div>
			</>
		)}

		{/* Small blue rectangle pinned near the cursor when Continue is
		    clicked while the guided flow still has nothing to continue
		    with (e.g. no seed point marked yet). Same visual language as
		    SliceAnchorPickerUI's PickErrorHint, kept local here since this
		    fires from the ribbon's Continue button, not from a canvas
		    click. */}
		{continueBlockedHint && (
			<div
				role="alert"
				style={{
					position: "fixed",
					left: Math.max(12, Math.min(continueBlockedHint.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1024) - 260)),
					top: Math.max(12, Math.min(continueBlockedHint.y + 14, (typeof window !== "undefined" ? window.innerHeight : 768) - 60)),
					zIndex: 1300,
					pointerEvents: "none",
					maxWidth: 240,
					padding: "8px 12px",
					borderRadius: 10,
					background: "#002d72",
					border: "1px solid rgba(255, 255, 255, 0.25)",
					color: "#ffffff",
					fontSize: 12.5,
					fontWeight: 600,
					lineHeight: 1.35,
					fontFamily: "\"Space Grotesk\", system-ui, sans-serif",
					boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
				}}
			>
				{continueBlockedHint.message}
			</div>
		)}

		</>,
		document.body
	);
}