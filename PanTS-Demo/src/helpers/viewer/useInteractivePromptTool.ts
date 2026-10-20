// helpers/viewer/useInteractivePromptTool.ts
//
// NOT YET TESTED end-to-end. Mirrors usePolygonDraw's architecture (pane
// tracking, world-space storage, canvas reprojection) but for the much
// simpler point/box prompt gesture: a single click submits immediately in
// "point" mode; a click-drag defines two corners and submits on mouseup in
// "box" mode.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
	canvasPointToWorld,
	worldToCanvasPoint,
	submitInteractiveSegmentPrompt,
	acceptPendingPrompt,
	rejectPendingPrompt,
	type PendingPromptHandle,
	type CinePane,
} from "../CornerstoneNifti2";
// Avoid importing Point3 from "@cornerstonejs/core/types" directly — Vite's
// import analysis doesn't reliably resolve that subpath for every file (it
// works from CornerstoneNifti2.tsx, which Vite already had in its graph, but
// errored here). A plain 3-tuple is structurally identical to Point3 for
// everything this file does with it.
type Point3 = [number, number, number];

export type PromptMode = "point" | "box" | "lasso" | "scribble";

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
	const [liveBoxWorld, setLiveBoxWorld] = useState<[Point3, Point3] | null>(null);
	const [pathDrawing, setPathDrawing] = useState(false);
	const [livePathWorld, setLivePathWorld] = useState<Point3[]>([]);
	const paneRef = useRef<CinePane | null>(null);
	const paneElementRef = useRef<HTMLElement | null>(null);
	const pointerIdRef = useRef<number | null>(null);
	const pathRef = useRef<Point3[]>([]);
	const busyRef = useRef(false);
	// Drives the applying/success overlay (mirrors CopyAcrossSlicesFlyout's
	// GuidedStepModal pattern) instead of the tool silently completing with
	// only a session-log line — a click/box submit is a real server round
	// trip (hundreds of ms to a few seconds), so it needs its own feedback,
	// not just whatever "Interactive segment (N vox)" text happens to scroll
	// past in the log panel.
	const [status, setStatus] = useState<"idle" | "applying" | "success" | "error" | "pending">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingPromptHandle | null>(null);
	useEffect(() => {
		console.log(`[ai-tool] ${mode} enabled=${enabled}`);
	}, [enabled, mode]);

	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxWorld(null);
		paneRef.current = null;
		pathRef.current = [];
		setPathDrawing(false);
		setLivePathWorld([]);
	}, []);

	const submit = useCallback(async (_pane: CinePane, pointWorld: Point3, boxWorld?: [Point3, Point3], pathWorld?: Point3[]) => {
		console.log("[ai-tool] submit called");
		if (busyRef.current) {
			console.log("[ai-tool] submit returned early reason=busy");
			return;
		} // one in-flight request at a time
		if (activeSegmentIndex == null) {
			console.log("[ai-tool] submit returned early reason=no target segment");
			onLog?.("Interactive segment: no target segment selected.");
			return;
		}
		if (caseId == null) {
			console.log("[ai-tool] submit returned early reason=no caseId");
			onLog?.("Interactive segment: no case loaded.");
			return;
		}
		busyRef.current = true;
		onBusyChange?.(true);
		setStatus("applying");
		setStatusMessage(null);
		try {
			const { changed, engine, blocked, pending: pendingHandle } = await submitInteractiveSegmentPrompt(
				apiBase,
				caseId,
				activeSegmentIndex,
				{ pointLps: pointWorld, boxLps: boxWorld, pathLps: pathWorld, promptMode: mode, pane: _pane, tolerance },
				res,
			);
			if (blocked) {
				// A guard blocked the write — nothing was committed to the labelmap.
				onLog?.(blocked);
				setStatus("error");
				setStatusMessage(blocked);
			} else if (changed) {
				if (pendingHandle) {
					setPending(pendingHandle);
					setStatus("pending");
					setStatusMessage(null);
				} else {
					const engineLabel = engine === "nninteractive" ? "AI (nnInteractive)" : "fallback (nnInteractive unavailable)";
					const msg = `Applied via ${engineLabel} — ${changed.toLocaleString()} voxel${changed === 1 ? "" : "s"} changed`;
					onLog?.(msg);
					setStatus("success");
					setStatusMessage(msg);
				}
				onComplete?.();
			} else {
				const msg = "Interactive segment: nothing grew from that point — try a different spot.";
				onLog?.(msg);
				setStatus("error");
				setStatusMessage(msg);
			}
		} catch (e) {
			console.log(`[ai-tool] submit failed error=${e instanceof Error ? e.name : "unknown"}`);
			const msg = e instanceof Error ? e.message : "Interactive segmentation failed.";
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			busyRef.current = false;
			onBusyChange?.(false);
		}
	}, [apiBase, caseId, activeSegmentIndex, res, mode, tolerance, onLog, onBusyChange, onComplete]);

	const dismissStatus = useCallback(() => {
		setStatus("idle");
		setStatusMessage(null);
	}, []);

	const accept = useCallback(() => {
		if (!pending) return;
		acceptPendingPrompt(pending);
		setPending(null);
		setStatus("idle");
	}, [pending]);
	const reject = useCallback(() => {
		if (!pending) return;
		rejectPendingPrompt(pending);
		setPending(null);
		setStatus("idle");
	}, [pending]);

	useEffect(() => {
		if (!pending) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); accept(); }
			else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); reject(); }
			else { event.preventDefault(); event.stopImmediatePropagation(); }
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [pending, accept, reject]);

	useEffect(() => {
		if (!pending) return;
		return () => rejectPendingPrompt(pending);
	}, [caseId, pending]);

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "point") {
			if (mode === "point" && busyRef.current) console.log("[ai-tool] point click ignored reason=busy");
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) {
			console.log("[ai-tool] point click returned early reason=no world point");
			return;
		}
		void submit(pane, world);
	};

	// Lasso and scribble start from mouse events; Box uses pointer events below
	// so drag start, movement, and release share one event stream.
	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (enabled && (mode === "lasso" || mode === "scribble")) {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (!world || busyRef.current) return;
			paneRef.current = pane;
			pathRef.current = [world];
			setLivePathWorld([world]);
			setPathDrawing(true);
			return;
		}
	};

	const handlePointerDown = (pane: CinePane) => (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!enabled || mode !== "box") return;
		const rect = e.currentTarget.getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world || busyRef.current) return;
		paneRef.current = pane;
		paneElementRef.current = e.currentTarget as HTMLElement;
		pointerIdRef.current = e.pointerId;
		setDragStartCanvas(canvasPos);
		setDragStartWorld(world);
		setLiveBoxWorld([world, world]);
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (enabled && (mode === "lasso" || mode === "scribble") && paneRef.current === pane && pathRef.current.length) {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(pane, canvasPos);
			if (world) { pathRef.current.push(world); setLivePathWorld((points) => [...points, world]); }
			return;
		}
		if (mode === "box") return;
	};

	const handleMouseUp = (pane: CinePane) => (e: MouseEvent) => {
		if (enabled && (mode === "lasso" || mode === "scribble") && paneRef.current === pane && pathRef.current.length) {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const world = canvasPointToWorld(pane, [e.clientX - rect.left, e.clientY - rect.top]);
			if (world) pathRef.current.push(world);
			const points = [...pathRef.current];
			paneRef.current = null;
			pathRef.current = [];
			setPathDrawing(false);
			setLivePathWorld([]);
			if (points.length >= 2) void submit(pane, points[0], undefined, points);
			return;
		}
		if (!enabled || mode !== "box" || paneRef.current !== pane || !dragStartWorld) {
			if (mode === "box" && (enabled || paneRef.current || dragStartWorld)) {
				const reason = !enabled ? "disabled" : paneRef.current !== pane ? "different pane" : "no drag start";
				console.log(`[ai-tool] box mouseup returned early reason=${reason}`);
			}
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const endWorld = canvasPointToWorld(pane, canvasPos);
		const startWorld = dragStartWorld;
		reset();
		if (!endWorld) {
			console.log("[ai-tool] box mouseup returned early reason=no end world point");
			return;
		}
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

	useEffect(() => {
		if (!enabled || !pathDrawing || (mode !== "lasso" && mode !== "scribble")) return;
		const finishPath = (event: PointerEvent) => {
			const pane = paneRef.current;
			if (!pane || !pathRef.current.length) return;
			const paneEl = document.querySelector(`.${pane}`) as HTMLElement | null;
			if (paneEl) {
				const rect = paneEl.getBoundingClientRect();
				const canvasPos: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
				const world = canvasPointToWorld(pane, canvasPos);
				if (world) pathRef.current.push(world);
			}
			const points = [...pathRef.current];
			paneRef.current = null;
			pathRef.current = [];
			setPathDrawing(false);
			setLivePathWorld([]);
			if (points.length >= 2) void submit(pane, points[0], undefined, points);
		};
		const cancelPath = (event: KeyboardEvent) => {
			if (event.key === "Escape") reset();
		};
		window.addEventListener("pointerup", finishPath);
		window.addEventListener("keydown", cancelPath);
		return () => {
			window.removeEventListener("pointerup", finishPath);
			window.removeEventListener("keydown", cancelPath);
		};
	}, [enabled, pathDrawing, mode, submit, reset]);

	// While a box drag is in progress, listen for pointerup and Escape on the
	// window so the drag always completes (or cancels) even if the pointer
	// leaves the pane div before the user releases.
	useEffect(() => {
		if (mode !== "box" || !dragStartWorld || !dragStartCanvas) return;

		const onPointerUp = (e: PointerEvent) => {
			if (pointerIdRef.current !== e.pointerId) return;
			const startWorld = dragStartWorld;
			const startCanvas = dragStartCanvas;
			// Use the same pane element for both corners so their canvas positions
			// are in the same coordinate system.
			let endCanvasPos: [number, number] = startCanvas;
			const paneEl = paneElementRef.current;
			if (paneEl) {
				const rect = paneEl.getBoundingClientRect();
				endCanvasPos = [e.clientX - rect.left, e.clientY - rect.top];
			}
			const currentPane = paneRef.current;
			reset();
			if (!currentPane) {
				console.log("[ai-tool] box pointerup returned early reason=no pane");
				return;
			}
			const endWorld = canvasPointToWorld(currentPane, endCanvasPos);
			if (!endWorld) {
				console.log("[ai-tool] box pointerup returned early reason=no end world point");
				return;
			}
			const dx = Math.abs(endCanvasPos[0] - startCanvas[0]);
			const dy = Math.abs(endCanvasPos[1] - startCanvas[1]);
			if (dx < 4 && dy < 4) {
				console.log("[ai-tool] box pointerup ignored reason=no box drag");
				return;
			}
			void submit(currentPane, startWorld, [startWorld, endWorld]);
		};
		const onPointerMove = (e: PointerEvent) => {
			const currentPane = paneRef.current;
			if (!currentPane) return;
			const paneEl = document.querySelector(`.${currentPane}`) as HTMLElement | null;
			if (!paneEl) return;
			const rect = paneEl.getBoundingClientRect();
			const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
			const world = canvasPointToWorld(currentPane, canvasPos);
			if (world) setLiveBoxWorld([dragStartWorld, world]);
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				reset();
			}
		};

		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("keydown", onKeyDown);
		};
		// dragStartWorld/dragStartCanvas trigger the effect when a drag starts.
		// submit and reset are stable useCallback refs.
	}, [mode, dragStartWorld, dragStartCanvas, submit, reset]);

	// Canvas-space live box for the overlay, reprojected against the CURRENT
	// camera on every render, same reasoning as usePolygonDraw's toCanvas().
	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxWorld && pane ? (() => {
		const start = worldToCanvasPoint(pane, liveBoxWorld[0]);
		const end = worldToCanvasPoint(pane, liveBoxWorld[1]);
		return start && end ? [start, end] as const : null;
	})() : null;

	return {
		pane,
		liveBox: liveBoxDisplay,
		livePathWorld,
		status,
		statusMessage,
		pending,
		accept,
		reject,
		dismissStatus,
		handleClick,
		handleMouseDown,
		handlePointerDown,
		handleMouseMove,
		handleMouseUp,
		cancel: reset,
		reset,
	};
}
