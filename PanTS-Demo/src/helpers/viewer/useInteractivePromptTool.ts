// helpers/viewer/useInteractivePromptTool.ts
//
// NOT YET TESTED end-to-end. Mirrors usePolygonDraw's architecture (pane
// tracking, world-space storage, canvas reprojection) but for the much
// simpler point/box prompt gesture: a single click submits immediately in
// "point" mode; a click-drag defines two corners and submits on mouseup in
// "box" mode.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToWorld,
	worldToCanvasPoint,
	submitInteractiveSegmentPrompt,
	type CinePane,
} from "../CornerstoneNifti2";
// Avoid importing Point3 from "@cornerstonejs/core/types" directly — Vite's
// import analysis doesn't reliably resolve that subpath for every file (it
// works from CornerstoneNifti2.tsx, which Vite already had in its graph, but
// errored here). A plain 3-tuple is structurally identical to Point3 for
// everything this file does with it.
type Point3 = [number, number, number];

export type PromptMode = "point" | "box";

interface UseInteractivePromptToolArgs {
	enabled: boolean;
	mode: PromptMode;
	apiBase: string;
	caseId: string | number | null;
	activeSegmentIndex: number | null;
	/** MUST reflect whichever grid the segmentation volume is actually on
	 *  right now — pass through the same hdReady-derived value used to gate
	 *  the Annotate button. Do not guess. */
	res: "low" | "full";
	tolerance?: number;
	onLog?: (detail: string) => void;
	/** Fired while a request is in flight, so the caller can show a spinner /
	 *  disable further clicks — a click mid-request would race the previous
	 *  one's voxel writes. */
	onBusyChange?: (busy: boolean) => void;
	/** Fired once a submit SUCCEEDS (voxels actually changed) — point/box
	 *  segment is single-shot, not equip-and-use like paint/erase, so the
	 *  caller should deselect the tool here (activeToolbarTool -> null) so
	 *  its icon loses the active/white-background state after one use.
	 *  NOT fired on "nothing changed" or on error — the user should be able
	 *  to immediately retry in place without re-arming the tool. */
	onComplete?: () => void;
}

export function useInteractivePromptTool({
	enabled, mode, apiBase, caseId, activeSegmentIndex, res, tolerance, onLog, onBusyChange, onComplete,
}: UseInteractivePromptToolArgs) {
	const [dragStartCanvas, setDragStartCanvas] = useState<[number, number] | null>(null);
	const [dragStartWorld, setDragStartWorld] = useState<Point3 | null>(null);
	const [liveBoxCanvas, setLiveBoxCanvas] = useState<[[number, number], [number, number]] | null>(null);
	const paneRef = useRef<CinePane | null>(null);
	const busyRef = useRef(false);
	// Drives the applying/success overlay (mirrors CopyAcrossSlicesFlyout's
	// GuidedStepModal pattern) instead of the tool silently completing with
	// only a session-log line — a click/box submit is a real server round
	// trip (hundreds of ms to a few seconds), so it needs its own feedback,
	// not just whatever "Interactive segment (N vox)" text happens to scroll
	// past in the log panel.
	const [status, setStatus] = useState<"idle" | "applying" | "success" | "error">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		paneRef.current = null;
	}, []);

	const submit = useCallback(async (_pane: CinePane, pointWorld: Point3, boxWorld?: [Point3, Point3]) => {		if (busyRef.current) return; // one in-flight request at a time
		if (activeSegmentIndex == null) {
			onLog?.("Interactive segment: no target segment selected.");
			return;
		}
		if (caseId == null) {
			onLog?.("Interactive segment: no case loaded.");
			return;
		}
		busyRef.current = true;
		onBusyChange?.(true);
		setStatus("applying");
		setStatusMessage(null);
		try {
			const { changed, engine, blocked } = await submitInteractiveSegmentPrompt(
				apiBase,
				caseId,
				activeSegmentIndex,
				{ pointLps: pointWorld, boxLps: boxWorld, tolerance },
				res,
			);
			if (blocked) {
				// A guard blocked the write — nothing was committed to the labelmap.
				onLog?.(blocked);
				setStatus("error");
				setStatusMessage(blocked);
			} else if (changed) {
				const engineLabel = engine === "nninteractive"
					? "AI (nnInteractive)"
					: "fallback (nnInteractive unavailable)";
				const msg = `Applied via ${engineLabel} — ${changed.toLocaleString()} voxels changed`;
				onLog?.(msg);
				setStatus("success");
				setStatusMessage(msg);
				onComplete?.();
			} else {
				const msg = "Interactive segment: nothing grew from that point — try a different spot.";
				onLog?.(msg);
				setStatus("error");
				setStatusMessage(msg);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Interactive segmentation failed.";
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			busyRef.current = false;
			onBusyChange?.(false);
		}
	}, [apiBase, caseId, activeSegmentIndex, res, tolerance, onLog, onBusyChange, onComplete]);

	const dismissStatus = useCallback(() => {
		setStatus("idle");
		setStatusMessage(null);
	}, []);

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "point") return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;
		void submit(pane, world);
	};

	// Box mode: mousedown starts the drag, mousemove updates the live preview
	// rectangle, mouseup submits both corners. Mirrors the pointer semantics a
	// user already expects from the scissors' click-drag box operations.
	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "box") return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;
		paneRef.current = pane;
		setDragStartCanvas(canvasPos);
		setDragStartWorld(world);
		setLiveBoxCanvas([canvasPos, canvasPos]);
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "box" || paneRef.current !== pane || !dragStartCanvas) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		setLiveBoxCanvas([dragStartCanvas, canvasPos]);
	};

	const handleMouseUp = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "box" || paneRef.current !== pane || !dragStartWorld) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const endWorld = canvasPointToWorld(pane, canvasPos);
		const startWorld = dragStartWorld;
		reset();
		if (!endWorld) return;
		// A click with ~no drag is treated as a degenerate box — submit as a
		// point at the start position instead of an empty/near-empty box,
		// which the backend's region_grow would otherwise clamp to nothing.
		const dx = Math.abs(canvasPos[0] - (dragStartCanvas?.[0] ?? 0));
		const dy = Math.abs(canvasPos[1] - (dragStartCanvas?.[1] ?? 0));
		if (dx < 4 && dy < 4) {
			void submit(pane, startWorld);
		} else {
			void submit(pane, startWorld, [startWorld, endWorld]);
		}
	};

	// While a box drag is in progress, listen for pointerup and Escape on the
	// window so the drag always completes (or cancels) even if the pointer
	// leaves the pane div before the user releases.
	useEffect(() => {
		if (mode !== "box" || !dragStartWorld || !dragStartCanvas) return;

		const onPointerUp = (e: PointerEvent) => {
			const startWorld = dragStartWorld;
			const startCanvas = dragStartCanvas;
			// Compute end canvas position relative to the active pane element.
			// The pane divs in VisualizationPage use class names matching the
			// pane id: "axial", "sagittal", "coronal".
			// Fall back to startCanvas if not found (submits as a point).
			let endCanvasPos: [number, number] = startCanvas;
			if (paneRef.current) {
				const paneEl = document.querySelector(
					`.${paneRef.current}`
				) as HTMLElement | null;
				if (paneEl) {
					const rect = paneEl.getBoundingClientRect();
					endCanvasPos = [e.clientX - rect.left, e.clientY - rect.top];
				}
			}
			const currentPane = paneRef.current;
			reset();
			if (!currentPane) return;
			const endWorld = canvasPointToWorld(currentPane, endCanvasPos);
			if (!endWorld) return;
			const dx = Math.abs(endCanvasPos[0] - startCanvas[0]);
			const dy = Math.abs(endCanvasPos[1] - startCanvas[1]);
			if (dx < 4 && dy < 4) {
				void submit(currentPane, startWorld);
			} else {
				void submit(currentPane, startWorld, [startWorld, endWorld]);
			}
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				reset();
			}
		};

		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("keydown", onKeyDown);
		};
		// dragStartWorld/dragStartCanvas trigger the effect when a drag starts.
		// submit and reset are stable useCallback refs.
	}, [mode, dragStartWorld, dragStartCanvas, submit, reset]);

	// Canvas-space live box for the overlay, reprojected against the CURRENT
	// camera on every render, same reasoning as usePolygonDraw's toCanvas().
	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxCanvas;
	void worldToCanvasPoint; // referenced for parity with usePolygonDraw's reprojection pattern; box mode doesn't need it since it never stores world corners across a re-render before submit.

	return {
		pane,
		liveBox: liveBoxDisplay,
		status,
		statusMessage,
		dismissStatus,
		handleClick,
		handleMouseDown,
		handleMouseMove,
		handleMouseUp,
		cancel: reset,
		reset,
	};
}