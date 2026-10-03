import { cache, init as coreInit, utilities as csCoreUtils, Enums, eventTarget, getRenderingEngine, imageLoader, metaData, RenderingEngine, setVolumesForViewports, volumeLoader } from "@cornerstonejs/core";
import type { ColorLUT, Point2, Point3, Color } from "@cornerstonejs/core/types";
import { cornerstoneNiftiImageLoader, createNiftiImageIdsAndCacheMetadata, init as niftiImageLoaderInit } from "@cornerstonejs/nifti-volume-loader";
import * as cornerstoneTools from '@cornerstonejs/tools';
import { init as cornerstoneToolsInit } from '@cornerstonejs/tools';
import { SegmentationRepresentations } from "@cornerstonejs/tools/enums";
import { NEW_CLASS_PALETTE } from "./constants";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageMarchingCubes from "@kitware/vtk.js/Filters/General/ImageMarchingCubes";
import type { MaskingArea } from "../components/segmentation/MaskingSelect";
import { createOperationGeneration } from "./viewer/operationGeneration";
import { rollbackVolumeUpgrade } from "./viewer/volumeUpgrade";
import { addVolumeLabelmap } from "./viewer/addVolumeLabelmap";
type viewportIdTypes = 'CT_NIFTI_AXIAL' | 'CT_NIFTI_SAGITTAL' | 'CT_NIFTI_CORONAL';

const {
    ToolGroupManager,
    Enums: csToolsEnums,
    segmentation,
    annotation,
    PanTool,
    ZoomTool,
    StackScrollTool,
    CrosshairsTool,
    LengthTool,
    ProbeTool,
    RectangleROITool,
    AngleTool,
    EllipticalROITool,
    PlanarFreehandROITool,
    BidirectionalTool,
    ArrowAnnotateTool,
    AdvancedMagnifyTool,
    BrushTool,
    TrackballRotateTool,
    ReferenceLinesTool,
} = cornerstoneTools;

// Measurement tools the toolbar can switch the primary mouse button to. Length =
// distance in mm, Bidirectional = long + short axis (RECIST), Probe = HU readout
// at a point, RectangleROI/EllipticalROI/FreehandROI = area + mean/max/min HU (the
// freehand one traces an arbitrary closed outline instead of a fixed rect/ellipse
// shape), Angle = angle in degrees between two segments, Arrow = labeled pointer at
// a finding.
export const LENGTH_TOOL = LengthTool.toolName;
export const BIDIRECTIONAL_TOOL = BidirectionalTool.toolName;
export const PROBE_TOOL = ProbeTool.toolName;
export const ROI_TOOL = RectangleROITool.toolName;
export const ANGLE_TOOL = AngleTool.toolName;
export const ELLIPSE_TOOL = EllipticalROITool.toolName;
export const FREEHAND_ROI_TOOL = PlanarFreehandROITool.toolName;
export const ARROW_TOOL = ArrowAnnotateTool.toolName;
export const MEASUREMENT_TOOL_NAMES = [LENGTH_TOOL, BIDIRECTIONAL_TOOL, ANGLE_TOOL, PROBE_TOOL, ROI_TOOL, ELLIPSE_TOOL, FREEHAND_ROI_TOOL, ARROW_TOOL] as const;
export type MeasurementToolName = (typeof MEASUREMENT_TOOL_NAMES)[number];

// Magnify is a viewing aid, not a measurement: it shares the activation path (one
// owner of the primary button) but its loupe annotations are excluded from the
// measurement inventory/report, and are removed when the tool is put down.
// AdvancedMagnifyTool is required — plain MagnifyTool throws on volume viewports.
// (Annotated: its d.ts declares `static toolName: any`, which would poison the union.)
export const MAGNIFY_TOOL: string = AdvancedMagnifyTool.toolName;
export type PrimaryMouseToolName = MeasurementToolName | typeof MAGNIFY_TOOL;

// Mask-editing tools: two instances of BrushTool, one painting the active segment,
// one erasing (strategy ERASE writes segment 0). Registered passive; the toolbar's
// Edit panel activates one of them on the primary button.
export const EDIT_BRUSH = "MaskBrush";
export const EDIT_ERASER = "MaskEraser";
export const EDIT_TOOL_NAMES = [EDIT_BRUSH, EDIT_ERASER] as const;
export type MaskEditToolName = (typeof EDIT_TOOL_NAMES)[number];

// Cornerstone's defaults draw measurements in yellow (resting) / green (selected) — the
// standard radiology-viewer convention for a plain grayscale background. BodyMaps overlays
// colored organ masks (reds/pinks/purples/teal), so yellow/green collide with them. Cyan
// gives the strongest contrast over the warm masks while still reading on grayscale CT;
// selected annotations go white for clear edit feedback. The dashed leader line that
// tethers each label to its measurement is recolored to match.
const MEASURE_COLOR = "#22d3ee"; // cyan — resting
const MEASURE_COLOR_HI = "#67e8f9"; // lighter cyan — hover
const MEASUREMENT_ANNOTATION_STYLE = {
    color: MEASURE_COLOR,
    colorHighlighted: MEASURE_COLOR_HI,
    colorSelected: "#ffffff",
    colorLocked: MEASURE_COLOR,
    lineWidth: "2",
    textBoxColor: MEASURE_COLOR,
    textBoxColorHighlighted: MEASURE_COLOR_HI,
    textBoxColorSelected: "#ffffff",
    textBoxLinkLineColor: MEASURE_COLOR,
    // Pin the font/shadow too: if a prior (partial) style ever persisted in module state,
    // the merge base could be missing these and the value labels wouldn't render.
    textBoxFontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
    textBoxFontSize: "14px",
    shadow: true,
};

const renderingEngineId = "rendering_engine";
const toolGroupId = "myToolGroup";

// Maximum fraction of the total segmentation volume that an interactive-segment
// proposal is allowed to change. A result above this threshold is almost certainly
// a region_grow flood (e.g. all soft tissue) and must not be written to the labelmap.
// 15 % is large enough to contain a whole liver or spleen on a typical abdominal CT
// and small enough to reject an obvious flood.
const INTERACTIVE_MASK_MAX_FRACTION = 0.15;

const DEFAULT_SEGMENTATION_CONFIG = {
    fillAlpha: 0.6,
    fillAlphaInactive: 0.6,
    outlineOpacity: 1,
    outlineWidth: 1,
    renderOutline: false,
    outlineOpacityInactive: 0
};


let segmentationId = "";

const viewportId1 = "CT_NIFTI_AXIAL";
const viewportId2 = "CT_NIFTI_SAGITTAL";
const viewportId3 = "CT_NIFTI_CORONAL";
const MPR_VIEWPORT_IDS = [viewportId1, viewportId2, viewportId3];

// Shaded volume rendering (3D pane "Volume" mode) — its OWN rendering engine,
// viewport and tool group. A separate engine is essential: sharing the MPR
// engine means enabling/disabling this viewport (or its resize) repacks the
// shared offscreen canvas and corrupts the axial/sagittal/coronal viewports.
const volume3DViewportId = "CT_VOLUME_3D";
const volume3DEngineId = "volume3d_engine";
const volume3DToolGroupId = "volume3DToolGroup";

function _getVolume3DEngine(): RenderingEngine {
  return (getRenderingEngine(volume3DEngineId) as RenderingEngine | undefined) ?? new RenderingEngine(volume3DEngineId);
}

let currentRenderingEngine: RenderingEngine | null = null;
type ViewerResourceContext = {
  generation: number;
  key: string;
  engine: RenderingEngine | null;
  segmentationId: string | null;
  volumeIds: Set<string>;
  volumeImageIds: Map<string, Set<string>>;
  releasedVolumeIds: Set<string>;
  signal?: AbortSignal;
  abortListener?: () => void;
  disposed: boolean;
};

let _viewerGeneration = 0;
let _activeViewerContext: ViewerResourceContext | null = null;
const _imageOwners = new Map<string, number>();

function _resourceKey(value: string | undefined): string {
  const safe = (value ?? "viewer").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || "viewer").slice(0, 80);
}

function _claimVolumeImages(context: ViewerResourceContext, volumeId: string, imageIds: string[]) {
  let claimed = context.volumeImageIds.get(volumeId);
  if (!claimed) {
    claimed = new Set();
    context.volumeImageIds.set(volumeId, claimed);
  }
  for (const imageId of imageIds) {
    if (claimed.has(imageId)) continue;
    claimed.add(imageId);
    if (context.releasedVolumeIds.has(volumeId)) {
      if (!_imageOwners.has(imageId)) {
        try {
          imageLoader.cancelLoadImage?.(imageId);
          cache.removeImageLoadObject(imageId, { force: true });
        } catch {
          /* image already evicted */
        }
      }
      continue;
    }
    _imageOwners.set(imageId, (_imageOwners.get(imageId) ?? 0) + 1);
  }
}

function _removeCachedVolume(volumeIdToRemove: string) {
  try {
    cache.getVolume(volumeIdToRemove)?.cancelLoading?.();
    cache.removeVolumeLoadObject(volumeIdToRemove);
  } catch {
    /* already absent */
  }
}

function _releaseContextVolume(context: ViewerResourceContext, volumeIdToRelease: string) {
  _removeCachedVolume(volumeIdToRelease);
  const imageIds = context.volumeImageIds.get(volumeIdToRelease) ?? new Set<string>();
  if (context.releasedVolumeIds.has(volumeIdToRelease)) {
    for (const imageId of imageIds) {
      if (_imageOwners.has(imageId)) continue;
      try {
        imageLoader.cancelLoadImage?.(imageId);
        cache.removeImageLoadObject(imageId, { force: true });
      } catch {
        /* image already evicted */
      }
    }
    return;
  }

  context.releasedVolumeIds.add(volumeIdToRelease);
  for (const imageId of imageIds) {
    const remaining = (_imageOwners.get(imageId) ?? 1) - 1;
    if (remaining > 0) {
      _imageOwners.set(imageId, remaining);
      continue;
    }
    _imageOwners.delete(imageId);
    try {
      imageLoader.cancelLoadImage?.(imageId);
      cache.removeImageLoadObject(imageId, { force: true });
    } catch {
      /* image already evicted */
    }
  }
}

function _clearViewerAnnotations() {
  try {
    const all = annotation.state.getAllAnnotations() ?? [];
    for (const item of [...all]) {
      if (item?.annotationUID) annotation.state.removeAnnotation(item.annotationUID);
    }
  } catch {
    /* annotation state not initialized */
  }
}

function _removeContextSegmentation(context: ViewerResourceContext) {
  if (!context.segmentationId) return;
  for (const viewportId of MPR_VIEWPORT_IDS) {
    try {
      (segmentation as any).removeSegmentationRepresentations?.(viewportId, {
        segmentationId: context.segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      });
    } catch {
      /* representation already gone */
    }
  }
  try {
    (segmentation as any).removeSegmentation?.(context.segmentationId);
  } catch {
    /* segmentation already gone */
  }
}

function _disposeViewerContext(context: ViewerResourceContext) {
  if (context.signal && context.abortListener) {
    context.signal.removeEventListener("abort", context.abortListener);
    context.abortListener = undefined;
  }
  if (context.disposed) {
    // A loader may finish after its first cleanup removed an in-flight cache entry.
    // Reap anything it republished, but never evict image IDs now owned by a replacement.
    for (const id of context.volumeIds) _releaseContextVolume(context, id);
    _removeContextSegmentation(context);
    return;
  }
  context.disposed = true;
  const ownsActiveViewer = _activeViewerContext === context;

  _removeContextSegmentation(context);

  if (ownsActiveViewer) {
    _viewerGeneration += 1;
    stopCine();
    disableVolume3D();
    _clearViewerAnnotations();
    try {
      segmentation.removeAllSegmentations();
    } catch {
      /* segmentation state not initialized */
    }
    try {
      ToolGroupManager.destroyToolGroup(toolGroupId);
    } catch {
      /* tool group already gone */
    }
    try {
      context.engine?.destroy();
    } catch {
      /* rendering engine already gone */
    }
    if (currentRenderingEngine === context.engine) currentRenderingEngine = null;
    _activeViewerContext = null;
    _currentCtVolumeId = null;
    segmentationId = "";
    _lastColorLUT = null;
    _organCentroids = null;
    _customSegmentLabels = {};
    clearEditedSegments();
  }

  for (const id of context.volumeIds) _releaseContextVolume(context, id);
}

export function disposeVisualization() {
  if (_activeViewerContext) _disposeViewerContext(_activeViewerContext);
}

function _throwIfViewerLoadStale(context: ViewerResourceContext, signal?: AbortSignal) {
  if (
    signal?.aborted ||
    context.disposed ||
    _activeViewerContext !== context ||
    context.generation !== _viewerGeneration
  ) {
    throw new DOMException("Viewer load was replaced", "AbortError");
  }
}

// The NIfTI loader does not currently accept an AbortSignal for its metadata
// fetch. Race its promise with the viewer's signal so a dropped connection can
// never trap the page on "Preparing case" forever. The underlying fetch can
// finish harmlessly in the background; the stale context is disposed and can
// no longer render into the active viewer.
function _awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Viewer load was aborted", "AbortError"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Viewer load was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
// The CT volume currently on the MPR viewports (changes when the progressive
// full-res upgrade swaps it) and the color LUT used for the labelmap, kept so
// the segmentation representation can be rebuilt after a volume swap.
let _currentCtVolumeId: string | null = null;
let _lastColorLUT: ColorLUT | null = null;
// User-created segment labels, reset on each case load.
let _customSegmentLabels: Record<number, string> = {};

const _crosshairChangeCallbacks = new Set<(mm: number[]) => void>();
let _isSyncing = false;
let _crosshairListenerRegistered = false;

function _handleCrosshairCenterChanged(evt: Event) {
    if (_isSyncing) return;

    const toolCenter = (evt as CustomEvent).detail?.toolCenter as number[] | undefined;

    if (!toolCenter || toolCenter.length < 3) return;

    for (const cb of _crosshairChangeCallbacks) {
        cb(toolCenter);
    }
}

export function registerCrosshairListener(eventTarget: EventTarget, cornerstoneTools: any) {
    if (!_crosshairListenerRegistered) {
        eventTarget.addEventListener(
            cornerstoneTools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
            _handleCrosshairCenterChanged
        );

        _crosshairListenerRegistered = true;
    }
}

export function subscribeToCrosshairChanges(cb: (mm: number[]) => void) {
    _crosshairChangeCallbacks.add(cb);

    return () => {
        _crosshairChangeCallbacks.delete(cb);
    };
}

export function setCrosshairSyncing(value: boolean) {
    _isSyncing = value;
}

export function moveCornerstoneCrosshairToMm(mm: [number, number, number]) {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    if (!toolGroup) return;
    const tool = toolGroup.getToolInstance(CrosshairsTool.toolName) as {
        setToolCenter?: (mm: number[], suppressEvents?: boolean) => void;
    };
    if (!tool?.setToolCenter) return;
    _isSyncing = true;
    try {
        tool.setToolCenter(mm, true); // suppressEvents=true prevents re-triggering
    } finally {
        _isSyncing = false;
    }
}

// Current crosshair world position (mm), or null if the tool isn't ready. Used to capture
// the focal point for a shareable link without waiting on a crosshair-change event.
export function getCrosshairMm(): [number, number, number] | null {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    const tool = toolGroup?.getToolInstance(CrosshairsTool.toolName) as
        | { toolCenter?: number[] }
        | undefined;
    const c = tool?.toolCenter;
    if (!c || c.length < 3 || !c.every((n: number) => Number.isFinite(n))) return null;
    return [c[0], c[1], c[2]];
}
const viewportColors: Record<viewportIdTypes, string> = {
    [viewportId1]: 'rgb(200, 0, 0)',
    [viewportId2]: 'rgb(200, 200, 0)',
    [viewportId3]: 'rgb(0, 200, 0)',
};
function getReferenceLineColor(viewportId: viewportIdTypes) {
    return viewportColors[viewportId];
}


function getReferenceLineControllable(viewportId: viewportIdTypes) {
    const index = [viewportId1, viewportId2, viewportId3].indexOf(viewportId);
    return index !== -1;
}

function getReferenceLineDraggableRotatable(viewportId: viewportIdTypes) {
    const index = [viewportId1, viewportId2, viewportId3].indexOf(viewportId);
    return index !== -1;
}

function getReferenceLineSlabThicknessControlsOn(viewportId: viewportIdTypes) {
    const index =
        [viewportId1, viewportId2, viewportId3].indexOf(viewportId);
    return index !== -1;
}

// ---------------------------------------------------------------------------
// Reference lines (OHIF-style) — a passive overlay showing where the pane the
// user is actively scrolling through cuts the OTHER two, independent of
// whatever tool currently owns the primary mouse button. Deliberately separate
// from CrosshairsTool: that tool ALSO draws intersection lines, but only while
// it's the active navigation tool — they vanish the instant you switch to Pan,
// a measurement tool, or mask editing. Reference lines should keep showing then.
//
// Only ONE source is ever active at a time (the pane most recently scrolled),
// matching how OHIF drives its "active viewport" reference lines rather than
// showing all three planes' lines simultaneously, which gets noisy fast.
// Cornerstone's ReferenceLinesTool tracks one `sourceViewportId` per instance
// and draws that source plane into every OTHER viewport with the instance
// enabled — so three named instances are registered (one per possible source)
// and exactly one is enabled at a time; the other two stay disabled.
// ---------------------------------------------------------------------------
const REFERENCE_LINES_INSTANCE_BY_SOURCE: Record<viewportIdTypes, string> = {
    [viewportId1]: "ReferenceLines_Axial",
    [viewportId2]: "ReferenceLines_Sagittal",
    [viewportId3]: "ReferenceLines_Coronal",
};
const REFERENCE_LINES_INSTANCE_NAMES = Object.values(REFERENCE_LINES_INSTANCE_BY_SOURCE);
// SVG stroke-dasharray — a fine dotted line reads as a passive reference, distinct from
// the crosshair's solid navigation lines.
const REFERENCE_LINE_DASH = "1,5";

function _referenceLinesSourceViewportId(pane: CinePane): viewportIdTypes {
    return pane === "axial" ? viewportId1 : pane === "sagittal" ? viewportId2 : viewportId3;
}

// enabled=false disables all three instances. enabled=true enables only the instance
// sourced from `sourcePane` (defaulting to axial) and disables the other two — call this
// again with a different pane whenever the user scrolls a different one.
export function setReferenceLinesEnabled(enabled: boolean, sourcePane: CinePane = "axial") {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    if (!toolGroup) return;
    const activeInstance = enabled ? REFERENCE_LINES_INSTANCE_BY_SOURCE[_referenceLinesSourceViewportId(sourcePane)] : null;
    for (const instanceName of REFERENCE_LINES_INSTANCE_NAMES) {
        if (instanceName === activeInstance) {
            toolGroup.setToolEnabled(instanceName);
        } else {
            toolGroup.setToolDisabled(instanceName);
        }
    }
    if (currentRenderingEngine) {
        currentRenderingEngine.renderViewports([viewportId1, viewportId2, viewportId3]);
        currentRenderingEngine.render();
    }
}
// Subscribe to the nifti loader's real download progress (bytes loaded / total) so
// the UI can show an accurate, measured ETA. Returns an unsubscribe fn.
export function subscribeToVolumeProgress(
	cb: (loaded: number, total: number, volumeId: string) => void
): () => void {
	const handler = (evt: Event) => {
		const detail = (evt as CustomEvent).detail;
		const data = detail?.data ?? detail;
		if (data && typeof data.loaded === "number" && typeof data.total === "number") {
			cb(data.loaded, data.total, String(data.volumeId ?? ""));
		}
	};
	// Event name from @cornerstonejs/nifti-volume-loader (Events.NIFTI_VOLUME_PROGRESS).
	eventTarget.addEventListener("CORNERSTONE_NIFTI_VOLUME_PROGRESS", handler as EventListener);
	return () =>
		eventTarget.removeEventListener("CORNERSTONE_NIFTI_VOLUME_PROGRESS", handler as EventListener);
}

// Cornerstone core/loader/tools only need initializing once per page load;
// re-running them on every case load (HD toggle, navigation) risks duplicate
// tool registration. Mirrors the guard in compareViewer.ts.
let _cornerstoneInited = false;

export async function renderVisualization(ref1: HTMLDivElement, ref2: HTMLDivElement, ref3: HTMLDivElement, convertedColorLUT: ColorLUT, ctUrl: string, segUrl: string | undefined, _setLoading: React.Dispatch<React.SetStateAction<boolean>>, opts?: { ctImageIds?: string[]; resourceKey?: string; signal?: AbortSignal }) {
    if (!_cornerstoneInited) {
        coreInit();
        niftiImageLoaderInit();
        cornerstoneToolsInit();
        _cornerstoneInited = true;
    }
    disposeVisualization();
    const generation = ++_viewerGeneration;
    const key = _resourceKey(opts?.resourceKey ?? ctUrl);
    const context: ViewerResourceContext = {
        generation,
        key,
        engine: null,
        segmentationId: null,
        volumeIds: new Set(),
        volumeImageIds: new Map(),
        releasedVolumeIds: new Set(),
        signal: opts?.signal,
        disposed: false,
    };
    _activeViewerContext = context;
    context.abortListener = () => _disposeViewerContext(context);
    opts?.signal?.addEventListener("abort", context.abortListener, { once: true });
    _throwIfViewerLoadStale(context, opts?.signal);
    _organCentroids = null; // recomputed lazily for the new case's segmentation
    _customSegmentLabels = {};

    try {
    const mainNiftiURL = ctUrl;
    const segmentationURL = segUrl;
    const ctVolumeId = `bodymaps-ct-${key}-g${generation}`;
    const segmentationVolumeId = `bodymaps-seg-${key}-g${generation}`;
    context.volumeIds.add(ctVolumeId);
    if (segmentationURL) {
        context.volumeIds.add(segmentationVolumeId);
        context.segmentationId = segmentationVolumeId;
    }

    const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
    if (!toolGroup) {
        throw new Error("Failed to create tool group");
    }


    cornerstoneTools.addTool(PanTool);
    cornerstoneTools.addTool(ZoomTool);
    cornerstoneTools.addTool(StackScrollTool);
    cornerstoneTools.addTool(CrosshairsTool);
    cornerstoneTools.addTool(LengthTool);
    cornerstoneTools.addTool(ProbeTool);
    cornerstoneTools.addTool(RectangleROITool);
    cornerstoneTools.addTool(AngleTool);
    cornerstoneTools.addTool(EllipticalROITool);
    cornerstoneTools.addTool(PlanarFreehandROITool);
    cornerstoneTools.addTool(BidirectionalTool);
    cornerstoneTools.addTool(ArrowAnnotateTool);
    cornerstoneTools.addTool(AdvancedMagnifyTool);
    cornerstoneTools.addTool(BrushTool);
    cornerstoneTools.addTool(ReferenceLinesTool);
    toolGroup.addTool(PanTool.toolName);
    toolGroup.addTool(ZoomTool.toolName);
    toolGroup.addTool(StackScrollTool.toolName);
    toolGroup.addTool(LengthTool.toolName);
    toolGroup.addTool(ProbeTool.toolName);
    toolGroup.addTool(RectangleROITool.toolName);
    toolGroup.addTool(AngleTool.toolName);
    toolGroup.addTool(EllipticalROITool.toolName);
    // allowOpenContours: false — always auto-close into a polygon so it behaves like
    // the other ROI tools (area + mean/min/max HU), not an open freehand line.
    toolGroup.addTool(PlanarFreehandROITool.toolName, {
        calculateStats: true,
        allowOpenContours: false,
    });
    toolGroup.addTool(BidirectionalTool.toolName);
    toolGroup.addTool(ArrowAnnotateTool.toolName);
    toolGroup.addTool(AdvancedMagnifyTool.toolName);
    // Mask editing: paint fills the active segment, the eraser writes segment 0.
    toolGroup.addToolInstance(EDIT_BRUSH, BrushTool.toolName, {
        activeStrategy: "FILL_INSIDE_CIRCLE",
    });
    toolGroup.addToolInstance(EDIT_ERASER, BrushTool.toolName, {
        activeStrategy: "ERASE_INSIDE_CIRCLE",
    });
    // Merge our color overrides onto the existing defaults — replacing wholesale would
    // drop font/background/shadow defaults and the value labels would stop rendering.
    const defaultStyles = annotation.config.style.getDefaultToolStyles();
    annotation.config.style.setDefaultToolStyles({
        ...defaultStyles,
        global: { ...(defaultStyles.global ?? {}), ...MEASUREMENT_ANNOTATION_STYLE },
    });
    toolGroup.addTool(CrosshairsTool.toolName, {
        getReferenceLineColor,
        getReferenceLineControllable,
        getReferenceLineDraggableRotatable,
        getReferenceLineSlabThicknessControlsOn,
        // viewportIndicators: true,
        mobile: {
            enabled: false,
            opacity: 0.8,
            handleRadius: 16,
        },
        handleRadius:8
    })
    // Reference lines: one instance per pane as the "source", each showing that pane's
    // slice position as a colored line in the OTHER two — starts disabled (opt-in tool).
    for (const sourceViewportId of [viewportId1, viewportId2, viewportId3] as viewportIdTypes[]) {
        const instanceName = REFERENCE_LINES_INSTANCE_BY_SOURCE[sourceViewportId];
        toolGroup.addToolInstance(instanceName, ReferenceLinesTool.toolName, {
            sourceViewportId,
            enforceSameFrameOfReference: true,
            showFullDimension: false,
        });
        annotation.config.style.setToolGroupToolStyles(toolGroupId, {
            ...annotation.config.style.getToolGroupToolStyles(toolGroupId),
            [instanceName]: {
                color: getReferenceLineColor(sourceViewportId),
                lineWidth: 1.5,
                lineDash: REFERENCE_LINE_DASH,
            },
        });
        toolGroup.setToolDisabled(instanceName);
    }
    if (!_crosshairListenerRegistered) {
        eventTarget.addEventListener(cornerstoneTools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED, _handleCrosshairCenterChanged);
        _crosshairListenerRegistered = true;
    }

    if (currentRenderingEngine) {
        currentRenderingEngine.destroy();
        currentRenderingEngine = null;
    }

    const renderingEngine = new RenderingEngine(renderingEngineId);
    context.engine = renderingEngine;
    currentRenderingEngine = renderingEngine;

    imageLoader.registerImageLoader("nifti", cornerstoneNiftiImageLoader);
    // The CT stack either streams from a NIfTI URL (dataset cases / sessions) or is a
    // set of already-registered DICOM imageIds (local "open DICOM folder" flow).
    const imageIds = opts?.ctImageIds ?? (await _awaitWithAbort(
        createNiftiImageIdsAndCacheMetadata({ url: mainNiftiURL }),
        opts?.signal
    ));
    _claimVolumeImages(context, ctVolumeId, imageIds);
    _throwIfViewerLoadStale(context, opts?.signal);
    const segmentationImageIds = segmentationURL
    ? await _awaitWithAbort(createNiftiImageIdsAndCacheMetadata({ url: segmentationURL }), opts?.signal)
    : [];
    _claimVolumeImages(context, segmentationVolumeId, segmentationImageIds);
    _throwIfViewerLoadStale(context, opts?.signal);

    const viewportInputArray = [
        {
            viewportId: viewportId1,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element: ref1,
            defaultOptions: {
                orientation: Enums.OrientationAxis.AXIAL
            }
        },
        {
            viewportId: viewportId2,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element: ref2,
            defaultOptions: {
                orientation: Enums.OrientationAxis.SAGITTAL
            }
        },
        {
            viewportId: viewportId3,
            type: Enums.ViewportType.ORTHOGRAPHIC,
            element: ref3,
            defaultOptions: {
                orientation: Enums.OrientationAxis.CORONAL
            }
        }
    ];

    // viewportInputArray.forEach((viewport) => toolGroup)
    viewportInputArray.forEach((viewport) => toolGroup.addViewport(viewport.viewportId, renderingEngineId));
    toolGroup.setToolActive(CrosshairsTool.toolName, {
        bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }]
    })
    toolGroup.setToolActive(StackScrollTool.toolName, {
        bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }]
    })
    // Measurement tools start passive: their annotations stay selectable/editable, but
    // the primary button keeps driving the crosshair until the user picks a measure tool.
    for (const toolName of MEASUREMENT_TOOL_NAMES) {
        toolGroup.setToolPassive(toolName);
    }
    toolGroup.setToolPassive(MAGNIFY_TOOL);
    // Brush/eraser start disabled — they only own the mouse while Edit mode is on.
    for (const toolName of EDIT_TOOL_NAMES) {
        toolGroup.setToolDisabled(toolName);
    }

    renderingEngine.setViewports(viewportInputArray);

    const volume = await volumeLoader.createAndCacheVolume(ctVolumeId, { imageIds });
    _throwIfViewerLoadStale(context, opts?.signal);
    await volume.load();
    _throwIfViewerLoadStale(context, opts?.signal);
    await setVolumesForViewports(
        renderingEngine,
        [{ volumeId: ctVolumeId }],
        viewportInputArray.map((viewport) => viewport.viewportId)
    );
    _throwIfViewerLoadStale(context, opts?.signal);

    renderingEngine.renderViewports(viewportInputArray.map((viewport) => viewport.viewportId));

    if (segmentationURL && segmentationImageIds.length > 0 && segmentation) {
        const segmentationVolume = await volumeLoader.createAndCacheVolume(segmentationVolumeId, {
            imageIds: segmentationImageIds
        });
        _throwIfViewerLoadStale(context, opts?.signal);
        await segmentationVolume.load();
        _throwIfViewerLoadStale(context, opts?.signal);

        segmentation.segmentationStyle.setStyle({ type: SegmentationRepresentations.Labelmap, segmentationId: segmentationVolumeId }, DEFAULT_SEGMENTATION_CONFIG);
        segmentation.removeAllSegmentations();
        segmentation.addSegmentations([
            {
                segmentationId: segmentationVolumeId,
                representation: {
                    type: SegmentationRepresentations.Labelmap,
                    data: {
                        imageIds: segmentationImageIds,
                        volumeId: segmentationVolumeId
                    },
                },
            },
        ]);

        // Attach each actor before registering its representation. Registration alone
        // does not await actor creation and can stack duplicate masks during loading.
        await Promise.all(viewportInputArray.map(async (viewport) => {
            await addVolumeLabelmap(renderingEngine, viewport.viewportId, segmentationVolumeId, convertedColorLUT);
            segmentation.activeSegmentation.setActiveSegmentation(viewport.viewportId, segmentationVolumeId);
        }));
        _throwIfViewerLoadStale(context, opts?.signal);
    }

    _throwIfViewerLoadStale(context, opts?.signal);
    _currentCtVolumeId = ctVolumeId;
    segmentationId = segmentationURL ? segmentationVolumeId : "";
    _lastColorLUT = convertedColorLUT;
    renderingEngine.renderViewports(viewportInputArray.map((viewport) => viewport.viewportId));

    // Local DICOM can be any modality (MR, PET, …), so the CT window presets are
    // meaningless — seed the viewer with the scan's *own* VOI from the DICOM header
    // (WindowCenter/WindowWidth). Without this the default CT soft-tissue window
    // clips non-CT data flat (uniform grey). NIfTI dataset scans are CT, so they
    // keep the preset-driven default (no VOI here).
    let initialVoi: { windowCenter: number; windowWidth: number } | undefined;
    if (opts?.ctImageIds && imageIds.length) {
        const voi = metaData.get("voiLutModule", imageIds[0]) as
            | { windowCenter?: number | number[]; windowWidth?: number | number[] }
            | undefined;
        const firstNum = (v: number | number[] | undefined) =>
            Array.isArray(v) ? v[0] : v;
        const wc = firstNum(voi?.windowCenter);
        const ww = firstNum(voi?.windowWidth);
        if (typeof wc === "number" && typeof ww === "number" && ww > 0) {
            initialVoi = { windowCenter: wc, windowWidth: ww };
        }
    }

    return {
        viewportIds: viewportInputArray.map((viewport) => viewport.viewportId),
        renderingEngine: renderingEngine,
        volumeId: ctVolumeId,
        initialVoi,
        dispose: () => _disposeViewerContext(context),
    }
    } catch (error) {
        _disposeViewerContext(context);
        throw error;
    }
}


export function setVisibilities(checkState: boolean[]) {
    for (let i = 1; i < checkState.length; i++) {
        if (!segmentation.getActiveSegmentation(viewportId1)) return;
        segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, i);
        segmentation.config.visibility.setSegmentIndexVisibility(viewportId1, { segmentationId: segmentationId, type: csToolsEnums.SegmentationRepresentations.Labelmap }, i, checkState[i]);
        segmentation.config.visibility.setSegmentIndexVisibility(viewportId2, { segmentationId: segmentationId, type: csToolsEnums.SegmentationRepresentations.Labelmap }, i, checkState[i]);
        segmentation.config.visibility.setSegmentIndexVisibility(viewportId3, { segmentationId: segmentationId, type: csToolsEnums.SegmentationRepresentations.Labelmap }, i, checkState[i]);
    }
    // The loop above walks setActiveSegmentIndex through every id — restore the one the
    // brush is targeting, or edits would silently land on the last organ in the list.
    // Guarded: this effect also fires on mount, before the segmentation exists, and
    // setActiveSegmentIndex throws on a missing segmentation (blanks the whole page).
    try {
        if (segmentation.getActiveSegmentation(viewportId1)) {
            segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, _activeEditSegment);
        }
    } catch {
        /* segmentation not loaded yet */
    }
    if (currentRenderingEngine) {
        currentRenderingEngine.renderViewports([viewportId1, viewportId2, viewportId3]);
        currentRenderingEngine.render();
    }

};


// Fill (the solid organ color wash) and outline (the border traced around each segment)
// are independently controllable — both 0–1. Previously a single "opacity" divided
// whatever value it was given by 2.4 before applying it, so even 100% only ever reached
// ~42% actual alpha; that division is gone. renderOutline defaults to false in
// DEFAULT_SEGMENTATION_CONFIG (no border at all, regardless of outlineOpacity), so this
// also flips it on/off based on whether the outline slider is above zero.
// SegmentationStyle.setStyle merges onto the existing style by default (its `merge`
// param defaults to true), so fill and outline can each be set independently without
// either call needing to know the other's current value.
function _setSegmentationStyle(style: Record<string, unknown>) {
    segmentation.config.style.setStyle(
        { type: csToolsEnums.SegmentationRepresentations.Labelmap, segmentationId },
        style as Parameters<typeof segmentation.config.style.setStyle>[1]
    );
    if (currentRenderingEngine) {
        currentRenderingEngine.renderViewports([viewportId1, viewportId2, viewportId3]);
        currentRenderingEngine.render();
    }
}

export function setFillOpacity(fillOpacity: number) {
    _setSegmentationStyle({
        // Cornerstone's renderFill=false path still writes 0.01 opacity to the
        // labelmap transfer function. Keep fill rendering enabled and set alpha
        // to zero instead, so 0% removes the tint without changing borders.
        renderFill: true,
        renderFillInactive: true,
        fillAlpha: fillOpacity,
        fillAlphaInactive: fillOpacity,
    });
}

// renderOutline defaults to false in DEFAULT_SEGMENTATION_CONFIG (no border at all,
// regardless of outlineOpacity), so this flips it on/off based on whether the slider
// is above zero.
export function setOutlineOpacity(outlineOpacity: number) {
    _setSegmentationStyle({
        renderOutline: outlineOpacity > 0,
        outlineOpacity: outlineOpacity,
        outlineOpacityInactive: outlineOpacity,
        outlineWidth: DEFAULT_SEGMENTATION_CONFIG.outlineWidth,
    });
}

export function toggleCrosshairTool(enable: boolean) {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;
  if (enable) {
    toolGroup.setToolActive(CrosshairsTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
    });
    toolGroup.setToolDisabled(PanTool.toolName);
  } else {
    toolGroup.setToolDisabled(CrosshairsTool.toolName);
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
    });
  }
}

/**
 * Releases the primary mouse button from ALL navigation tools (Crosshairs and
 * Pan) so that a React-side drag handler (e.g. AI Box Segment) owns the
 * primary button exclusively. No Cornerstone tool is left active on primary,
 * which means Cornerstone won't pan/navigate while the user draws a box.
 *
 * Call this instead of toggleCrosshairTool(false) when activating
 * pointSegment or boxSegment. Restore with toggleCrosshairTool(crosshairActive)
 * on deactivation — the existing restore path in VisualizationPage's effect
 * already does the right thing.
 */
export function releasePromptMouseButton() {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;
  toolGroup.setToolDisabled(CrosshairsTool.toolName);
  toolGroup.setToolDisabled(PanTool.toolName);
}

// The magnify loupes only make sense while the tool is in hand — remove them when
// it's put down (AdvancedMagnify cleans up its magnify viewport on ANNOTATION_REMOVED).
function _removeMagnifyAnnotations() {
  try {
    const all = annotation.state.getAllAnnotations() ?? [];
    for (const a of [...all]) {
      if (a?.metadata?.toolName === MAGNIFY_TOOL && a.annotationUID) {
        annotation.state.removeAnnotation(a.annotationUID);
      }
    }
  } catch {
    /* annotation state not ready */
  }
}

// Activate a measurement tool (or the magnify loupe) on the primary mouse button, or
// pass `null` to hand the primary button back to navigation (the caller restores
// crosshair/pan afterwards). While one is active we disable crosshair + pan so clicks
// draw, not navigate.
export function setActiveMeasurementTool(toolName: PrimaryMouseToolName | null) {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;
  // Reset every measure tool to passive first (keeps existing annotations editable).
  for (const name of [...MEASUREMENT_TOOL_NAMES, MAGNIFY_TOOL]) toolGroup.setToolPassive(name);
  if (toolName !== MAGNIFY_TOOL) _removeMagnifyAnnotations();
  if (!toolName) return;
  toolGroup.setToolDisabled(CrosshairsTool.toolName);
  toolGroup.setToolDisabled(PanTool.toolName);
  for (const name of EDIT_TOOL_NAMES) toolGroup.setToolDisabled(name);
  toolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
  });
}

// ---------------------------------------------------------------------------
// Mask editing — brush/eraser over the segmentation labelmap, undo/redo via
// Cornerstone's history, and export of the edited labelmap for download.
// ---------------------------------------------------------------------------

// The segment the brush paints. Module-level so setVisibilities can restore it
// (its loop clobbers the active segment index).
let _activeEditSegment = 1;

export function hasSegmentation(): boolean {
  return !!cache.getVolume(segmentationId);
}

// Hand the primary button to the brush or eraser, or pass null to release it
// (the caller then restores measurement/navigation ownership).
export function setActiveMaskEditTool(toolName: MaskEditToolName | null) {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;
  for (const name of EDIT_TOOL_NAMES) toolGroup.setToolDisabled(name);
  if (!toolName) return;
  toolGroup.setToolDisabled(CrosshairsTool.toolName);
  toolGroup.setToolDisabled(PanTool.toolName);
  for (const name of MEASUREMENT_TOOL_NAMES) toolGroup.setToolPassive(name);
  toolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
  });
}

// BrushTool's circular cursor preview doesn't reliably clear on pointerleave
// when the same shared toolGroup covers all three MPR viewports at once —
// moving between panes can leave a stale brush circle painted in the pane
// just left. Call this from each pane's onMouseLeave while paint/erase is
// active to force a fresh render and drop the stale overlay.
export function clearMaskEditCursor(pane: CinePane) {
  if (!currentRenderingEngine) return;
  const viewportId = CINE_VIEWPORT_BY_PANE[pane];
  if (!viewportId) return;
  currentRenderingEngine.renderViewports([viewportId]);
}

// Picks a color for a brand-new segment index by cycling through the NEW_CLASS_PALETTE.
export function colorForNewClass(segmentIndex: number): Color {
  return NEW_CLASS_PALETTE[(segmentIndex - 1) % NEW_CLASS_PALETTE.length];
}

export function getCustomSegmentLabels(): Readonly<Record<number, string>> {
  return _customSegmentLabels;
}

export type CustomLabelEntry = { name: string; color: Color };

// Snapshot of every custom class's name + color, keyed by segment index.
export function getCustomSegmentLabelsForExport(): Record<number, CustomLabelEntry> {
  const out: Record<number, CustomLabelEntry> = {};
  for (const [idxStr, name] of Object.entries(_customSegmentLabels)) {
    const idx = Number(idxStr);
    const color = _lastColorLUT?.[idx];
    if (color) out[idx] = { name, color: [...color] as Color };
  }
  return out;
}


function _ensureColorLutSlot(segmentIndex: number, color: Color) {
  if (!_lastColorLUT) return;
  while (_lastColorLUT.length <= segmentIndex) {
    _lastColorLUT.push([0, 0, 0, 0]);
  }
  _lastColorLUT[segmentIndex] = [...color] as Color;
}

// Register a colour for a segment index on every MPR viewport and keep the cached LUT
// in sync so exports / rebuilds pick it up.
export function registerNewSegmentColor(segmentIndex: number, color: Color) {
  _ensureColorLutSlot(segmentIndex, color);
  for (const viewportId of MPR_VIEWPORT_IDS) {
    try {
      segmentation.config.color.setSegmentIndexColor(
        viewportId,
        segmentationId,
        segmentIndex,
        color
      );
    } catch {
      // viewport not yet initialised
    }
  }
  if (currentRenderingEngine) {
    currentRenderingEngine.renderViewports([...MPR_VIEWPORT_IDS]);
    currentRenderingEngine.render();
  }
}

function _getNextAvailableSegmentIndex(): number {
  let max = 0;
  for (const idx of Object.keys(_customSegmentLabels)) {
    max = Math.max(max, Number(idx));
  }
  if (_lastColorLUT) {
    max = Math.max(max, _lastColorLUT.length - 1);
  }
  const volume = cache.getVolume(segmentationId);
  const data = volume?.voxelManager?.getCompleteScalarDataArray?.();
  if (data) {
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (typeof v === "number") max = Math.max(max, v);
    }
  }
  return max + 1;
}

// Create a new labelmap class the brush can paint. Returns null if no segmentation is loaded.
export function createNewAnnotationClass(
  name: string,
  color?: Color
): { segmentIndex: number; color: Color } | null {
  if (!hasSegmentation()) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  const segmentIndex = _getNextAvailableSegmentIndex();
  const assignedColor = color ?? colorForNewClass(segmentIndex);

  registerNewSegmentColor(segmentIndex, assignedColor);
  _customSegmentLabels[segmentIndex] = trimmed;

  for (const viewportId of MPR_VIEWPORT_IDS) {
    try {
      segmentation.config.visibility.setSegmentIndexVisibility(
        viewportId,
        { segmentationId, type: csToolsEnums.SegmentationRepresentations.Labelmap },
        segmentIndex,
        true
      );
    } catch {
      //viewport not yet initialised
    }
  }

  setActiveEditSegment(segmentIndex);
  return { segmentIndex, color: assignedColor };
}


// Cornerstone's setBrushSizeForToolGroup takes a RADIUS in world mm, but
// everywhere in our own UI (the slider, its label, the dashed size-preview
// overlay) treats the value as a DIAMETER — that's what "Brush Size: 10mm"
// and a 10mm-wide preview circle mean to the user. Passing the diameter
// straight through as if it were the radius was making the actually-painted
// circle twice as wide as the size the user picked (and than the preview
// overlay showed), which is why the preview never matched what landed on
// the segmentation. Halve it here, at the one place diameter becomes radius,
// so every caller can keep speaking in diameter mm.
export function setMaskBrushSize(diameterMm: number) {
  try {
    cornerstoneTools.utilities.segmentation.setBrushSizeForToolGroup(toolGroupId, diameterMm / 2);
  } catch {
    /* tool group not ready */
  }
}

// ---------------------------------------------------------------------------
// Single global undo/redo. Brush/eraser strokes are recorded by Cornerstone's
// own HistoryMemo; every other edit (smart fill, morphology, boolean ops,
// interpolation, copy-across-slices, lasso, CPR paint, box prompt formerly)
// is recorded on our own _fillHistory stack (see below). The two don't
// interleave with each other, so we just prefer whichever stack actually has
// something to undo/redo — in practice the user's most recent action is
// always on top of ONE of the two, so this behaves as a single button.
// ---------------------------------------------------------------------------
export function undoMaskEdit() {
  // Prefer whichever stack was touched more recently, not always the fill
  // stack — a brush stroke after a box-segment (or vice versa) must undo in
  // the order it actually happened.
  if (canUndoSmartFill() && _lastFillEditTime >= _lastBrushEditTime) {
    undoSmartFill();
    return;
  }
  csCoreUtils.HistoryMemo.DefaultHistoryMemo.undo();
  currentRenderingEngine?.render();
}

export function redoMaskEdit() {
  if (canRedoSmartFill() && _lastFillEditTime >= _lastBrushEditTime) {
    redoSmartFill();
    return;
  }
  csCoreUtils.HistoryMemo.DefaultHistoryMemo.redo();
  currentRenderingEngine?.render();
}

export function getMaskEditHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const h = csCoreUtils.HistoryMemo.DefaultHistoryMemo;
  return {
    canUndo: canUndoSmartFill() || h.canUndo,
    canRedo: canRedoSmartFill() || h.canRedo,
  };
}

// Fires whenever any stroke (or undo/redo of one) changes the labelmap.
export function subscribeToSegmentationEdits(cb: (detail?: SegmentationEditDetail) => void): () => void {
  const handler = (event: Event) => {
    if (_remoteSegmentationEventDepth > 0) return;
    const detail = (event as CustomEvent).detail as SegmentationEditDetail | undefined;
    // Static server meshes become stale after any local edit, so the 3D pane
    // switches the affected segment to a live marching-cubes mesh.
    markSegmentEdited(detail?.segmentIndex ?? _activeEditSegment);
    cb(detail);
  };
  eventTarget.addEventListener(
    csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED,
    handler as EventListener
  );
  return () =>
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED,
      handler as EventListener
    );
}
// Segment indices touched by ANY edit since the case loaded — lets the 3D
// pane know which organs need a live marching-cubes mesh instead of the
// stale server-generated GLB.
const _editedSegmentIndices = new Set<number>();

export function getEditedSegments(): ReadonlySet<number> {
  return _editedSegmentIndices;
}

export function markSegmentEdited(segmentIndex: number) {
  _editedSegmentIndices.add(segmentIndex);
}

export function clearEditedSegments() {
  _editedSegmentIndices.clear();
  _preEditMaskSnapshots.clear();
}

export type SegmentationEditDetail = {
  modifiedSlicesToUse?: number[];
  segmentIndex?: number;
};

export type MaskRange = {
  start: number;
  length: number;
  before: number;
  after: number;
};

let _remoteSegmentationEventDepth = 0;

/** Snapshot used to diff only slices Cornerstone says a local stroke modified. */
export function createSegmentationShadow(): Uint8Array | null {
  const current = getSegmentationExport();
  if (!current) return null;
  const shadow = new Uint8Array(current.data.length);
  for (let i = 0; i < current.data.length; i++) shadow[i] = Number(current.data[i]);
  return shadow;
}

/** Build constant before/after runs and advance the caller's shadow in place. */
export function diffSegmentationFromShadow(
  shadow: Uint8Array,
  modifiedSlices?: number[]
): MaskRange[] {
  const current = getSegmentationExport();
  if (!current || current.data.length !== shadow.length) return [];
  const [width, height, depth] = current.dimensions;
  const sliceSize = width * height;
  const slices = modifiedSlices?.length
    ? [...new Set(modifiedSlices.filter((slice) => slice >= 0 && slice < depth))].sort((a, b) => a - b)
    : Array.from({ length: depth }, (_, index) => index);
  const ranges: MaskRange[] = [];
  let active: MaskRange | null = null;
  for (const slice of slices) {
    const first = slice * sliceSize;
    const end = Math.min(first + sliceSize, current.data.length);
    for (let index = first; index < end; index++) {
      const before = shadow[index];
      const after = Number(current.data[index]);
      if (before === after) continue;
      shadow[index] = after;
      if (
        active &&
        active.start + active.length === index &&
        active.before === before &&
        active.after === after
      ) {
        active.length += 1;
      } else {
        active = { start: index, length: 1, before, after };
        ranges.push(active);
      }
    }
    active = null; // never merge across an uninspected slice boundary
  }
  return ranges;
}

/** Apply server-ordered ranges without re-emitting them as local brush strokes. */
export function applyRemoteMaskRanges(ranges: MaskRange[], shadow?: Uint8Array | null): void {
  const volume = cache.getVolume(segmentationId);
  const vm = volume?.voxelManager;
  if (!volume || !vm || !ranges.length) return;
  const scalar = vm.getCompleteScalarDataArray?.() as
    | Uint8Array
    | Uint16Array
    | Float32Array
    | undefined;
  const modifiedSlices = new Set<number>();
  const modifiedSegments = new Set<number>();
  const sliceSize = volume.dimensions[0] * volume.dimensions[1];
  for (const range of ranges) {
    if (range.before > 0) modifiedSegments.add(range.before);
    if (range.after > 0) modifiedSegments.add(range.after);
    const end = range.start + range.length;
    for (let index = range.start; index < end; index++) {
      if (scalar) scalar[index] = range.after;
      else vm.setAtIndex(index, range.after);
      if (shadow && index < shadow.length) shadow[index] = range.after;
    }
    const firstSlice = Math.floor(range.start / sliceSize);
    const lastSlice = Math.floor((end - 1) / sliceSize);
    for (let slice = firstSlice; slice <= lastSlice; slice++) modifiedSlices.add(slice);
  }
  for (const segmentIndex of modifiedSegments) markSegmentEdited(segmentIndex);
  _remoteSegmentationEventDepth += 1;
  try {
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      [...modifiedSlices]
    );
  } finally {
    _remoteSegmentationEventDepth -= 1;
  }
  currentRenderingEngine?.render();
}

export type LabelmapExport = {
  dimensions: number[];
  spacing: number[];
  origin: number[];
  /** Nine values, LPS world axes: i-axis [0..2], j-axis [3..5], k-axis [6..8]. */
  direction: number[];
  data: ArrayLike<number>;
};

// Current (possibly edited) labelmap + geometry, for the NIfTI download.
export function getSegmentationExport(): LabelmapExport | null {
  const volume = cache.getVolume(segmentationId);
  const vm = volume?.voxelManager;
  if (!volume || !vm) return null;
  let data: ArrayLike<number> | undefined;
  try {
    data = vm.getCompleteScalarDataArray?.();
  } catch {
    return null;
  }
  if (!data || !data.length) return null;
  return {
    dimensions: [...volume.dimensions],
    spacing: [...volume.spacing],
    origin: [...volume.origin],
    direction: [...volume.direction],
    data,
  };
}

// Remove only measurement annotations (and any magnify loupes), leaving the crosshair intact.
export function clearMeasurements() {
  try {
    const all = annotation.state.getAllAnnotations() ?? [];
    const names = [...MEASUREMENT_TOOL_NAMES, MAGNIFY_TOOL] as readonly string[];
    for (const a of [...all]) {
      const toolName = a?.metadata?.toolName;
      if (toolName && names.includes(toolName) && a.annotationUID) {
        annotation.state.removeAnnotation(a.annotationUID);
      }
    }
  } catch {
    /* annotation state may not be ready (e.g. before first render) — no-op */
  }
  currentRenderingEngine?.render();
}

// ---------------------------------------------------------------------------
// Measurement inventory — a UI-friendly view over Cornerstone's annotation
// state, powering the Measurements panel and the reading-session report.
// ---------------------------------------------------------------------------

export type MeasurementSummary = {
  uid: string;
  tool: string;
  /** User-assigned name (e.g. "lesion"); empty until renamed. */
  label: string;
  /** Formatted value, e.g. "42.3 mm", "37.5°", "512 mm² · mean 45 HU". */
  value: string;
  /** World-mm center of the annotation's handles (jump target), if known. */
  center: [number, number, number] | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- annotation payloads are untyped */
function formatNum(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "?";
}

// Each tool caches different stats keys; scan for the ones we know how to show.
function formatAnnotationValue(a: any): string {
  // ArrowAnnotate stores its note as free text, not cached stats.
  const text = a?.data?.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  const statsByTarget = a?.data?.cachedStats ?? {};
  for (const stats of Object.values(statsByTarget) as any[]) {
    if (!stats || typeof stats !== "object") continue;
    // Bidirectional: long × short axis (RECIST-style).
    if (typeof stats.length === "number" && typeof stats.width === "number") {
      return `${formatNum(stats.length)} × ${formatNum(stats.width)} ${stats.unit ?? "mm"}`;
    }
    if (typeof stats.length === "number") return `${formatNum(stats.length)} ${stats.unit ?? "mm"}`;
    if (typeof stats.angle === "number") return `${formatNum(stats.angle)}°`;
    if (typeof stats.area === "number") {
      const area = `${formatNum(stats.area, 0)} ${stats.areaUnit ?? "mm²"}`;
      return typeof stats.mean === "number" ? `${area} · mean ${formatNum(stats.mean, 0)} HU` : area;
    }
    if (typeof stats.value === "number") return `${formatNum(stats.value, 0)} HU`;
    if (typeof stats.mean === "number") return `mean ${formatNum(stats.mean, 0)} HU`;
  }
  return "…";
}

function annotationCenter(a: any): [number, number, number] | null {
  // Most tools keep their corner/endpoint handles in data.handles.points. The
  // freehand ROI's outline lives in data.contour.polyline instead (handles.points
  // stays empty for it) — fall back to averaging that when handles are empty.
  const pts = (a?.data?.handles?.points?.length
    ? a.data.handles.points
    : a?.data?.contour?.polyline) as number[][] | undefined;
  if (!pts?.length) return null;
  const c: [number, number, number] = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
}

function toSummary(a: any): MeasurementSummary {
  return {
    uid: String(a.annotationUID),
    tool: String(a?.metadata?.toolName ?? ""),
    label: String(a?.data?.label ?? ""),
    value: formatAnnotationValue(a),
    center: annotationCenter(a),
  };
}

export function getMeasurementSummaries(): MeasurementSummary[] {
  try {
    const all = annotation.state.getAllAnnotations() ?? [];
    const names = MEASUREMENT_TOOL_NAMES as readonly string[];
    return (all as any[])
      .filter((a) => a?.annotationUID && names.includes(a?.metadata?.toolName))
      .map(toSummary);
  } catch {
    return [];
  }
}

export function renameMeasurement(uid: string, label: string) {
  const a = annotation.state.getAnnotation(uid) as any;
  if (!a?.data) return;
  a.data.label = label;
  currentRenderingEngine?.render();
}

export function removeMeasurement(uid: string) {
  try { annotation.state.removeAnnotation(uid); } catch { /* already gone */ }
  currentRenderingEngine?.render();
}

export type SharedMeasurement = {
  id: string;
  tool: string;
  points: number[][];
  polyline: number[][];
  text: string;
  label: string;
  frame_of_reference: string;
  metadata: Record<string, unknown>;
  revision?: number;
};

let _remoteMeasurementEventDepth = 0;

function finitePointList(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((point) => Array.isArray(point) && point.length === 3)
    .map((point) => (point as number[]).map(Number))
    .filter((point) => point.every(Number.isFinite));
}

/** Serialize only portable world-coordinate fields; cached statistics stay local. */
export function serializeMeasurement(uid: string): SharedMeasurement | null {
  const a = annotation.state.getAnnotation(uid) as any;
  if (!a?.annotationUID || !MEASUREMENT_TOOL_NAMES.includes(a?.metadata?.toolName)) return null;
  const metadata = a.metadata ?? {};
  return {
    id: String(a.annotationUID),
    tool: String(metadata.toolName),
    points: finitePointList(a?.data?.handles?.points),
    polyline: finitePointList(a?.data?.contour?.polyline),
    text: String(a?.data?.text ?? ""),
    label: String(a?.data?.label ?? ""),
    frame_of_reference: String(metadata.FrameOfReferenceUID ?? ""),
    metadata: {
      referencedImageId: metadata.referencedImageId,
      viewPlaneNormal: metadata.viewPlaneNormal,
      viewUp: metadata.viewUp,
      FrameOfReferenceUID: metadata.FrameOfReferenceUID,
    },
  };
}

export function applyRemoteMeasurement(shared: SharedMeasurement): void {
  const engine = currentRenderingEngine;
  if (!engine || !MEASUREMENT_TOOL_NAMES.includes(shared.tool as MeasurementToolName)) return;
  const viewport = engine.getViewport(viewportId1);
  if (!viewport?.element) return;
  const existing = annotation.state.getAnnotation(shared.id);
  _remoteMeasurementEventDepth += 1;
  try {
    if (existing) annotation.state.removeAnnotation(shared.id);
    const metadata = shared.metadata ?? {};
    annotation.state.addAnnotation(
      {
        annotationUID: shared.id,
        highlighted: false,
        invalidated: true,
        metadata: {
          toolName: shared.tool,
          referencedImageId: metadata.referencedImageId,
          viewPlaneNormal: metadata.viewPlaneNormal,
          viewUp: metadata.viewUp,
          FrameOfReferenceUID: shared.frame_of_reference || metadata.FrameOfReferenceUID,
        },
        data: {
          handles: { points: shared.points },
          contour: shared.polyline.length ? { polyline: shared.polyline, closed: true } : undefined,
          text: shared.text,
          label: shared.label,
        },
      } as any,
      viewport.element
    );
  } finally {
    _remoteMeasurementEventDepth -= 1;
  }
  engine.render();
}

export function removeRemoteMeasurement(uid: string): void {
  _remoteMeasurementEventDepth += 1;
  try {
    annotation.state.removeAnnotation(uid);
  } catch {
    /* already removed */
  } finally {
    _remoteMeasurementEventDepth -= 1;
  }
  currentRenderingEngine?.render();
}

// Moves the crosshair to the annotation and returns the target (so the caller
// can also sync its own crosshair state / the 3D view).
export function jumpToMeasurement(uid: string): [number, number, number] | null {
  const a = annotation.state.getAnnotation(uid) as any;
  const c = annotationCenter(a);
  if (!c) return null;
  moveCornerstoneCrosshairToMm(c);
  currentRenderingEngine?.render();
  return c;
}

// ---------------------------------------------------------------------------
// Cine playback — auto-scroll one MPR pane through its slices at a fixed frame
// rate. Hand-rolled with a plain setInterval + viewport.scroll(), NOT
// cornerstoneTools.utilities.cine.playClip: that utility resolves which
// volume to scroll via an internal "smallest spacing" heuristic across every
// actor on the viewport when no volumeId is given, and its own volume-viewport
// play path never passes one — with both the CT volume AND the segmentation
// labelmap attached to each pane, that heuristic can pick the wrong actor (or
// one with a degenerate slice range), so nothing visibly moves.
// viewport.scroll(delta) sidesteps this entirely: it resolves the volume via
// viewport.getVolumeId() (the same thing StackScrollTool does for wheel-driven
// scrolling), so it's guaranteed to move the actual displayed CT.
// ---------------------------------------------------------------------------

export type CinePane = "axial" | "sagittal" | "coronal";
export const CINE_VIEWPORT_BY_PANE: Record<CinePane, string> = {
  axial: viewportId1,
  sagittal: viewportId2,
  coronal: viewportId3,
};

// Every per-pane MPR operation (cine, flip, rotate, slice tracking) needs the same cast:
// IViewport (what getViewport() is typed to return) only exposes the narrower base
// Viewport surface, but the concrete object is a BaseVolumeViewport where all of this is
// genuinely present at runtime — same rationale as getCrosshairMm's toolCenter cast
// elsewhere in this file.
type MprViewport = {
  element: HTMLDivElement;
  scroll(delta?: number): void;
  getNumberOfSlices(): number;
  getSliceIndex(): number;
  getCamera(): { focalPoint?: Point3; viewPlaneNormal?: Point3 };
  flip(flipDirection: { flipHorizontal?: boolean; flipVertical?: boolean }): void;
  getRotation(): number;
  setRotation(rotation: number): void;
  worldToCanvas(world: Point3): Point2;
  render(): void;
};

function _getMprViewport(pane: CinePane): MprViewport | undefined {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return undefined;
  return engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as unknown as MprViewport | undefined;
}

let _cineIntervalId: number | null = null;

export function startCine(pane: CinePane, fps = 12): boolean {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return false;
  stopCine(); // one clip at a time
  try {
    const viewport = _getMprViewport(pane);
    if (!viewport) return false;
    const numSlices = viewport.getNumberOfSlices();
    if (!numSlices || numSlices < 2) return false;
    const clampedFps = Math.max(1, Math.min(100, fps));
    _cineIntervalId = window.setInterval(() => {
      // Loop back to the first slice once past the last — viewport.scroll clamps
      // rather than wraps, so a step past the end needs an explicit jump to 0.
      const current = viewport.getSliceIndex();
      viewport.scroll(current >= numSlices - 1 ? -current : 1);
    }, 1000 / clampedFps);
    return true;
  } catch (e) {
    console.warn("Cine playback unavailable:", e);
    return false;
  }
}

export function stopCine() {
  if (_cineIntervalId === null) return;
  window.clearInterval(_cineIntervalId);
  _cineIntervalId = null;
}

// ---------------------------------------------------------------------------
// Per-pane flip / rotate — like Cine, these act on whichever pane is currently
// "in focus" (VisualizationPage tracks that via scroll/click and passes it in).
// ---------------------------------------------------------------------------

// Mirrors the pane left-right. flip() toggles internally (this.flipHorizontal =
// !this.flipHorizontal), so calling it again on the same pane un-flips it — the
// toggle behavior lives in Cornerstone itself, nothing to track on our side.
// It also self-renders, unlike setRotation below.
export function flipPaneHorizontal(pane: CinePane): void {
  const viewport = _getMprViewport(pane);
  if (!viewport) return;
  try {
    viewport.flip({ flipHorizontal: true });
  } catch (e) {
    console.warn(`Flip failed for pane "${pane}":`, e);
  }
}

// Rotates 90° clockwise from wherever the pane currently sits (cumulative — four
// clicks return to the start). NOTE: cornerstone's rotation-angle sign convention
// relative to "on-screen clockwise" isn't independently confirmed here — if a
// case turns out to visibly rotate counter-clockwise instead, flip the `+ 90`
// below to `- 90` (mod still needs the `+ 360` to stay positive in that case).
export function rotatePane90Clockwise(pane: CinePane): void {
  const viewport = _getMprViewport(pane);
  if (!viewport) return;
  try {
    const next = (viewport.getRotation() + 90) % 360;
    viewport.setRotation(next);
    // Unlike flip(), setRotation() only triggers a CAMERA_MODIFIED event — it
    // never calls render() itself, so without this the rotation wouldn't show
    // until some unrelated interaction happened to re-render the pane.
    viewport.render();
  } catch (e) {
    console.warn(`Rotate failed for pane "${pane}":`, e);
  }
}

// ---------------------------------------------------------------------------
// Slice tracking — drives the per-pane "245/519" caption + drag scrollbar.
// ---------------------------------------------------------------------------

export type SliceInfo = { current: number; total: number };

// Jumps a pane directly to an arbitrary slice (the scrollbar drag target), rather than
// the +1/-1 steps cine/wheel-scroll use. scroll(delta) clamps to the valid range, so an
// out-of-range index (e.g. from a stale `total`) is harmless.
export function setPaneSliceIndex(pane: CinePane, index: number): void {
  const viewport = _getMprViewport(pane);
  if (!viewport) return;
  const delta = index - viewport.getSliceIndex();
  if (delta !== 0) viewport.scroll(delta);
}

export function worldToPaneCanvas(
  pane: CinePane,
  world: [number, number, number]
): [number, number] | null {
  const viewport = _getMprViewport(pane);
  if (!viewport) return null;
  try {
    const point = viewport.worldToCanvas(world as Point3);
    return [Number(point[0]), Number(point[1])];
  } catch {
    return null;
  }
}

// Project a world-space marker only while its point is near the pane currently on
// screen. worldToCanvas alone projects points from every depth onto the active plane,
// which made pinned notes appear to follow users through the entire scan. Tolerance is
// expressed in slices so anisotropic CTs remain forgiving without a fixed-mm guess.
export function worldToVisiblePaneCanvas(
  pane: CinePane,
  world: [number, number, number],
  toleranceSlices = 1.25
): [number, number] | null {
  const viewport = _getMprViewport(pane);
  if (!viewport) return null;
  try {
    const camera = viewport.getCamera();
    const focalPoint = camera.focalPoint;
    const normal = camera.viewPlaneNormal;
    if (!focalPoint || !normal) return null;
    const distanceMm = Math.abs(
      (world[0] - focalPoint[0]) * normal[0]
      + (world[1] - focalPoint[1]) * normal[1]
      + (world[2] - focalPoint[2]) * normal[2]
    );
    const volume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
    const measuredSpacing = volume
      ? csCoreUtils.getSpacingInNormalDirection(volume, normal)
      : 1;
    const sliceSpacing = Number.isFinite(measuredSpacing) && measuredSpacing > 0 ? measuredSpacing : 1;
    const toleranceMm = Math.max(2, sliceSpacing * Math.max(0, toleranceSlices));
    if (!Number.isFinite(distanceMm) || distanceMm > toleranceMm) return null;
    return worldToPaneCanvas(pane, world);
  } catch {
    return null;
  }
}

// Live slice index read directly from the viewport — use this instead of the
// (possibly one-render-stale) React `sliceInfo` state whenever you need the
// EXACT slice the user is looking at right now (e.g. marking an endpoint).
export function getCurrentSliceIndexLive(pane: CinePane): number {
  const viewport = _getMprViewport(pane);
  return viewport ? viewport.getSliceIndex() : 0;
}
// Returns the REAL volume-space through-plane index for whatever slice the pane
// is currently showing, derived from the viewport's camera focal point (world mm)
// rather than trusting viewport.getSliceIndex() to equal the raw IJK k-index —
// that assumption breaks for any volume whose direction matrix isn't identity.
export function getVolumeSliceIndexForPane(pane: CinePane): number | null {
  const engine = getRenderingEngine(renderingEngineId);
  const volume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  if (!engine || !volume?.imageData) return null;
  const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as any;
  if (!viewport) return null;
  try {
    const camera = viewport.getCamera();
    const focal = camera.focalPoint as number[];
    const ijk = volume.imageData.worldToIndex(focal).map((v: number) => Math.round(v));
    const axis = _sliceAxisForPane(pane);
    return ijk[axis];
  } catch {
    return null;
  }
}
// Fires `cb` once immediately per pane (so the caller has an initial reading) and again
// on every CAMERA_MODIFIED where the slice index actually changed — pan/zoom/rotate also
// fire that event, so each pane's last-seen index is compared to avoid spamming the
// caller (and the React state it likely feeds) on every unrelated camera tweak. Returns
// an unsubscribe function; call it before the volume/tool group is torn down (case
// switch, HD reload) since the viewport elements go with it.
export function subscribeToSliceChanges(cb: (pane: CinePane, info: SliceInfo) => void): () => void {
  const panes = Object.keys(CINE_VIEWPORT_BY_PANE) as CinePane[];
  const cleanups: (() => void)[] = [];
  for (const pane of panes) {
    const viewport = _getMprViewport(pane);
    if (!viewport) continue;
    let lastIndex = viewport.getSliceIndex();
    cb(pane, { current: lastIndex, total: viewport.getNumberOfSlices() });
    const handler = () => {
      const current = viewport.getSliceIndex();
      if (current === lastIndex) return;
      lastIndex = current;
      cb(pane, { current, total: viewport.getNumberOfSlices() });
    };
    viewport.element.addEventListener(Enums.Events.CAMERA_MODIFIED, handler);
    cleanups.push(() => viewport.element.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler));
  }
  return () => cleanups.forEach((fn) => fn());
}

// Undo any oblique-plane rotation / slab thickness back to standard orthogonal
// axial/sagittal/coronal (the crosshair's rotation handles create oblique planes;
// this is the way back). Also recenters and resets zoom/pan on all three panes.
export function resetMprOrientation() {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  const tool = toolGroup?.getToolInstance(CrosshairsTool.toolName) as
    | { resetCrosshairs?: () => void }
    | undefined;
  try {
    tool?.resetCrosshairs?.();
  } catch {
    /* crosshair tool not active/ready */
  }
  currentRenderingEngine?.render();
}

export type MeasurementChangeKind = "completed" | "modified" | "removed";

// Fires for measurement annotations only (crosshair events are filtered out).
export function subscribeToMeasurementChanges(
  cb: (kind: MeasurementChangeKind, summary: MeasurementSummary) => void
): () => void {
  const names = MEASUREMENT_TOOL_NAMES as readonly string[];
  const make = (kind: MeasurementChangeKind) => (evt: Event) => {
    if (_remoteMeasurementEventDepth > 0) return;
    const a = (evt as CustomEvent).detail?.annotation;
    if (!a?.annotationUID || !names.includes(a?.metadata?.toolName)) return;
    cb(kind, toSummary(a));
  };
  const pairs: [string, EventListener][] = [
    [cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED, make("completed") as EventListener],
    [cornerstoneTools.Enums.Events.ANNOTATION_MODIFIED, make("modified") as EventListener],
    [cornerstoneTools.Enums.Events.ANNOTATION_REMOVED, make("removed") as EventListener],
  ];
  const historyRedo = ((evt: Event) => {
    if (_remoteMeasurementEventDepth > 0) return;
    const annotationUid = (evt as CustomEvent).detail?.id as unknown;
    const restored = typeof annotationUid === "string" ? annotation.state.getAnnotation(annotationUid) : null;
    const toolName = restored?.metadata?.toolName as unknown;
    if (!restored?.annotationUID || typeof toolName !== "string" || !names.includes(toolName)) return;
    cb("completed", toSummary(restored));
  }) as EventListener;
  pairs.push(["CORNERSTONE_TOOLS_HISTORY_REDO", historyRedo]);
  for (const [name, handler] of pairs) eventTarget.addEventListener(name, handler);
  return () => {
    for (const [name, handler] of pairs) eventTarget.removeEventListener(name, handler);
  };
}

export type SharedCamera = {
  focalPoint?: number[];
  position?: number[];
  viewUp?: number[];
  viewPlaneNormal?: number[];
  parallelScale?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
};

export type SharedMprView = {
  cameras: Partial<Record<CinePane, SharedCamera>>;
  crosshair: [number, number, number] | null;
};

function cameraForShare(camera: any): SharedCamera {
  const copyVector = (value: unknown) => Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from(value as ArrayLike<number>, Number)
    : undefined;
  return {
    focalPoint: copyVector(camera?.focalPoint),
    position: copyVector(camera?.position),
    viewUp: copyVector(camera?.viewUp),
    viewPlaneNormal: copyVector(camera?.viewPlaneNormal),
    parallelScale: Number.isFinite(camera?.parallelScale) ? Number(camera.parallelScale) : undefined,
    flipHorizontal: Boolean(camera?.flipHorizontal),
    flipVertical: Boolean(camera?.flipVertical),
  };
}

export function getSharedMprView(): SharedMprView | null {
  const engine = currentRenderingEngine;
  if (!engine) return null;
  const cameras: SharedMprView["cameras"] = {};
  for (const pane of Object.keys(CINE_VIEWPORT_BY_PANE) as CinePane[]) {
    try {
      cameras[pane] = cameraForShare(engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]).getCamera());
    } catch {
      /* viewport not ready */
    }
  }
  return { cameras, crosshair: getCrosshairMm() };
}

export function applySharedMprView(shared: SharedMprView): void {
  const engine = currentRenderingEngine;
  if (!engine) return;
  for (const pane of Object.keys(shared.cameras) as CinePane[]) {
    const camera = shared.cameras[pane];
    if (!camera) continue;
    try {
      engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]).setCamera(camera as never);
    } catch {
      /* viewport may have been replaced during reconnect */
    }
  }
  if (shared.crosshair) moveCornerstoneCrosshairToMm(shared.crosshair);
  engine.render();
}

export function subscribeToMprViewChanges(cb: (view: SharedMprView) => void): () => void {
  const engine = currentRenderingEngine;
  if (!engine) return () => undefined;
  const cleanups: Array<() => void> = [];
  for (const viewportId of Object.values(CINE_VIEWPORT_BY_PANE)) {
    try {
      const viewport = engine.getViewport(viewportId);
      const handler = () => {
        const view = getSharedMprView();
        if (view) cb(view);
      };
      viewport.element.addEventListener(Enums.Events.CAMERA_MODIFIED, handler);
      cleanups.push(() => viewport.element.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler));
    } catch {
      /* viewport not ready */
    }
  }
  return () => cleanups.forEach((cleanup) => cleanup());
}

// ---------------------------------------------------------------------------
// Viewport screenshots — used by the reading session (auto key images) and the
// toolbar snapshot button. Annotations/reference lines live on an SVG overlay,
// not the WebGL-backed canvas, so each shot composites canvas + rasterized SVG.
// ---------------------------------------------------------------------------

export type ViewportImage = { name: string; dataUrl: string };

export async function captureViewportImages(): Promise<ViewportImage[]> {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return [];
  const names: Record<string, string> = {
    [viewportId1]: "axial",
    [viewportId2]: "sagittal",
    [viewportId3]: "coronal",
  };
  const out: ViewportImage[] = [];
  for (const viewportId of [viewportId1, viewportId2, viewportId3]) {
    try {
      const viewport = engine.getViewport(viewportId) as any;
      const canvas: HTMLCanvasElement | undefined = viewport?.canvas;
      const element: HTMLElement | undefined = viewport?.element;
      // offsetParent is null for display:none panes (single-view modes) — skip them.
      if (!canvas || !canvas.width || !element || element.offsetParent === null) continue;
      const composite = document.createElement("canvas");
      composite.width = canvas.width;
      composite.height = canvas.height;
      const ctx = composite.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, composite.width, composite.height);
      ctx.drawImage(canvas, 0, 0);
      const svg = element.querySelector("svg");
      if (svg) {
        const clone = svg.cloneNode(true) as SVGElement;
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        // The overlay is sized in CSS pixels; give the clone explicit dimensions so
        // the rasterizer knows them, then scale to the canvas's device pixels.
        clone.setAttribute("width", String(canvas.clientWidth || canvas.width));
        clone.setAttribute("height", String(canvas.clientHeight || canvas.height));
        const img = new Image();
        await new Promise<void>((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve(); // shot is still useful without the overlay
          img.src =
            "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(new XMLSerializer().serializeToString(clone));
        });
        if (img.width) ctx.drawImage(img, 0, 0, composite.width, composite.height);
      }
      out.push({ name: names[viewportId], dataUrl: composite.toDataURL("image/png") });
    } catch {
      /* viewport not ready — skip this pane */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Progressive resolution upgrade — stream the full-res CT in the background
// and hot-swap it into the MPR viewports without a page reload. Cameras are
// preserved; the labelmap representation must be rebuilt because setVolumes
// replaces every volume actor on the viewport.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- optional cornerstone APIs probed at runtime */
async function _rebuildSegmentationRepresentations() {
  if (!_lastColorLUT || !cache.getVolume(segmentationId) || !currentRenderingEngine) return;
  for (const viewportId of MPR_VIEWPORT_IDS) {
    try {
      // Drop the (now actor-less) representation entry first so re-adding isn't a no-op.
      (segmentation as any).removeSegmentationRepresentations?.(viewportId, {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      });
    } catch {
      /* nothing to remove */
    }
    await addVolumeLabelmap(currentRenderingEngine, viewportId, segmentationId, _lastColorLUT);
    segmentation.activeSegmentation.setActiveSegmentation(viewportId, segmentationId);
  }
}

/**
 * Load the given full-res CT and swap it into every viewport in place.
 * Returns the new volumeId, or null on failure (caller keeps the current
 * volume — nothing is torn down until the new one is fully loaded).
 */
export async function upgradeCtVolume(fullResCtUrl: string): Promise<string | null> {
  const engine = currentRenderingEngine;
  const context = _activeViewerContext;
  if (!engine || !context || context.disposed) return null;
  const previousVolumeId = _currentCtVolumeId;
  const imageIds: string[] = [];
  let newVolumeId: string | null = null;
  let swappedToNewVolume = false;
  try {
    imageIds.push(...await createNiftiImageIdsAndCacheMetadata({ url: fullResCtUrl }));
    newVolumeId = `bodymaps-ct-${context.key}-g${context.generation}-hd`;
    context.volumeIds.add(newVolumeId);
    _claimVolumeImages(context, newVolumeId, imageIds);
    _throwIfViewerLoadStale(context);
    const volume = await volumeLoader.createAndCacheVolume(newVolumeId, { imageIds });
    _throwIfViewerLoadStale(context);
    await volume.load();
    _throwIfViewerLoadStale(context);

    // Preserve each pane's camera so the swap is visually seamless.
    const cameras = new Map<string, unknown>();
    for (const viewportId of MPR_VIEWPORT_IDS) {
      try {
        cameras.set(viewportId, engine.getViewport(viewportId).getCamera());
      } catch {
        /* viewport gone — skip */
      }
    }
    await setVolumesForViewports(engine, [{ volumeId: newVolumeId }], MPR_VIEWPORT_IDS);
    swappedToNewVolume = true;
    _throwIfViewerLoadStale(context);
    for (const viewportId of MPR_VIEWPORT_IDS) {
      const camera = cameras.get(viewportId);
      if (!camera) continue;
      try {
        engine.getViewport(viewportId).setCamera(camera as never);
      } catch {
        /* keep the reset camera */
      }
    }
    await _rebuildSegmentationRepresentations();
    _throwIfViewerLoadStale(context);

    // The shaded 3D volume view renders its own private copy of the CT (never the
    // shared volume — see _volume3DCopyId), so there is nothing to re-target here.
    // If it's open it keeps its current copy; the next open copies the new volume.

    engine.renderViewports([...MPR_VIEWPORT_IDS]);
    _currentCtVolumeId = newVolumeId;
    if (previousVolumeId && previousVolumeId !== newVolumeId) {
      _releaseContextVolume(context, previousVolumeId);
    }
    return newVolumeId;
  } catch (e) {
    if (newVolumeId) {
      const rolledBack = await rollbackVolumeUpgrade({
        swappedToNewVolume,
        previousVolumeId,
        restorePreviousVolume: async (volumeId) => {
          await setVolumesForViewports(engine, [{ volumeId }], MPR_VIEWPORT_IDS);
          engine.renderViewports([...MPR_VIEWPORT_IDS]);
        },
        releaseNewVolume: () => _releaseContextVolume(context, newVolumeId!),
      });
      if (!rolledBack) {
        console.warn("Full-res upgrade rollback failed; retaining the HD volume cache.");
      }
    }
    if (e instanceof DOMException && e.name === "AbortError") return null;
    console.warn("Full-res upgrade failed; keeping the current volume.", e);
    return null;
  }
}

/**
 * Rebuild the segmentation (labelmap) volume against a full-res mask, so its
 * voxel grid actually matches the full-res CT after upgradeCtVolume() swaps
 * that in. Without this, the labelmap keeps the low-res grid it was created
 * with at initial load — a brush click computed against the now-full-res
 * viewport gets worldToIndex'd onto the *old* low-res slice spacing, which
 * lands one slice off (sometimes the slice before, sometimes after,
 * depending on where the two grids' boundaries happen to fall). Call this
 * right after upgradeCtVolume() succeeds, before re-enabling annotation.
 *
 * This replaces the labelmap outright with the server's full-res mask — it
 * does not attempt to carry over voxels painted before the HD swap. (An
 * earlier version tried a world-position carry-over; it isn't reliable
 * across differently-shaped vtkImageData volumes and was removed rather than
 * risk a broken partial state. If preserving pre-HD edits turns out to
 * matter in practice, that needs its own careful pass, not a quick patch
 * here.)
 *
 * Returns true on success; false leaves the existing (low-res) labelmap in
 * place — caller should keep annotation disabled in that case.
 */
export async function upgradeSegmentationVolume(fullResSegUrl: string): Promise<boolean> {
  if (!cache.getVolume(segmentationId)) return false;
  try {
    const segmentationImageIds = await createNiftiImageIdsAndCacheMetadata({ url: fullResSegUrl });
    if (!segmentationImageIds.length) return false;

    cache.removeVolumeLoadObject(segmentationId);
    const newVolume = await volumeLoader.createAndCacheVolume(segmentationId, {
      imageIds: segmentationImageIds,
    });
    await newVolume.load();

    await _rebuildSegmentationRepresentations();
    return true;
  } catch (e) {
    console.warn("Full-res segmentation upgrade failed; keeping the low-res labelmap.", e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Click-to-segment / box-to-segment (interactive prompt tools)
//
// Backend contract (flask-server/api/api_blueprint.py: POST
// /api/interactive-segment/<case_id>): body { point_lps, box_lps?, tolerance?,
// res: "low"|"full" }, response is a gzip'd .nii.gz mask IN THE SAME VOXEL
// GRID as whichever `res` was requested. Because of that grid match, once
// decompressed we can copy proposal voxels into the live segmentation volume
// by flat index directly — no worldToIndex/geometry reconciliation needed,
// unlike the HD-upgrade carry-over that broke earlier. The one hard
// requirement is that `res` here must match whatever grid the *current*
// segmentationId volume is actually on right now (i.e. gate this tool the
// same way Annotate is gated — behind hdReady — so "low" vs "full" can't
// drift out of sync mid-session).
//
// NOT YET TESTED end-to-end — this is new scaffolding. Test on a real case
// before trusting it: submit a point prompt, confirm the proposal lands in
// the right place on the right slice, and confirm undo/segment-switching
// still behave normally afterward.
export interface InteractivePrompt {
  pointLps: Point3;
  boxLps?: [Point3, Point3];
  tolerance?: number;
}

async function _decompressGzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  // Prefer the native DecompressionStream (Chrome/Edge/Safari 16.4+); if it's
  // unavailable, this throws and the caller should show "unsupported browser"
  // rather than silently failing — there's no bundled gzip fallback here.
  const ds = new (window as any).DecompressionStream("gzip");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

/**
 * Send a point/box prompt to the backend's interactive-segment endpoint and
 * merge the returned proposal into the live segmentation volume as
 * `activeSegmentIndex`, restricted to voxels the proposal actually covers
 * (existing voxels elsewhere in the labelmap are untouched).
 *
 * `res` MUST match the grid the current segmentation volume is on (see the
 * module comment above) — pass `isHd ? "full" : "low"` from the caller's own
 * hdReady state, not a guess.
 *
 * Returns the number of voxels changed (0 if the proposal was empty), or
 * throws with a message safe to show the user (the backend already returns
 * plain-English error strings for the common cases — empty grow, no CT, etc).
 */
export async function submitInteractiveSegmentPrompt(
  apiBase: string,
  caseId: string | number,
  activeSegmentIndex: number,
  prompt: InteractivePrompt,
  res: "low" | "full",
): Promise<{ changed: number; engine: string; blocked?: string }> {
  const segVolume = cache.getVolume(segmentationId);
  if (!segVolume) throw new Error("No segmentation loaded for this case.");

  const body: Record<string, unknown> = {
    point_lps: [prompt.pointLps[0], prompt.pointLps[1], prompt.pointLps[2]],
    res,
  };
  if (prompt.boxLps) {
    body.box_lps = [
      [prompt.boxLps[0][0], prompt.boxLps[0][1], prompt.boxLps[0][2]],
      [prompt.boxLps[1][0], prompt.boxLps[1][1], prompt.boxLps[1][2]],
    ];
  }
  if (prompt.tolerance != null) body.tolerance = prompt.tolerance;

  const httpRes = await fetch(`${apiBase}/api/interactive-segment/${caseId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!httpRes.ok) {
    // The backend always returns {"error": "...", "reason": "<code>"} for failures.
    // Map each reason code to a clear, actionable message for the user.
    let reason = "";
    let serverMsg = "";
    try {
      const j = await httpRes.json();
      reason = j?.reason ?? "";
      serverMsg = j?.error ?? "";
    } catch { /* non-JSON body — fall through to status-based message */ }

    const REASON_MESSAGES: Record<string, string> = {
      server_unreachable: "Cannot reach the AI server. Check that the Colab server and tunnel are running.",
      auth_failed:        "The AI server rejected the API key. Update the key in flask-server/.env and restart Flask.",
      session_expired:    "The AI session expired. Please click again.",
      empty_mask:         "AI found nothing at that point. Try clicking closer to the center of the organ.",
      resolution_mismatch:"Result size does not match the viewer. Reload the page and try again.",
    };
    const msg = REASON_MESSAGES[reason] ?? serverMsg ?? `Interactive segmentation failed (${httpRes.status}).`;
    throw new Error(msg);
  }

  // Read the engine header before consuming the body (headers are available
  // immediately; body is a stream that we drain below).
  const engine = httpRes.headers.get("X-Engine-Used") ?? "unknown";

  const gz = await httpRes.arrayBuffer();
  const niiBytes = await _decompressGzip(gz);

  // Parse the proposal mask's voxel data directly from the raw NIfTI bytes,
  // instead of routing it through Cornerstone's volume loader. An earlier
  // version created a throwaway Cornerstone volume for this — but Cornerstone
  // prioritizes/cancels image loads based on which viewports are actively
  // requesting them, and a volume attached to no viewport gets its loads
  // cancelled outright ("volume load cancelled" for every slice). Reading
  // the header ourselves avoids that whole pathway.
  //
  // The backend always writes this via nibabel with
  // `out.header.set_data_dtype('uint8')` (see interactive_segment in
  // api_blueprint.py) — a single-file .nii, uint8, standard 352-byte data
  // offset, no extensions. If that ever changes server-side, this parser
  // needs to change with it.
  const proposal = _parseNiftiUint8Mask(niiBytes);

  const segScalars = (segVolume as any)?.voxelManager?.getCompleteScalarDataArray?.()
    ?? (segVolume as any)?.scalarData;
  const segDims = segVolume.imageData.getDimensions() as [number, number, number];

  if (!segScalars) throw new Error("Could not access voxel data to apply the proposal.");
  if (segDims[0] !== proposal.dims[0] || segDims[1] !== proposal.dims[1] || segDims[2] !== proposal.dims[2]) {
    // Grid mismatch — almost certainly `res` didn't match the segmentation
    // volume's current resolution. Refuse rather than silently misapply.
    throw new Error("Result size does not match the viewer. Reload the page and try again.");
  }

  // FIX A — block region_grow results entirely: nnInteractive unavailable means
  // the fallback would flood all connected soft tissue into the active class,
  // overwriting neighbouring organs. Refuse without touching the labelmap.
  // "nninteractive_empty" never reaches here (backend returns 422 before sending
  // a body), so this guard only fires for region_grow / unknown fallbacks.
  // With Part 8's SegmentError changes, region_grow is no longer returned by
  // the route — but keep this as a safety net for unknown engine values.
  if (engine !== "nninteractive") {
    return {
      changed: 0,
      engine,
      blocked: "Cannot reach the AI server. Check that the Colab server and tunnel are running." as string | undefined,
    };
  }

  // FIX B — size sanity guard: a proposal that would change more than
  // INTERACTIVE_MASK_MAX_FRACTION of the total volume is almost certainly a
  // flood (e.g. region_grow on soft tissue). Refuse without touching the labelmap.
  const totalVoxels = proposal.data.length;
  const proposedSet = proposal.data.reduce((n, v) => n + (v ? 1 : 0), 0);
  if (proposedSet / totalVoxels > INTERACTIVE_MASK_MAX_FRACTION) {
    return {
      changed: 0,
      engine,
      blocked: `Result looks too large (${Math.round((proposedSet / totalVoxels) * 100)}% of volume) — no change was applied.` as string | undefined,
    };
  }

  let changed = 0;
  // Sparse before/after capture for undo — only voxels this proposal
  // actually touches AND actually changes (skips a no-op write where the
  // voxel already held activeSegmentIndex), so undo/redo stay cheap even
  // though `proposal.data` spans the whole volume.
  const touchedIdx: number[] = [];
  const priorValues: number[] = [];
  for (let idx = 0; idx < proposal.data.length; idx++) {
    if (proposal.data[idx]) {
      if (segScalars[idx] !== activeSegmentIndex) {
        touchedIdx.push(idx);
        priorValues.push(segScalars[idx]);
      }
      segScalars[idx] = activeSegmentIndex;
      changed++;
    }
  }
  if (changed > 0) {
    (segVolume as any)?.voxelManager?.setCompleteScalarDataArray?.(segScalars);
    // NOT _rebuildSegmentationRepresentations() — this only mutated voxels
    // in the SAME already-cached segVolume object, it never swapped which
    // volume is loaded (unlike upgradeSegmentationVolume, which genuinely
    // does need the full remove+re-add). A full rebuild tears down and
    // re-adds every segment's representation on every viewport, which is
    // both the visible "every class mask flashes/reloads" symptom and
    // real, avoidable cost on every single click/box prompt. This is the
    // same lightweight refresh the brush/smart-fill/etc. direct-write paths
    // already use — it doesn't touch representations or actors, so it also
    // doesn't disturb camera position/zoom the way rebuilding did.
    _notifySegmentationChanged();

    // Own undo/redo entry, same shared stack as smart fill / scissors /
    // lasso (pushEditHistory below) — a SEPARATE stack from brush strokes
    // (Cornerstone's own HistoryMemo), so undoing a point/box segment never
    // also reverts (or gets shadowed by) an unrelated brush stroke; see
    // undoMaskEdit's recency check for how the two stacks interleave.
    if (touchedIdx.length > 0) {
      const applyAndRefresh = (values: number[]) => {
        touchedIdx.forEach((idx, i) => { segScalars[idx] = values[i]; });
        (segVolume as any)?.voxelManager?.setCompleteScalarDataArray?.(segScalars);
        _notifySegmentationChanged();
      };
      const redoValues = touchedIdx.map(() => activeSegmentIndex);
      pushEditHistory({
        undo: () => applyAndRefresh(priorValues),
        redo: () => applyAndRefresh(redoValues),
      });
    }
  }

  return { changed, engine, blocked: undefined };
}

/**
 * Minimal NIfTI-1 reader for exactly the shape the interactive-segment
 * endpoint returns: single-file .nii, uint8 data, standard header, no
 * extensions. Not a general-purpose NIfTI parser — reads only what's needed
 * (dims + the voxel array) and assumes little-endian, matching nibabel's
 * default write format.
 */
function _parseNiftiUint8Mask(buf: ArrayBuffer): { dims: [number, number, number]; data: Uint8Array } {
  const view = new DataView(buf);
  // NIfTI-1 header: dim[8] (int16 x8) starts at byte 40; dim[0]=ndims,
  // dim[1..3]=nx,ny,nz. vox_offset (float32) is at byte 108 — where the
  // voxel data actually begins (352 for a standard header with no
  // extensions, but read it rather than assume, in case that ever changes).
  const nx = view.getInt16(42, true);
  const ny = view.getInt16(44, true);
  const nz = view.getInt16(46, true);
  const voxOffset = view.getFloat32(108, true);
  const count = nx * ny * nz;
  const data = new Uint8Array(buf, voxOffset, count);
  return { dims: [nx, ny, nz], data };
}

// ---------------------------------------------------------------------------
// Shaded GPU volume rendering ("Volume" mode in the 3D pane): ray-cast VTK.js
// rendering of the CT itself with clinical transfer-function presets, driven
// by a trackball camera. Works with or without a segmentation (local DICOM).
// ---------------------------------------------------------------------------

// Curated subset of Cornerstone's VTK presets that read well on CT.
export const VOLUME_3D_PRESETS = [
  { name: "CT-Bone", label: "Bone" },
  { name: "CT-AAA", label: "Angio" },
  { name: "CT-Chest-Contrast-Enhanced", label: "Chest" },
  { name: "CT-Lung", label: "Lung" },
  { name: "CT-Soft-Tissue", label: "Soft tissue" },
  { name: "CT-MIP", label: "MIP" },
] as const;

// MR intensities aren't Hounsfield units, so the CT transfer functions above
// render MR as an opaque slab. Cornerstone ships MR presets — the viewer offers
// these instead when the loaded volume is MR (local DICOM can be any modality).
export const VOLUME_3D_PRESETS_MR = [
  { name: "MR-Default", label: "Default" },
  { name: "MR-Angio", label: "Angio" },
  { name: "MR-MIP", label: "MIP" },
  { name: "MR-T2-Brain", label: "T2 Brain" },
] as const;

// Modality of the volume the viewer is showing (DICOM metadata; NIfTI dataset
// cases have no Modality and return undefined — they're CT by construction).
export function getCurrentVolumeModality(): string | undefined {
  if (!_currentCtVolumeId) return undefined;
  return (cache.getVolume(_currentCtVolumeId) as any)?.metadata?.Modality;
}

let _lastVolume3DPreset: string = VOLUME_3D_PRESETS[0].name;

// The 3D pane's private copy of the CT volume. A cached volume owns exactly ONE
// vtkStreamingOpenGLTexture, which stores a single GL context + texture handle —
// so a volume can only ever be rendered by ONE engine. Sharing the MPR volumeId
// with the 3D engine makes the two contexts fight over that texture: the 3D pane
// stays black (its frames were "already uploaded" — into the MPR context) and the
// next MPR render draws the CT through a foreign handle (black CT, labelmap only).
let _volume3DCopyId: string | null = null;
const _volume3DOperations = createOperationGeneration("Volume rendering was disabled");
let _volume3DEngineOwnerGeneration: number | null = null;
let _volume3DCopyOwnerGeneration: number | null = null;

function _removeVolumeAndImages(volumeIdToRemove: string) {
  try {
    const volume = cache.getVolume(volumeIdToRemove);
    const imageIds: string[] = volume?.imageIds ?? [];
    _removeCachedVolume(volumeIdToRemove);
    for (const imageId of imageIds) {
      try {
        cache.removeImageLoadObject(imageId, { force: true });
      } catch {
        /* image already evicted */
      }
    }
  } catch {
    /* volume already evicted */
  }
}

async function _getOrCreateVolume3DCopy(
  sourceVolumeId: string,
  assertCurrent: () => void
): Promise<string | null> {
  const copyId = `${sourceVolumeId}-vr3d`;
  if (cache.getVolume(copyId)) return copyId;
  try {
    const source = cache.getVolume(sourceVolumeId) as any;
    let scalarData = source?.voxelManager?.getCompleteScalarDataArray?.();
    if (!scalarData?.length && Array.isArray(source?.imageIds) && source.imageIds.length) {
      // DICOM (wadouri) volumes stream frames straight onto the GPU texture and can
      // drop their per-slice images from the IMAGE cache — getCompleteScalarDataArray
      // then finds no images and silently returns an EMPTY array ("Number of
      // components 0 must be 1, 3 or 4" downstream). Re-decode the slices through the
      // image loader (the parsed datasets are still cached) and assemble the buffer.
      // Sequential on purpose: don't flood the decode workers on big series.
      const [w, h] = source.dimensions;
      const sliceLen = w * h;
      const slices: any[] = [];
      for (const imageId of source.imageIds) {
        slices.push(await imageLoader.loadAndCacheImage(imageId));
        assertCurrent();
      }
      const pixelsOf = (img: any) =>
        img?.voxelManager?.getScalarData?.() ?? img?.getPixelData?.();
      const first = pixelsOf(slices[0]);
      if (first?.length) {
        const Ctor = first.constructor as new (n: number) => typeof first;
        scalarData = new Ctor(sliceLen * source.dimensions[2]);
        slices.forEach((img, i) => {
          const px = pixelsOf(img);
          if (px?.length) scalarData.set(px.subarray(0, sliceLen), i * sliceLen);
        });
      }
    }
    if (!scalarData?.length) return null;
    (volumeLoader.createLocalVolume as any)(copyId, {
      metadata: source.metadata,
      dimensions: source.dimensions,
      spacing: source.spacing,
      origin: source.origin,
      direction: source.direction,
      scalarData,
    });
    return copyId;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    console.warn("Volume rendering: could not create the 3D volume copy.", e);
    return null;
  }
}

function _throwIfVolume3DOperationStale(
  context: ViewerResourceContext,
  operationGeneration: number
) {
  _throwIfViewerLoadStale(context);
  _volume3DOperations.throwIfStale(operationGeneration);
}

function _cleanupVolume3DOperation(operationGeneration: number, copyId: string | null) {
  if (_volume3DEngineOwnerGeneration === operationGeneration) {
    try {
      ToolGroupManager.destroyToolGroup(volume3DToolGroupId);
    } catch {
      /* tool group already gone */
    }
    try {
      (getRenderingEngine(volume3DEngineId) as RenderingEngine | undefined)?.destroy();
    } catch {
      /* engine already gone */
    }
    _volume3DEngineOwnerGeneration = null;
  }

  if (!copyId) return;
  if (_volume3DCopyId === copyId && _volume3DCopyOwnerGeneration !== operationGeneration) return;
  if (_volume3DCopyOwnerGeneration === operationGeneration) {
    _volume3DCopyId = null;
    _volume3DCopyOwnerGeneration = null;
  }
  _removeVolumeAndImages(copyId);
}

export function applyVolume3DPreset(presetName: string) {
  _lastVolume3DPreset = presetName;
  const engine = getRenderingEngine(volume3DEngineId) as RenderingEngine | undefined;
  if (!engine) return;
  try {
    const viewport = engine.getViewport(volume3DViewportId) as any;
    viewport?.setProperties?.({ preset: presetName });
    viewport?.render?.();
  } catch {
    /* 3D view not enabled */
  }
}

// Resolve once the element has a non-zero layout size (up to ~500ms), so the
// on-screen canvas Cornerstone allocates isn't 0×0 (a classic "black 3D pane").
function _waitForLayout(element: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    let tries = 0;
    const check = () => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0) return resolve(true);
      if (tries++ > 30) return resolve(element.offsetWidth > 0);
      requestAnimationFrame(check);
    };
    check();
  });
}

export async function enableVolume3D(
  element: HTMLDivElement,
  presetName: string = _lastVolume3DPreset
): Promise<boolean> {
  const context = _activeViewerContext;
  const sourceVolumeId = _currentCtVolumeId;
  if (!context || !sourceVolumeId || !cache.getVolume(sourceVolumeId)) return false;
  const operationGeneration = _volume3DOperations.begin();
  let copyId: string | null = null;
  let completed = false;
  const assertCurrent = () => _throwIfVolume3DOperationStale(context, operationGeneration);
  try {
    try {
      cornerstoneTools.addTool(TrackballRotateTool);
    } catch {
      /* already registered */
    }
    await _waitForLayout(element);
    assertCurrent();

    // Never hand the MPR volume to this engine — render a private copy with its
    // own GL texture (see the note by _volume3DCopyId).
    copyId = await _getOrCreateVolume3DCopy(sourceVolumeId, assertCurrent);
    assertCurrent();
    if (!copyId) return false;
    _volume3DCopyId = copyId;
    _volume3DCopyOwnerGeneration = operationGeneration;

    // Dedicated engine — never share the MPR engine (see the note by its id).
    const engine = _getVolume3DEngine();
    _volume3DEngineOwnerGeneration = operationGeneration;
    engine.enableElement({
      viewportId: volume3DViewportId,
      type: Enums.ViewportType.VOLUME_3D,
      element,
      defaultOptions: {
        orientation: Enums.OrientationAxis.CORONAL,
        background: [0.03, 0.035, 0.043],
      },
    });
    const viewport = engine.getViewport(volume3DViewportId) as any;
    // Canonical VOLUME_3D recipe: attach the volume, THEN the preset (setPreset
    // no-ops if the volume actor isn't present yet), then frame + render.
    await viewport.setVolumes([{ volumeId: copyId }]);
    assertCurrent();
    viewport.setProperties({ preset: presetName });
    _lastVolume3DPreset = presetName;
    // Match the on-screen canvas to the (now laid-out) element before framing.
    engine.resize(true, false);
    viewport.resetCamera();
    viewport.render();

    // If no volume actor attached, ray casting will just show black — report
    // failure so the UI can fall back to a message instead of a blank pane.
    const actorCount = viewport.getActors?.().length ?? 0;
    if (actorCount === 0) {
      console.warn("Volume rendering: no volume actor attached.");
      return false;
    }

    ToolGroupManager.destroyToolGroup(volume3DToolGroupId); // stale viewport ref from a prior open
    const toolGroup = ToolGroupManager.createToolGroup(volume3DToolGroupId);
    if (!toolGroup) return false;
    toolGroup.addTool(TrackballRotateTool.toolName);
    toolGroup.addTool(ZoomTool.toolName);
    toolGroup.addTool(PanTool.toolName);
    toolGroup.setToolActive(TrackballRotateTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
    });
    toolGroup.setToolActive(ZoomTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }],
    });
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Auxiliary }],
    });
    toolGroup.addViewport(volume3DViewportId, volume3DEngineId);
    viewport.render();
    completed = true;
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return false;
    console.warn("Volume rendering unavailable:", e);
    return false;
  } finally {
    if (!completed) _cleanupVolume3DOperation(operationGeneration, copyId);
  }
}

export function disableVolume3D() {
  _volume3DOperations.invalidate();
  try {
    ToolGroupManager.destroyToolGroup(volume3DToolGroupId);
  } catch {
    /* tool group already gone */
  }
  // Destroy the whole dedicated engine so its canvas/GL context is released and
  // the next open starts clean. This can't touch the MPR engine.
  try {
    (getRenderingEngine(volume3DEngineId) as RenderingEngine | undefined)?.destroy();
  } catch {
    /* engine already gone */
  }
  // Free the private CT copy (CPU + GPU); reopening the pane rebuilds it.
  // createLocalVolume backs the copy with PER-SLICE images in the IMAGE cache
  // (`<copyId>_slice_<i>`), and removeVolumeLoadObject only deletes the volume
  // entry — it leaves those slice images allocated. Without freeing them too,
  // every Meshes→Volume round trip leaks a full CT copy until the next
  // createLocalVolume fails its cache-size check and the pane reports "volume
  // rendering isn't available" even though the GPU is fine.
  try {
    if (_volume3DCopyId) {
      _removeVolumeAndImages(_volume3DCopyId);
    }
  } catch {
    /* already evicted */
  }
  _volume3DCopyId = null;
  _volume3DCopyOwnerGeneration = null;
  _volume3DEngineOwnerGeneration = null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function setZoom(zoomValue: number){
  const engine = getRenderingEngine(renderingEngineId);
  [viewportId1, viewportId2, viewportId3].forEach((viewportId) => {
      if (engine){
        const viewport = engine.getViewport(viewportId);
        viewport.setZoom(zoomValue);
        viewport.render();
      }
    })
}
export function zoomToCursor(
  viewportId: string,
  canvasPos: [number, number],
  zoomFactor: number
) {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return;
  const viewport = engine.getViewport(viewportId) as any;
  if (!viewport) return;

  const worldPosBefore = viewport.canvasToWorld(canvasPos);

  const currentZoom = viewport.getZoom();
  viewport.setZoom(currentZoom * zoomFactor);

  const worldPosAfter = viewport.canvasToWorld(canvasPos);

  const delta = [
    worldPosBefore[0] - worldPosAfter[0],
    worldPosBefore[1] - worldPosAfter[1],
    worldPosBefore[2] - worldPosAfter[2],
  ];

  const camera = viewport.getCamera();
  viewport.setCamera({
    ...camera,
    focalPoint: [
      camera.focalPoint[0] + delta[0],
      camera.focalPoint[1] + delta[1],
      camera.focalPoint[2] + delta[2],
    ],
    position: [
      camera.position[0] + delta[0],
      camera.position[1] + delta[1],
      camera.position[2] + delta[2],
    ],
  });

  viewport.render();
}
export function zoomToFit() {
  const engine = getRenderingEngine(renderingEngineId);
  [viewportId1, viewportId2, viewportId3].forEach((viewportId) => {
      if (engine){
        const viewport = engine.getViewport(viewportId);
        viewport.resetCamera({
            resetPan: true,
            resetZoom: true
        });
        viewport.render();
      }
    })
}

export function centerOnCursor(){
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return;
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;
  const toolCenter = toolGroup.getToolInstance(CrosshairsTool.toolName).toolCenter;
  [viewportId1, viewportId2, viewportId3].forEach((viewportId) => {
    const viewport = engine.getViewport(viewportId);
    viewport.setViewReference({
    FrameOfReferenceUID: "1.2.840.10008.1.4",
    cameraFocalPoint: toolCenter
    })
    // if (viewportId == "CT_NIFTI_CORONAL"){
    //   viewport.setPan([-toolCenter[1], toolCenter[2]]);
    // }
    // if (viewportId == "CT_NIFTI_SAGITTAL"){
    //   viewport.setPan([toolCenter[2], toolCenter[0]]);
    // }
    viewport.render();
    })
}

export function getOrganLabelOnClick() {
    const engine = getRenderingEngine(renderingEngineId);
    if (!engine) return;
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    if (!toolGroup) return;
    const toolActive = toolGroup.getToolInstance(CrosshairsTool.toolName).mode;
    if (toolActive !== csToolsEnums.ToolModes.Active) return;
    const volume = cache.getVolume(segmentationId);
    if (!volume || !volume.voxelManager) return;
    const indices = [viewportId2, viewportId3, viewportId1].map((viewportId) => {
      const viewport = engine.getViewport(viewportId);
      const idx = viewport.getSliceIndex();
    //   if (viewportId === viewportId1) {
    //       return volume.voxelManager.dimensions[2] - idx;
    //   }
      return idx;
    })

    // volume.voxelManager.forEach(({value, index, pointIJK}) => {
    //     if (value === 14) {
    //         console.log(pointIJK);
    //     }
    // })
    const idx = volume.voxelManager.getAtIJK(indices[0], indices[1], indices[2]);
    return idx;
}

// Hover variant of getOrganLabelOnClick: resolves the segment label under an arbitrary
// screen point in one pane, via canvasToWorld → worldToIndex on that pane's own volume
// geometry. Unlike the click path, this never touches the crosshair (no repositioning
// side effect), which is what makes it safe to call on every mousemove for the
// "hover to identify" tool.
export function getOrganLabelAtPoint(pane: CinePane, clientX: number, clientY: number): number | undefined {
    const engine = getRenderingEngine(renderingEngineId);
    if (!engine) return undefined;
    const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as unknown as
        | { getCanvas(): HTMLCanvasElement; canvasToWorld(canvasPos: Point2): Point3 }
        | undefined;
    if (!viewport) return undefined;
    const volume = cache.getVolume(segmentationId);
    if (!volume || !volume.voxelManager || !volume.imageData) return undefined;

    let canvas: HTMLCanvasElement;
    try {
        canvas = viewport.getCanvas();
    } catch {
        return undefined;
    }
    const rect = canvas.getBoundingClientRect();
    const canvasPos: Point2 = [clientX - rect.left, clientY - rect.top];
    if (canvasPos[0] < 0 || canvasPos[1] < 0 || canvasPos[0] > rect.width || canvasPos[1] > rect.height) {
        return undefined;
    }

    let world: Point3;
    try {
        world = viewport.canvasToWorld(canvasPos);
    } catch {
        return undefined;
    }

    const [i, j, k] = volume.imageData.worldToIndex(world).map((v: number) => Math.round(v));
    const [dimX, dimY, dimZ] = volume.voxelManager.dimensions;
    if (i < 0 || j < 0 || k < 0 || i >= dimX || j >= dimY || k >= dimZ) return undefined;
    const res = volume.voxelManager.getAtIJK(i, j, k);
    // make sure res is not RGB
    if (typeof res === "number") return res;
}

// Resolves a raw page click (clientX/clientY) to "which pane, which viewport slice,
// what's under the cursor" — without the caller needing to already know which pane
// was clicked. Tries every MPR pane's canvas in turn (cheap — at most 3 bounding-rect
// checks) and returns the first one whose canvas actually contains the point. Powers
// the guided "click the shape on this slice" pickers (copy/interpolate) so the user
// never has to type a pane name or a slice number themselves.
export function pickSliceAnchorAtClientPoint(
  clientX: number,
  clientY: number
): { pane: CinePane; sliceIndex: number; segmentAtPoint: number | undefined } | null {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return null;
  const volume = cache.getVolume(segmentationId);
  if (!volume?.voxelManager || !volume.imageData) return null;

  const panes = Object.keys(CINE_VIEWPORT_BY_PANE) as CinePane[];

  type PaneViewport = { getCanvas(): HTMLCanvasElement; canvasToWorld(canvasPos: Point2): Point3; getSliceIndex(): number };
  const paneViewports: { pane: CinePane; viewport: PaneViewport; canvas: HTMLCanvasElement }[] = [];
  for (const pane of panes) {
    const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as unknown as PaneViewport | undefined;
    if (!viewport) continue;
    try {
      paneViewports.push({ pane, viewport, canvas: viewport.getCanvas() });
    } catch {
      // canvas not ready for this pane yet
    }
  }

  // Ask the DOM which element is ACTUALLY on top at this screen point,
  // rather than looping over each pane's own getBoundingClientRect() and
  // taking the first one whose (possibly stale, possibly overlapping —
  // e.g. right after a resize or while a pane is mid-transition in/out of
  // a maximized layout) rect happens to contain the click. Bounding-rect
  // order was a fixed iteration order (Object.keys), not screen order, so
  // whichever pane's rect was checked first could "win" a click that
  // visually landed in a different, currently-on-top pane — which is what
  // made the second guided click intermittently resolve to the wrong pane
  // and misreport as "click in the same view" even when it was.
  let hitCanvas: HTMLCanvasElement | undefined;
  if (typeof document !== "undefined" && typeof document.elementFromPoint === "function") {
    const topEl = document.elementFromPoint(clientX, clientY);
    if (topEl) {
      // The canvas itself, or a wrapper directly around it — climb to the
      // nearest <canvas> if the hit landed on an overlay div instead.
      hitCanvas = (topEl.closest("canvas") as HTMLCanvasElement | null)
        ?? (topEl as HTMLElement).querySelector?.("canvas")
        ?? undefined;
    }
  }

  // Prefer the pane whose own canvas is literally the element under the
  // cursor. Fall back to the old rect-containment scan only if that lookup
  // couldn't resolve anything (e.g. elementFromPoint unsupported) — same
  // behavior as before in that fallback case, so nothing regresses.
  const candidates = hitCanvas
    ? paneViewports.filter((p) => p.canvas === hitCanvas)
    : paneViewports.filter((p) => {
        const rect = p.canvas.getBoundingClientRect();
        return !(clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom);
      });

  const match = candidates[0];
  if (!match) return null;

  const { pane, viewport, canvas } = match;
  const rect = canvas.getBoundingClientRect();
  const canvasPos: Point2 = [clientX - rect.left, clientY - rect.top];
  let world: Point3;
  try {
    world = viewport.canvasToWorld(canvasPos);
  } catch {
    return null;
  }
  const [i, j, k] = volume.imageData.worldToIndex(world).map((v: number) => Math.round(v));
  const [dimX, dimY, dimZ] = volume.voxelManager.dimensions;
  const inBounds = i >= 0 && j >= 0 && k >= 0 && i < dimX && j < dimY && k < dimZ;
  const raw = inBounds ? volume.voxelManager.getAtIJK(i, j, k) : undefined;
  return {
    pane,
    sliceIndex: viewport.getSliceIndex(),
    segmentAtPoint: typeof raw === "number" ? raw : undefined,
  };
}

// Centroid (world mm) of every segment label, from one pass over the labelmap. Cached for
// the loaded case (reset in renderVisualization). Lets the UI jump the crosshair to an
// organ. Returns null until the segmentation volume is available.
let _organCentroids: Record<number, [number, number, number]> | null = null;

export function getOrganCentroids(): Record<number, [number, number, number]> | null {
    if (_organCentroids) return _organCentroids;
    const volume = cache.getVolume(segmentationId);
    const vm = volume?.voxelManager;
    if (!volume || !vm) return null;

    const [dimX, dimY] = vm.dimensions;
    const sliceSize = dimX * dimY;
    // Sum voxel indices (and count) per label, so we can take the mean = centroid.
    const sums = new Map<number, { x: number; y: number; z: number; n: number }>();
    const add = (label: number, i: number, j: number, k: number) => {
        if (!label) return; // skip background (0)
        let s = sums.get(label);
        if (!s) { s = { x: 0, y: 0, z: 0, n: 0 }; sums.set(label, s); }
        s.x += i; s.y += j; s.z += k; s.n++;
    };

    // The segmentation is image-backed, so getScalarData() may not hold one contiguous
    // array. Prefer getCompleteScalarDataArray() (assembles the full volume), and fall back
    // to forEach (which hands us IJK per voxel) if it isn't available.
    let data: ArrayLike<number> | undefined;
    try { data = vm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
    if (data && data.length) {
        for (let idx = 0; idx < data.length; idx++) {
            const label = data[idx];
            if (!label) continue;
            const k = (idx / sliceSize) | 0;
            const rem = idx - k * sliceSize;
            const j = (rem / dimX) | 0;
            add(label, rem - j * dimX, j, k);
        }
    } else {
        vm.forEach((voxel) =>
            add(Number(voxel.value), voxel.pointIJK[0], voxel.pointIJK[1], voxel.pointIJK[2])
        );
    }

    const out: Record<number, [number, number, number]> = {};
    for (const [label, s] of sums) {
        // Mean voxel index → world mm via the volume's geometry (handles spacing/affine).
        // indexToWorld returns the point (it doesn't reliably fill an out-param).
        const w = volume.imageData?.indexToWorld([s.x / s.n, s.y / s.n, s.z / s.n]);
        if (w) out[label] = [w[0], w[1], w[2]];
    }
    _organCentroids = out;
    return out;
}



// Live client side mesh extraction for custom classes created during annotation
// Marching cube runs directly on the in-memory label map (no server involvement)

export type LiveMeshResult = {
  positions: Float32Array;
  indices: Uint32Array;
};

function _buildBinaryMask(segmentIndex: number): { mask: Uint8Array; dims: [number, number, number] } | null {
  const volume = cache.getVolume(segmentationId);
  const vm = volume?.voxelManager;
  if (!volume || !vm) return null;
  let data: ArrayLike<number> | undefined;
  try {
    data = vm.getCompleteScalarDataArray?.();
  } catch {
    return null;
  }
  if (!data || !data.length) return null;
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) mask[i] = data[i] === segmentIndex ? 1 : 0;
  return { mask, dims: vm.dimensions as [number, number, number] };
}

// ---------------------------------------------------------------------------
// Pre-edit snapshots: a segment's labelmap state captured the moment it
// becomes the active edit target, BEFORE any stroke has touched it. Without
// this, the 3D pane's switch from the baked GLB to the live marching-cubes
// mesh (which only happens once `markSegmentEdited` fires, i.e. AFTER the
// first stroke has already mutated the in-memory labelmap — Cornerstone's
// SEGMENTATION_DATA_MODIFIED event is post-mutation) would bake that first
// stroke into the "original" mesh. Capturing here, at activation time
// instead of at first-edit time, gives LiveSegmentMesh a true pre-annotation
// baseline to build from.
// ---------------------------------------------------------------------------
const _preEditMaskSnapshots = new Map<number, { mask: Uint8Array; dims: [number, number, number] }>();

/** Record a segment's current (unedited-so-far) mask, if it hasn't been recorded yet. */
function _capturePreEditSnapshotIfAbsent(segmentIndex: number) {
  if (_preEditMaskSnapshots.has(segmentIndex)) return;
  if (_editedSegmentIndices.has(segmentIndex)) return; // already edited — too late for a "pre-edit" snapshot
  const built = _buildBinaryMask(segmentIndex);
  if (built) _preEditMaskSnapshots.set(segmentIndex, built);
}

/** One-shot read: returns and clears the pre-edit snapshot for a segment, if any. */
export function consumePreEditSegmentSnapshot(
  segmentIndex: number
): { mask: Uint8Array; dims: [number, number, number] } | null {
  const snapshot = _preEditMaskSnapshots.get(segmentIndex) ?? null;
  _preEditMaskSnapshots.delete(segmentIndex);
  return snapshot;
}

export function clearPreEditSegmentSnapshot(segmentIndex: number) {
  _preEditMaskSnapshots.delete(segmentIndex);
}

function _padVolume(mask: Uint8Array, dims: [number, number, number]) {
  const [nx, ny, nz] = dims;
  const pnx = nx + 2, pny = ny + 2, pnz = nz + 2;
  const padded = new Uint8Array(pnx * pny * pnz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const src = i + j * nx + k * nx * ny;
        if (!mask[src]) continue;
        const dst = (i + 1) + (j + 1) * pnx + (k + 1) * pnx * pny;
        padded[dst] = 1;
      }
    }
  }
  return { padded, pdims: [pnx, pny, pnz] as [number, number, number] };
}

function _runMarchingCubes(padded: Uint8Array, pdims: [number, number, number]) {
  const imageData = vtkImageData.newInstance();
  imageData.setDimensions(pdims as unknown as [number, number, number]);
  imageData.setSpacing([1, 1, 1]);
  imageData.setOrigin([0, 0, 0]);
  const scalars = vtkDataArray.newInstance({
    name: "scalars",
    values: padded,
    numberOfComponents: 1,
  });
  imageData.getPointData().setScalars(scalars);

  const mc = vtkImageMarchingCubes.newInstance({ contourValue: 0.5, computeNormals: false, mergePoints: false });
  mc.setInputData(imageData);
  const output = mc.getOutputData();
  const points = output.getPoints().getData() as Float32Array;
  const polys = output.getPolys().getData() as Uint32Array;
  return { points, polys };
}

function _vtkPolysToIndices(polys: Uint32Array): Uint32Array {
  const indices: number[] = [];
  let p = 0;
  while (p < polys.length) {
    const n = polys[p++];
    for (let c = 0; c < n; c++) indices.push(polys[p++]);
  }
  return new Uint32Array(indices);
}


function _transformVertices(
  points: Float32Array,
  origin: number[],
  spacing: number[],
  direction: number[],
  manifestCenter: [number, number, number]
): Float32Array {
  const out = new Float32Array(points.length);
  const flip = [-1, -1, 1];

  for (let v = 0; v < points.length; v += 3) {
    const i = points[v] - 1;
    const j = points[v + 1] - 1;
    const k = points[v + 2] - 1;

    const lpsX = direction[0] * i * spacing[0] + direction[3] * j * spacing[1] + direction[6] * k * spacing[2] + origin[0];
    const lpsY = direction[1] * i * spacing[0] + direction[4] * j * spacing[1] + direction[7] * k * spacing[2] + origin[1];
    const lpsZ = direction[2] * i * spacing[0] + direction[5] * j * spacing[1] + direction[8] * k * spacing[2] + origin[2];

    const rasX = lpsX * flip[0];
    const rasY = lpsY * flip[1];
    const rasZ = lpsZ * flip[2];

    const threeX = rasX;
    const threeY = rasZ;
    const threeZ = -rasY;

    out[v] = threeX - manifestCenter[0];
    out[v + 1] = threeY - manifestCenter[1];
    out[v + 2] = threeZ - manifestCenter[2];
  }
  return out;
}
// ============================================================================
// SECTION: Live Mesh Extraction (Marching Cubes)
// ============================================================================


// ============================================================================
// SECTION: Threshold Fill (Dual-Scribble)
// ============================================================================

// ---------------------------------------------------------------------------
// Dual-scribble threshold fill: mark a point (or short stroke) inside the
// target structure ("foreground") and one outside it in whatever you want
// excluded ("background"). Computes a separating HU threshold from the two,
// then flood-fills in 3D from the foreground seeds, stopping at that
// threshold, the seeds' bounding box, and any other segment's voxels.
// ---------------------------------------------------------------------------
// Robust stats: mean/min/max are kept for display, but the threshold itself
// is derived from percentiles (median + a trimmed spread) so a single stray
// scribble voxel landing on a partial-volume edge pixel can't drag the whole
// split threshold toward the wrong tissue the way a raw mean can.
function _huStats(ctData: ArrayLike<number>, idxOf: (i: number, j: number, k: number) => number, seeds: [number, number, number][]) {
  const values: number[] = new Array(seeds.length);
  let min = Infinity, max = -Infinity, sum = 0;
  for (let s = 0; s < seeds.length; s++) {
    const [i, j, k] = seeds[s];
    const v = ctData[idxOf(i, j, k)];
    values[s] = v;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  values.sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (values.length === 1) return values[0];
    const idx = p * (values.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return values[lo] + (values[hi] - values[lo]) * (idx - lo);
  };
  return { min, max, mean: sum / seeds.length, median: percentile(0.5), p25: percentile(0.25), p75: percentile(0.75) };
}

export type DualFillStats = ReturnType<typeof _huStats>;

// Computes the separating HU threshold from a foreground/background scribble
// pair without touching the segmentation — lets the UI show "growing at
// -40 HU" and offer a slider to nudge it before (or after) the fill runs,
// the way 3D Slicer's Local Threshold effect surfaces its computed value.
export function computeDualScribbleThreshold(
  foregroundSeeds: Array<[number, number, number]>,
  backgroundSeeds: Array<[number, number, number]>
): { threshold: number; fgIsBrighter: boolean; fgStats: DualFillStats; bgStats: DualFillStats } | null {
  if (!foregroundSeeds.length || !backgroundSeeds.length) return null;
  const ctVolume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  if (!ctVolume) return null;
  const ctVm = ctVolume.voxelManager as any;
  if (!ctVm) return null;
  const [dimX, dimY] = ctVm.dimensions;
  let ctData: ArrayLike<number> | undefined;
  try { ctData = ctVm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!ctData || !ctData.length) return null;
  const idxOf = (i: number, j: number, k: number) => i + j * dimX + k * dimX * dimY;

  const fgStats = _huStats(ctData, idxOf, foregroundSeeds);
  const bgStats = _huStats(ctData, idxOf, backgroundSeeds);
  const fgIsBrighter = fgStats.median >= bgStats.median;
  // Split the gap between the *closest-facing* robust edges of each
  // distribution (fg's p25 vs bg's p75, or vice versa) rather than the
  // means — this keeps the line near the true tissue boundary even when
  // one scribble has more outliers than the other.
  const fgEdge = fgIsBrighter ? fgStats.p25 : fgStats.p75;
  const bgEdge = fgIsBrighter ? bgStats.p75 : bgStats.p25;
  const threshold = (fgEdge + bgEdge) / 2;
  return { threshold, fgIsBrighter, fgStats, bgStats };
}

export type DualFillOptions = {
  connectivity?: 6 | 26;
  maxVoxels?: number;
  boundingBoxMargin?: number;
  respectOtherLabels?: boolean;
  sliceLock?: { pane: CinePane } | null;
  maskFilter?: MaskFilter;
  // Overrides the auto-computed threshold — wire this to a slider so the
  // radiologist can tighten/loosen the fill after seeing the preview,
  // instead of having to re-scribble to change the result.
  manualThresholdHu?: number;
  // Post-fill morphological closing (dilate-then-erode, in voxels) that
  // patches single-voxel pinholes and smooths the jagged edge a raw
  // flood-fill leaves on noisy CT. 0/undefined = off. 1 is usually enough.
  closingRadius?: number;
  // When true, computes and returns the mask without writing it to the
  // segmentation — for a live "ghost" preview overlay while the user is
  // still scribbling, mirroring Slicer's continuous preview.
  dryRun?: boolean;
};


export function runDualScribbleFill(
  foregroundSeeds: Array<[number, number, number]>,
  backgroundSeeds: Array<[number, number, number]>,
  options: DualFillOptions = {}
): { filledVoxels: number; threshold: number; voxels?: Array<[number, number, number]> } | null {
  const {
    connectivity = 6,
    maxVoxels = 2_000_000,
    boundingBoxMargin = 30,
    respectOtherLabels = false,
    sliceLock = null,
    maskFilter = () => true,
    manualThresholdHu,
    closingRadius = 0,
    dryRun = false,
  } = options;

  if (!foregroundSeeds.length || !backgroundSeeds.length) {
    console.warn("Smart fill needs both an inside and an outside scribble.");
    return null;
  }

  const ctVolume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  const segVolume = cache.getVolume(segmentationId);
  if (!ctVolume || !segVolume) return null;

  const ctVm = ctVolume.voxelManager as any;
  const segVm = segVolume.voxelManager as any;
  if (!ctVm || !segVm) return null;

  const [dimX, dimY, dimZ] = ctVm.dimensions;
  let ctData: ArrayLike<number> | undefined;
  try { ctData = ctVm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!ctData || !ctData.length) return null;

  const sliceSize = dimX * dimY;
  const idxOf = (i: number, j: number, k: number) => i + j * dimX + k * sliceSize;
  const inBounds = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < dimX && j < dimY && k < dimZ;

  const fgValid = foregroundSeeds.filter(([i, j, k]) => inBounds(i, j, k));
  const bgValid = backgroundSeeds.filter(([i, j, k]) => inBounds(i, j, k));
  if (!fgValid.length || !bgValid.length) return null;

  const fgStats = _huStats(ctData, idxOf, fgValid);
  const bgStats = _huStats(ctData, idxOf, bgValid);
  const fgIsBrighter = fgStats.median >= bgStats.median;
  const fgEdge = fgIsBrighter ? fgStats.p25 : fgStats.p75;
  const bgEdge = fgIsBrighter ? bgStats.p75 : bgStats.p25;
  const autoThreshold = (fgEdge + bgEdge) / 2;
  const threshold = manualThresholdHu ?? autoThreshold;
  const passes = (hu: number) => (fgIsBrighter ? hu >= threshold : hu <= threshold);

  let bi0 = dimX, bi1 = -1, bj0 = dimY, bj1 = -1, bk0 = dimZ, bk1 = -1;
  for (const [i, j, k] of [...fgValid, ...bgValid]) {
    bi0 = Math.min(bi0, i); bi1 = Math.max(bi1, i);
    bj0 = Math.min(bj0, j); bj1 = Math.max(bj1, j);
    bk0 = Math.min(bk0, k); bk1 = Math.max(bk1, k);
  }
  bi0 = Math.max(0, bi0 - boundingBoxMargin);
  bj0 = Math.max(0, bj0 - boundingBoxMargin);
  bk0 = Math.max(0, bk0 - boundingBoxMargin);
  bi1 = Math.min(dimX - 1, bi1 + boundingBoxMargin);
  bj1 = Math.min(dimY - 1, bj1 + boundingBoxMargin);
  bk1 = Math.min(dimZ - 1, bk1 + boundingBoxMargin);

  let lockAxis: 0 | 1 | 2 | null = null;
  if (sliceLock) {
    lockAxis = _sliceAxisForPane(sliceLock.pane);
    const sliceVal = lockAxis === 0 ? fgValid[0][0] : lockAxis === 1 ? fgValid[0][1] : fgValid[0][2];
    if (lockAxis === 0) { bi0 = bi1 = sliceVal; }
    else if (lockAxis === 1) { bj0 = bj1 = sliceVal; }
    else { bk0 = bk1 = sliceVal; }
  }

  const activeSegment = _activeEditSegment;
  const offsets6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const offsets26: number[][] = [];
  for (let di = -1; di <= 1; di++)
    for (let dj = -1; dj <= 1; dj++)
      for (let dk = -1; dk <= 1; dk++)
        if (di || dj || dk) offsets26.push([di, dj, dk]);
  const baseOffsets = connectivity === 6 ? offsets6 : offsets26;
  const offsets = lockAxis !== null ? _filterOffsetsAxis(baseOffsets, lockAxis) : baseOffsets;

  const visited = new Set<number>();
  const stack: number[] = [];
  for (const [i, j, k] of fgValid) {
    if (i < bi0 || i > bi1 || j < bj0 || j > bj1 || k < bk0 || k > bk1) continue;
    const lin = idxOf(i, j, k);
    if (!visited.has(lin)) { visited.add(lin); stack.push(lin); }
  }

  // Mask of every voxel the flood-fill accepts, keyed by linear index — built
  // regardless of dryRun so the (optional) closing pass and the preview path
  // share one code path instead of duplicating the flood-fill logic.
  const filledSet = new Set<number>();
  const filledCoords: Array<[number, number, number]> = [];

  while (stack.length) {
    const lin = stack.pop()!;
    const k = Math.floor(lin / sliceSize);
    const rem = lin - k * sliceSize;
    const j = Math.floor(rem / dimX);
    const i = rem - j * dimX;

    if (!passes(ctData[lin])) continue;
    if (!maskFilter(i, j, k)) continue; // <-- gate

    if (!dryRun) {
      const existing: number = segVm.getAtIJK(i, j, k);
      if (respectOtherLabels && existing !== 0 && existing !== activeSegment) continue;
    }

    filledSet.add(lin);
    filledCoords.push([i, j, k]);

    if (filledCoords.length > maxVoxels) {
      console.warn("Smart fill: hit voxel safety cap, stopping early.");
      break;
    }

    for (const [di, dj, dk] of offsets) {
      const ni = i + di, nj = j + dj, nk = k + dk;
      if (ni < bi0 || ni > bi1 || nj < bj0 || nj > bj1 || nk < bk0 || nk > bk1) continue;
      const nlin = idxOf(ni, nj, nk);
      if (!visited.has(nlin)) { visited.add(nlin); stack.push(nlin); }
    }
  }

  if (!filledCoords.length) return { filledVoxels: 0, threshold };

  if (dryRun) {
    // Preview path: caller (the live-scribble overlay) draws these voxels as
    // a ghost outline and never touches the segmentation.
    return { filledVoxels: filledCoords.length, threshold, voxels: filledCoords };
  }

  // Morphological closing: dilate the accepted mask by `closingRadius`, then
  // erode it back down. This patches the single-voxel pinholes and shaves
  // the jagged edge that a raw HU-threshold flood-fill leaves on real
  // (noisy) CT data, without letting the boundary drift outward net — the
  // erode step removes exactly what the dilate step added, except where
  // dilation bridged a gap and closed a hole for good.
  let finalSet = filledSet;
  if (closingRadius > 0) {
    const dilate = (src: Set<number>) => {
      const out = new Set(src);
      for (const lin of src) {
        const k = Math.floor(lin / sliceSize);
        const rem = lin - k * sliceSize;
        const j = Math.floor(rem / dimX);
        const i = rem - j * dimX;
        for (const [di, dj, dk] of offsets26) {
          const ni = i + di, nj = j + dj, nk = k + dk;
          if (ni < bi0 || ni > bi1 || nj < bj0 || nj > bj1 || nk < bk0 || nk > bk1) continue;
          if (!inBounds(ni, nj, nk)) continue;
          const nlin = idxOf(ni, nj, nk);
          if (!maskFilter(ni, nj, nk)) continue;
          out.add(nlin);
        }
      }
      return out;
    };
    const erode = (src: Set<number>) => {
      const out = new Set<number>();
      for (const lin of src) {
        const k = Math.floor(lin / sliceSize);
        const rem = lin - k * sliceSize;
        const j = Math.floor(rem / dimX);
        const i = rem - j * dimX;
        let keep = true;
        for (const [di, dj, dk] of offsets26) {
          const ni = i + di, nj = j + dj, nk = k + dk;
          if (ni < bi0 || ni > bi1 || nj < bj0 || nj > bj1 || nk < bk0 || nk > bk1) { keep = false; break; }
          if (!src.has(idxOf(ni, nj, nk))) { keep = false; break; }
        }
        if (keep) out.add(lin);
      }
      return out;
    };
    let grown = filledSet;
    for (let r = 0; r < closingRadius; r++) grown = dilate(grown);
    for (let r = 0; r < closingRadius; r++) grown = erode(grown);
    finalSet = grown;
  }

  const touched: Array<{ i: number; j: number; k: number; prev: number }> = [];
  for (const lin of finalSet) {
    const k = Math.floor(lin / sliceSize);
    const rem = lin - k * sliceSize;
    const j = Math.floor(rem / dimX);
    const i = rem - j * dimX;
    const existing: number = segVm.getAtIJK(i, j, k);
    if (respectOtherLabels && existing !== 0 && existing !== activeSegment) continue;
    if (existing !== activeSegment) {
      touched.push({ i, j, k, prev: existing });
      segVm.setAtIJK(i, j, k, activeSegment);
    }
  }

  if (!touched.length) return { filledVoxels: 0, threshold };

  _pushFillHistory({
    undo: () => { for (const { i, j, k, prev } of touched) segVm.setAtIJK(i, j, k, prev); _notifySegmentationChanged(); },
    redo: () => { for (const { i, j, k } of touched) segVm.setAtIJK(i, j, k, activeSegment); _notifySegmentationChanged(); },
  });

  _notifySegmentationChanged();
  return { filledVoxels: touched.length, threshold };
}
// Guards the dispatch below so the module-level listener a few lines down
// (which stamps _lastBrushEditTime) can tell "this SEGMENTATION_DATA_MODIFIED
// came from OUR OWN edit path (fill/box/point/scissors/lasso/etc, all of
// which route through this function)" apart from "this came natively from
// Cornerstone's own BrushTool after a paint/erase stroke" — both dispatch
// the identical event, so without this flag the two are indistinguishable
// from the listener's side, which is exactly what made the old
// "smart-fill-stack always wins" undo ordering wrong (see _lastFillEditTime
// / _lastBrushEditTime below).
let _dispatchingOwnEdit = false;

function _notifySegmentationChanged() {
  _dispatchingOwnEdit = true;
  try {
    // This is what BrushTool's own strategies call after painting — it invalidates the
    // labelmap's cached GPU texture so the 2D volume viewports actually repaint the new
    // voxels. Direct voxelManager writes (smart fill, box prompt, live-wire, morphology,
    // boolean ops, copy-across-slices, CPR paint, etc.) bypass the brush pipeline entirely,
    // so without this call, edits land in the raw array — visible to a fresh marching-cubes
    // pass (3D) — but never make it to the 2D panes' GPU texture.
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      undefined,
      _activeEditSegment
    );
  } catch {
    eventTarget.dispatchEvent(
      new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, {
        detail: { segmentationId, segmentIndex: _activeEditSegment },
      })
    );
  }
  _dispatchingOwnEdit = false;
  currentRenderingEngine?.renderViewports([...MPR_VIEWPORT_IDS]);
  currentRenderingEngine?.render();
}

// Fires once, unconditionally, for the lifetime of the module — separate
// from subscribeToSegmentationEdits below (which callers attach/detach per
// component). Its only job is recency-tracking for undoMaskEdit/redoMaskEdit:
// stamp _lastBrushEditTime whenever a genuine NATIVE brush/eraser stroke
// changes the labelmap (i.e. the event fired WITHOUT _dispatchingOwnEdit set,
// meaning it didn't come from _notifySegmentationChanged / our own edit
// paths). See _pushFillHistory below for the matching _lastFillEditTime.
eventTarget.addEventListener(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, () => {
  if (!_dispatchingOwnEdit) _lastBrushEditTime = Date.now();
});

// ============================================================================
// SECTION: Undo / Redo History
// ============================================================================


type FillHistoryEntry = { undo: () => void; redo: () => void };
let _fillHistory: FillHistoryEntry[] = [];
let _fillHistoryIndex = -1;

// Recency trackers so undoMaskEdit/redoMaskEdit can pick whichever of the
// two history mechanisms (this _fillHistory stack, used by smart fill,
// scissors, lasso, and point/box segmentation; or Cornerstone's own
// HistoryMemo, used natively by brush/eraser strokes) the user actually
// touched most recently — instead of always preferring one stack
// regardless of order, which let an older fill-type undo silently jump
// ahead of a newer brush stroke when the two were interleaved.
let _lastFillEditTime = 0;
let _lastBrushEditTime = 0;

function _pushFillHistory(entry: FillHistoryEntry) {
  _fillHistory = _fillHistory.slice(0, _fillHistoryIndex + 1);
  _fillHistory.push(entry);
  _fillHistoryIndex = _fillHistory.length - 1;
  _lastFillEditTime = Date.now();
}

// Exposed so hooks/components outside this module (e.g. useSmartFill's
// scribble-point placement) can register their own undo/redo pairs on the
// same shared history stack as every other edit tool, rather than keeping
// a separate parallel undo system just for scribbles.
export function pushEditHistory(entry: FillHistoryEntry) {
  _pushFillHistory(entry);
}

export function undoSmartFill(): boolean {
  if (_fillHistoryIndex < 0) return false;
  _fillHistory[_fillHistoryIndex].undo();
  _fillHistoryIndex--;
  return true;
}

export function redoSmartFill(): boolean {
  if (_fillHistoryIndex + 1 >= _fillHistory.length) return false;
  _fillHistoryIndex++;
  _fillHistory[_fillHistoryIndex].redo();
  return true;
}

export function canUndoSmartFill(): boolean { return _fillHistoryIndex >= 0; }
export function canRedoSmartFill(): boolean { return _fillHistoryIndex + 1 < _fillHistory.length; }

// ============================================================================
// SECTION: Canvas / Voxel Coordinate Helpers
// ============================================================================

export function canvasPointToVoxel(pane: CinePane, canvasPos: Point2): [number, number, number] | null {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return null;
  const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as any;
  const volume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  if (!viewport || !volume?.imageData) return null;
  try {
    const world = viewport.canvasToWorld(canvasPos);
    const [i, j, k] = volume.imageData.worldToIndex(world).map((v: number) => Math.round(v));
    return [i, j, k];
  } catch {
    return null;
  }
}
// Canvas-pixel positions only mean what they mean for the camera that was
// active the instant they were captured — zooming/panning afterward remaps
// every world location to a different canvas pixel, so anything stashed as
// a raw canvas coordinate (a lasso/scissors corner, a smart-fill seed dot)
// silently drifts off the anatomy it was placed on the moment the camera
// changes, both visually and — if it's later fed back into
// canvasPointToVoxel — in the actual voxels the tool acts on. World-space
// (mm) points don't have that problem: a world coordinate names the same
// physical location regardless of zoom/pan. Anything that needs to survive
// a camera change between "placed" and "drawn/committed" should be stored
// via canvasPointToWorld and turned back into a canvas pixel via
// worldToCanvasPoint at the moment it's actually drawn or committed.
export function canvasPointToWorld(pane: CinePane, canvasPos: Point2): Point3 | null {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return null;
  const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as any;
  if (!viewport) return null;
  try {
    return viewport.canvasToWorld(canvasPos) as Point3;
  } catch {
    return null;
  }
}

export function worldToCanvasPoint(pane: CinePane, world: Point3): [number, number] | null {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return null;
  const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as any;
  if (!viewport) return null;
  try {
    const [x, y] = viewport.worldToCanvas(world) as Point2;
    return [x, y];
  } catch {
    return null;
  }
}

function _sliceAxisForPane(pane: CinePane): 0 | 1 | 2 {
  return pane === "sagittal" ? 0 : pane === "coronal" ? 1 : 2;
}

// Public wrapper — lets callers outside this module (e.g. the level-tracing click
// handler) resolve which IJK axis a pane scrolls along without duplicating the mapping.
export function sliceAxisForPane(pane: CinePane): 0 | 1 | 2 {
  return _sliceAxisForPane(pane);
}

// ============================================================================
// SECTION: Magnetic Lasso ("Live Wire" / Intelligent Scissors) — Mortensen &
// Barrett's classic formulation. The current slice is treated as a weighted
// graph (each pixel a node, 8-connected to its neighbors); edge cost is low
// across a strong intensity boundary and high in flat regions, so the
// lowest-cost path between two points (found via Dijkstra) hugs nearby edges
// instead of cutting straight through tissue. A user click still "freezes" a
// fastening point exactly where clicked (usePolygonDraw handles that part);
// this function only answers "what's the best path from the last fastening
// point to here" for the live preview, and for baking that path in on click.
// ============================================================================

// Cost image window is capped for perf/latency (this runs on every mousemove).
// If the last fastening point and the cursor are further apart than this (in
// voxels), the search window would be too large to stay interactive — the
// caller falls back to a straight segment for that leg instead.
const LIVEWIRE_MAX_SPAN_VOXELS = 110;
const LIVEWIRE_WINDOW_MARGIN = 8;

// Static per-pixel cost weights (Mortensen & Barrett's fG/fZ/fD terms).
const LIVEWIRE_W_GRADIENT = 0.55;
const LIVEWIRE_W_LAPLACIAN = 0.25;
const LIVEWIRE_W_DIRECTION = 0.20;

// The refined snap point (see refinePoint below) sits at the objective
// gradient-magnitude peak of the CT intensity ramp — the mathematically
// "sharpest" point of the transition. That can read as a few mm inside the
// true anatomical boundary compared to where a human eye places the edge
// under typical windowing, since the visually-perceived edge and the raw
// gradient peak aren't always the same point. This nudges the final refined
// point a small extra distance further along the SAME outward normal
// refinePoint already found, landing it a bit past the gradient peak instead
// of exactly on it.
//
// Sign convention: positive values move along +[ux,uy], i.e. from lower-HU
// toward higher-HU across the edge — for a denser structure (bone, most solid
// organs) against a less-dense surround (fat/air), that's outward, away from
// the structure's interior. If a specific case needs the opposite (e.g.
// tracing something LESS dense than its surround), flip the sign here — this
// is a single scalar, not per-edge logic, so it can't be made
// direction-aware automatically without knowing which side is "inside" for
// an arbitrary class.
const LIVEWIRE_OUTWARD_BIAS_VOXELS = 0.9;

// Minimal binary min-heap keyed by a numeric priority — enough for Dijkstra
// over a few thousand nodes without pulling in a dependency.
class _MinHeap {
  private heap: Array<{ node: number; dist: number }> = [];
  get size() { return this.heap.length; }
  push(node: number, dist: number) {
    const h = this.heap;
    h.push({ node, dist });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent].dist <= h[i].dist) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }
  pop(): { node: number; dist: number } | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let smallest = i;
        if (l < h.length && h[l].dist < h[smallest].dist) smallest = l;
        if (r < h.length && h[r].dist < h[smallest].dist) smallest = r;
        if (smallest === i) break;
        [h[smallest], h[i]] = [h[i], h[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Lowest-cost ("live wire") path from `from` to `to`, both canvas points on
 * `pane`, hugging nearby intensity edges. Returns a dense array of canvas
 * points from `from` to `to` inclusive, or null if the two points are too
 * far apart to search interactively, or anything needed is unavailable —
 * callers should fall back to a straight line between the two points.
 */
export function computeLiveWirePath(
  pane: CinePane,
  from: Point2,
  to: Point2
): Array<[number, number]> | null {
  const engine = getRenderingEngine(renderingEngineId);
  if (!engine) return null;
  const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as any;
  const ctVolume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  if (!viewport || !ctVolume?.imageData) return null;
  const ctVm = ctVolume.voxelManager as any;
  if (!ctVm) return null;

  let ctData: ArrayLike<number> | undefined;
  try { ctData = ctVm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!ctData || !ctData.length) return null;

  const [dimX, dimY, dimZ] = ctVm.dimensions;
  const axis = _sliceAxisForPane(pane);
  const [sliceDimA, sliceDimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const sliceSize = dimX * dimY;
  const idxOf = (i: number, j: number, k: number) => i + j * dimX + k * sliceSize;

  const toIJK = (canvasPos: Point2): [number, number, number] | null => {
    try {
      const world = viewport.canvasToWorld(canvasPos);
      return ctVolume.imageData.worldToIndex(world).map((v: number) => Math.round(v)) as [number, number, number];
    } catch {
      return null;
    }
  };
  const fromIJK = toIJK(from);
  const toIJK_ = toIJK(to);
  if (!fromIJK || !toIJK_) return null;

  const aOf = (ijk: [number, number, number]) => (axis === 2 ? ijk[0] : axis === 0 ? ijk[1] : ijk[0]);
  const bOf = (ijk: [number, number, number]) => (axis === 2 ? ijk[1] : axis === 0 ? ijk[2] : ijk[2]);
  const sliceOf = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, fromIJK[2]] : axis === 0 ? [fromIJK[0], a, b] : [a, fromIJK[1], b];

  const seedA = aOf(fromIJK), seedB = bOf(fromIJK);
  const targetA = aOf(toIJK_), targetB = bOf(toIJK_);

  if (Math.hypot(targetA - seedA, targetB - seedB) > LIVEWIRE_MAX_SPAN_VOXELS) return null;

  // Local search window: bounding box of the two endpoints, padded, clamped
  // to the slice.
  const winA0 = Math.max(0, Math.min(seedA, targetA) - LIVEWIRE_WINDOW_MARGIN);
  const winA1 = Math.min(sliceDimA - 1, Math.max(seedA, targetA) + LIVEWIRE_WINDOW_MARGIN);
  const winB0 = Math.max(0, Math.min(seedB, targetB) - LIVEWIRE_WINDOW_MARGIN);
  const winB1 = Math.min(sliceDimB - 1, Math.max(seedB, targetB) + LIVEWIRE_WINDOW_MARGIN);
  const winW = winA1 - winA0 + 1, winH = winB1 - winB0 + 1;
  if (winW < 2 || winH < 2) return null;

  const huAt = (a: number, b: number): number => {
    const ca = Math.min(winA1, Math.max(winA0, a));
    const cb = Math.min(winB1, Math.max(winB0, b));
    const [i, j, k] = sliceOf(ca, cb);
    return ctData![idxOf(i, j, k)];
  };

  const local = (a: number, b: number) => (a - winA0) + (b - winB0) * winW;
  const n = winW * winH;

  // Precompute Sobel gradient (gx, gy) and a simple discrete Laplacian at
  // every pixel in the window, tracking the max magnitudes for normalization.
  const gx = new Float32Array(n), gy = new Float32Array(n), lap = new Float32Array(n);
  let maxGradMag = 0, maxAbsLap = 0;
  for (let b = winB0; b <= winB1; b++) {
    for (let a = winA0; a <= winA1; a++) {
      const li = local(a, b);
      const l = huAt(a - 1, b), r = huAt(a + 1, b), u = huAt(a, b - 1), d = huAt(a, b + 1);
      const c = huAt(a, b);
      const ggx = r - l, ggy = d - u;
      gx[li] = ggx; gy[li] = ggy;
      const mag = Math.hypot(ggx, ggy);
      if (mag > maxGradMag) maxGradMag = mag;
      const l2 = l + r + u + d - 4 * c;
      lap[li] = l2;
      const absLap = Math.abs(l2);
      if (absLap > maxAbsLap) maxAbsLap = absLap;
    }
  }
  if (maxGradMag <= 0) return null; // perfectly flat window — nothing to hug

  // Static per-node cost: low near strong edges (fG) and near Laplacian
  // zero-crossings (fZ) — both normalized to [0, 1], low = "cheap to cross".
  const nodeCost = new Float32Array(n);
  for (let li = 0; li < n; li++) {
    const fG = 1 - Math.hypot(gx[li], gy[li]) / maxGradMag;
    const fZ = maxAbsLap > 0 ? Math.abs(lap[li]) / maxAbsLap : 0;
    nodeCost[li] = LIVEWIRE_W_GRADIENT * fG + LIVEWIRE_W_LAPLACIAN * fZ;
  }

  const seedLocal = local(seedA, seedB);
  const targetLocal = local(targetA, targetB);

  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[seedLocal] = 0;

  const heap = new _MinHeap();
  heap.push(seedLocal, 0);

  const NEIGHBORS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  while (heap.size) {
    const { node: cur, dist: curDist } = heap.pop()!;
    if (visited[cur]) continue;
    visited[cur] = 1;
    if (cur === targetLocal) break;

    const curA = winA0 + (cur % winW), curB = winB0 + Math.floor(cur / winW);
    // Direction of travel into `cur` (used for the bending penalty on the
    // NEXT step) — undefined at the seed itself.
    const prevNode = prev[cur];
    let inDirX = 0, inDirY = 0, hasInDir = false;
    if (prevNode >= 0) {
      const pa = winA0 + (prevNode % winW), pb = winB0 + Math.floor(prevNode / winW);
      const ddx = curA - pa, ddy = curB - pb;
      const dlen = Math.hypot(ddx, ddy) || 1;
      inDirX = ddx / dlen; inDirY = ddy / dlen;
      hasInDir = true;
    }

    for (const [da, db] of NEIGHBORS) {
      const na = curA + da, nb = curB + db;
      if (na < winA0 || na > winA1 || nb < winB0 || nb > winB1) continue;
      const ni = local(na, nb);
      if (visited[ni]) continue;

      const linkLen = Math.hypot(da, db); // 1 or sqrt(2)
      // Direction/bending cost: penalize turning sharply relative to the
      // incoming direction, so the path favors smooth, continuous curves
      // over jagged zig-zags (fD in Mortensen & Barrett).
      let fD = 0;
      if (hasInDir) {
        const outLen = linkLen;
        const dot = (inDirX * da + inDirY * db) / outLen;
        fD = 1 - Math.max(-1, Math.min(1, dot)); // 0 = straight ahead, up to 2 = reversal
        fD = fD / 2; // normalize to [0, 1]
      }
      const stepCost = linkLen * (nodeCost[ni] + LIVEWIRE_W_DIRECTION * fD + 0.02); // small floor avoids zero-cost loops
      const nd = curDist + stepCost;
      if (nd < dist[ni]) {
        dist[ni] = nd;
        prev[ni] = cur;
        heap.push(ni, nd);
      }
    }
  }

  if (!visited[targetLocal] && dist[targetLocal] === Infinity) return null;

  // Walk back from target to seed, then reverse.
  const pathLocal: number[] = [];
  let walk = targetLocal;
  let guard = n + 1;
  while (walk !== -1 && guard-- > 0) {
    pathLocal.push(walk);
    if (walk === seedLocal) break;
    walk = prev[walk];
  }
  if (pathLocal[pathLocal.length - 1] !== seedLocal) return null; // unreachable
  pathLocal.reverse();

  // --- Sub-voxel edge snap ---------------------------------------------
  // The raw Dijkstra path above is grid-locked (every point sits on an
  // integer voxel) and, on any CONVEX stretch of boundary, is quietly
  // biased toward the INSIDE of the intensity transition: a real CT edge
  // is a ramp several voxels wide (partial-volume blur), not a single-
  // pixel step, and going around the inside of that ramp is a shorter
  // route than going around the outside. Since the search also minimizes
  // path length (linkLen + the bending penalty), that small length
  // advantage quietly wins the tie-break across a whole curved stretch —
  // this is what shows up as the contour consistently sitting a few mm
  // inside the true boundary. Fix: for every interior point (the two
  // fastened endpoints are left exactly where the user clicked), walk a
  // short distance along the LOCAL intensity gradient — i.e.
  // perpendicular to the edge — and re-center the point on the actual
  // gradient-magnitude peak, located with sub-voxel precision via a
  // parabolic fit rather than whichever integer voxel the graph search
  // happened to land on. Bilinear-sampled, so it isn't limited to the
  // same coarse grid that caused the bias in the first place.
  const sampleHUf = (a: number, b: number): number => {
    const a0 = Math.floor(a), b0 = Math.floor(b);
    const fa = a - a0, fb = b - b0;
    const v00 = huAt(a0, b0), v10 = huAt(a0 + 1, b0);
    const v01 = huAt(a0, b0 + 1), v11 = huAt(a0 + 1, b0 + 1);
    return v00 * (1 - fa) * (1 - fb) + v10 * fa * (1 - fb) + v01 * (1 - fa) * fb + v11 * fa * fb;
  };
  const H = 0.5; // sub-voxel differencing step, in voxels
  const gradAtf = (a: number, b: number): [number, number] => [
    (sampleHUf(a + H, b) - sampleHUf(a - H, b)) / (2 * H),
    (sampleHUf(a, b + H) - sampleHUf(a, b - H)) / (2 * H),
  ];
  const gradMagAtf = (a: number, b: number): number => {
    const [gxf, gyf] = gradAtf(a, b);
    return Math.hypot(gxf, gyf);
  };

  const REFINE_RADIUS = 1.75; // voxels either side of the raw path point to search
  const REFINE_STEP = 0.25;
  const refinePoint = (a: number, b: number): [number, number] => {
    const [gxf, gyf] = gradAtf(a, b);
    const gmag = Math.hypot(gxf, gyf);
    if (gmag < 1e-6) return [a, b]; // flat locally — nothing to snap to, leave it
    const ux = gxf / gmag, uy = gyf / gmag; // unit vector along the gradient, i.e. perpendicular to the edge

    // Coarse search for the strongest gradient magnitude along that
    // normal. Starts from (and only ever improves on) the raw point's own
    // magnitude, so this can only pull toward a genuinely stronger nearby
    // edge — never introduces a large jump toward an unrelated feature.
    let bestT = 0, bestMag = gmag;
    for (let t = -REFINE_RADIUS; t <= REFINE_RADIUS; t += REFINE_STEP) {
      if (t === 0) continue;
      const m = gradMagAtf(a + ux * t, b + uy * t);
      if (m > bestMag) { bestMag = m; bestT = t; }
    }
    // Parabolic sub-step refinement around the winning sample so the final
    // point isn't itself grid-locked to REFINE_STEP increments.
    const mMinus = gradMagAtf(a + ux * (bestT - REFINE_STEP), b + uy * (bestT - REFINE_STEP));
    const mPlus = gradMagAtf(a + ux * (bestT + REFINE_STEP), b + uy * (bestT + REFINE_STEP));
    const denom = mMinus - 2 * bestMag + mPlus;
    const delta = Math.abs(denom) > 1e-6 ? (0.5 * (mMinus - mPlus)) / denom : 0;
    const tRefined = bestT + Math.max(-REFINE_STEP, Math.min(REFINE_STEP, delta * REFINE_STEP));

    return [a + ux * (tRefined + LIVEWIRE_OUTWARD_BIAS_VOXELS), b + uy * (tRefined + LIVEWIRE_OUTWARD_BIAS_VOXELS)];
  };

  const points: Array<[number, number]> = [];
  for (let idx = 0; idx < pathLocal.length; idx++) {
    const li = pathLocal[idx];
    let a = winA0 + (li % winW), b = winB0 + Math.floor(li / winW);
    // Leave the two fastened endpoints exactly where the user clicked —
    // only interior points get snapped to the refined edge location.
    if (idx > 0 && idx < pathLocal.length - 1) {
      [a, b] = refinePoint(a, b);
    }
    // sliceOf works fine with fractional a/b (it just slots them into the
    // fixed-axis tuple) — passing the refined, non-rounded values straight
    // through is what actually preserves the sub-voxel correction; feeding
    // it Math.round(a)/Math.round(b) here would throw the refinement away.
    const [i, j, k] = sliceOf(a, b);
    try {
      const world = ctVolume.imageData.indexToWorld([i, j, k]);
      const canvasPt = viewport.worldToCanvas(world);
      points.push([canvasPt[0], canvasPt[1]]);
    } catch {
      /* skip unmappable point */
    }
  }
  return points.length >= 2 ? points : null;
}

// ============================================================================
// SECTION: Margin (mm-based grow/shrink) — Slicer's Margin effect converts a
// physical mm size to an iteration count per axis via spacing, then reuses
// the same erode/dilate voxel logic already in this file.
// ============================================================================

export function applyMargin(
  operation: "grow" | "shrink",
  marginMm: number,
  applyToVisibleSegments = false,
  visibleSegmentIndices: number[] = [],
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  if (!segVolume) return null;
  const spacing = segVolume.spacing as number[];
  // Convert mm -> voxel-iteration count SEPARATELY per axis, the same way
  // getActualMarginMm already does for its "Actual: X x Y x Zmm" readout.
  // The previous version averaged spacing[0..2] into one number and applied
  // that single iteration count isotropically to all three axes. That's
  // only correct for isotropic volumes — real CT volumes are frequently
  // anisotropic (e.g. ~0.7mm in-plane vs 3-5mm slice thickness), so
  // averaging silently made the operation overshoot the requested margin on
  // the coarse axis (or undershoot on the fine ones) while never matching
  // what the "Actual" readout next to it claimed. Clamp per axis for the
  // same reasons as before: guard NaN/Infinity from degenerate spacing, and
  // cap runaway iteration counts for extreme mm inputs.
  const iterationsPerAxis = [0, 1, 2].map((axis) => {
    const raw = marginMm / spacing[axis];
    return Number.isFinite(raw) ? Math.min(2000, Math.max(1, Math.round(raw))) : 1;
  }) as [number, number, number];
  const targets = applyToVisibleSegments && visibleSegmentIndices.length ? visibleSegmentIndices : [_activeEditSegment];

  let total = 0;
  const savedActive = _activeEditSegment;
  for (const segmentIndex of targets) {
    _activeEditSegment = segmentIndex;
    const r = _applyAnisotropicMorphSequence(operation === "grow" ? "dilate" : "erode", iterationsPerAxis, maskFilter);
    if (r) total += r.changedVoxels;
  }
  _activeEditSegment = savedActive;
  return { changedVoxels: total };
}

// Axis-only offset pairs (no diagonals) — growth/shrink by a box-shaped
// structuring element with a possibly-different radius per axis is
// separable: doing three sequential single-axis passes, each with its own
// iteration count, is mathematically exact (order doesn't matter for
// min/max filters with a box element), unlike trying to encode three
// different radii into one combined multi-axis BFS "level".
const _AXIS_OFFSETS: number[][][] = [
  [[1, 0, 0], [-1, 0, 0]],
  [[0, 1, 0], [0, -1, 0]],
  [[0, 0, 1], [0, 0, -1]],
];

function _applyAnisotropicMorphSequence(
  mode: "dilate" | "erode",
  iterationsPerAxis: [number, number, number],
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const activeSegment = _activeEditSegment;

  const maxIter = Math.max(...iterationsPerAxis);
  const margin = maxIter + 1;
  const bbox = _segBBox(vm, activeSegment, margin);
  if (!bbox) return null;
  const { i0, i1, j0, j1, k0, k1 } = bbox;
  const w = i1 - i0 + 1, h = j1 - j0 + 1, d = k1 - k0 + 1;
  const idxLocal = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;

  const original = new Uint8Array(w * h * d);
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
    if (vm.getAtIJK(i, j, k) === activeSegment) original[idxLocal(i, j, k)] = 1;

  // Split by CONNECTED COMPONENT, not by the whole segment's bbox — an
  // annotation drawn on a single axial/sagittal/coronal slice has zero
  // thickness on that axis, and a box structuring element strips a
  // one-slice-thin blob in a single erode iteration (both neighbors along
  // that axis are background, so the entire slice reads as "boundary").
  // Growth is just as meaningless there — it bleeds the shape onto empty
  // adjacent slices instead of refining anything visible on the slice being
  // edited. "thin" components are left untouched below; "thick" (genuinely
  // 3D) components go through erode/dilate as normal, even when they share
  // a segment class with a thin one elsewhere in the volume.
  const { thick, thin } = _splitThinComponents(original, w, h, d);

  let cur = thick;
  for (let axis = 0; axis < 3; axis++) {
    const iterations = iterationsPerAxis[axis];
    if (iterations <= 0) continue;
    cur = _morphDistanceMask(cur, w, h, d, _AXIS_OFFSETS[axis], iterations, mode);
  }
  // Thin components are never grown or shrunk — restore them verbatim.
  for (let li = 0; li < cur.length; li++) if (thin[li]) cur[li] = 1;

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const li = idxLocal(i, j, k);
    if (!maskFilter(i, j, k)) continue; // <-- global masking gate
    const wantFg = cur[li] === 1;
    const existing = vm.getAtIJK(i, j, k);
    if (wantFg && existing !== activeSegment) {
      if (existing !== 0) continue;
      changes.push({ i, j, k, prev: existing, next: activeSegment });
    } else if (!wantFg && existing === activeSegment) {
      changes.push({ i, j, k, prev: existing, next: 0 });
    }
  }
  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}
// Actual physical margin size given the current pixel-space (for the "Actual: 2.5 x 2.5 x 2.4mm" readout).
export function getActualMarginMm(marginMm: number): { mm: [number, number, number]; voxels: [number, number, number] } | null {
  const segVolume = cache.getVolume(segmentationId);
  if (!segVolume) return null;
  const spacing = segVolume.spacing as number[];
  const voxels: [number, number, number] = [
    Math.max(1, Math.round(marginMm / spacing[0])),
    Math.max(1, Math.round(marginMm / spacing[1])),
    Math.max(1, Math.round(marginMm / spacing[2])),
  ];
  return { mm: [voxels[0] * spacing[0], voxels[1] * spacing[1], voxels[2] * spacing[2]], voxels };
}

// ============================================================================
// SECTION: Hollow — mirrors Slicer's Hollow effect: converts the active
// segment into a uniform-thickness shell, using the original segment
// boundary as the inside / medial / outside surface of that shell. Built on
// the same BFS distance-transform primitive (_morphDistanceMask) that powers
// erode/dilate/margin above, so it inherits the same O(volume) performance
// regardless of shell thickness.
// ============================================================================

export type HollowSurface = "inside" | "medial" | "outside";

function _hollowShellMask(
  orig: Uint8Array, w: number, h: number, d: number,
  offsets: number[][], surface: HollowSurface, thicknessIter: number
): Uint8Array {
  const out = new Uint8Array(orig.length);
  if (surface === "inside") {
    // Original segment is the OUTSIDE of the shell: shell = original minus (original eroded by thickness).
    const eroded = _morphDistanceMask(orig, w, h, d, offsets, thicknessIter, "erode");
    for (let li = 0; li < orig.length; li++) out[li] = orig[li] && !eroded[li] ? 1 : 0;
    return out;
  }
  if (surface === "outside") {
    // Original segment is the INSIDE of the shell: shell = (original dilated by thickness) minus original.
    const dilated = _morphDistanceMask(orig, w, h, d, offsets, thicknessIter, "dilate");
    for (let li = 0; li < orig.length; li++) out[li] = dilated[li] && !orig[li] ? 1 : 0;
    return out;
  }
  // "medial": original boundary runs through the middle of the shell — split
  // the thickness evenly, growing half outward and half inward from it.
  const half = Math.max(1, Math.round(thicknessIter / 2));
  const eroded = _morphDistanceMask(orig, w, h, d, offsets, half, "erode");
  const dilated = _morphDistanceMask(orig, w, h, d, offsets, half, "dilate");
  for (let li = 0; li < orig.length; li++) out[li] = dilated[li] && !eroded[li] ? 1 : 0;
  return out;
}

export function applyHollow(
  surface: HollowSurface,
  thicknessMm: number,
  connectivity: 6 | 26 = 6,
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vmGlobal = segVolume?.voxelManager as any;
  if (!segVolume || !vmGlobal) return null;
  const activeSegment = _activeEditSegment;

  const spacing = segVolume.spacing as number[];
  const avgSpacing = (spacing[0] + spacing[1] + spacing[2]) / 3;
  const rawIterations = thicknessMm / avgSpacing;
  const iterations = Number.isFinite(rawIterations) ? Math.min(2000, Math.max(1, Math.round(rawIterations))) : 1;

  const margin = iterations + 1;
  const bbox = _segBBox(vmGlobal, activeSegment, margin);
  if (!bbox) return null;
  const { i0, i1, j0, j1, k0, k1 } = bbox;
  const w = i1 - i0 + 1, h = j1 - j0 + 1, d = k1 - k0 + 1;
  const idxLocal = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;

  const offsets = connectivity === 6 ? _OFFSETS6 : _OFFSETS26;

  const orig = new Uint8Array(w * h * d);
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
    if (vmGlobal.getAtIJK(i, j, k) === activeSegment) orig[idxLocal(i, j, k)] = 1;

  // Split by CONNECTED COMPONENT, not by the whole segment's bbox — see
  // _splitThinComponents. Hollow is a shell-of-a-3D-volume operation:
  // "inside"/"outside" turn a solid into a thin shell by eroding/dilating
  // through the object's own thickness, which doesn't mean anything for a
  // blob that's only one voxel thick on some axis. Thin components are left
  // exactly as they are (no shell carved out of them); thick components are
  // hollowed as normal, even when they share a class with a thin blob
  // elsewhere in the volume.
  const { thick, thin } = _splitThinComponents(orig, w, h, d);
  const shell = _hollowShellMask(thick, w, h, d, offsets, surface, iterations);
  for (let li = 0; li < shell.length; li++) if (thin[li]) shell[li] = 1;

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const li = idxLocal(i, j, k);
    if (!maskFilter(i, j, k)) continue; // <-- global masking gate
    const wantFg = shell[li] === 1;
    const existing = vmGlobal.getAtIJK(i, j, k);
    if (wantFg && existing !== activeSegment) {
      if (existing !== 0) continue;
      changes.push({ i, j, k, prev: existing, next: activeSegment });
    } else if (!wantFg && existing === activeSegment) {
      changes.push({ i, j, k, prev: existing, next: 0 });
    }
  }
  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vmGlobal.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vmGlobal.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vmGlobal.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}

// Actual physical shell thickness given the current pixel spacing — same
// mm→voxel rounding as getActualMarginMm, reused here for the Hollow panel's
// "Actual: 2.5 x 2.5 x 2.4mm (4x4x3 pixel)" readout.
export function getActualHollowMm(thicknessMm: number): { mm: [number, number, number]; voxels: [number, number, number] } | null {
  return getActualMarginMm(thicknessMm);
}

// ============================================================================
// SECTION: Islands — mirrors Slicer's Islands effect exactly: Keep largest
// island / Remove small islands / Split islands to segments / Keep selected
// island / Remove selected island. Built on the same connected-component
// labeling as _isolateComponentAt/_activeSegmentComponents.
// ============================================================================

export type IslandsOperation = "keepLargest" | "removeSmall" | "splitToSegments" | "keepSelected" | "removeSelected";

export function applyIslandsOperation(
  operation: IslandsOperation,
  minimumSizeVoxels = 1000,
  seedVoxel?: [number, number, number],
  maskFilter: MaskFilter = () => true
): { changedVoxels: number; newSegmentsCreated?: number; createdSegments?: { id: number; label: string; color: Color }[] } | null {
  const comp = _activeSegmentComponents(26);
  if (!comp) return null;
  const { vm, bbox, w, h, labels, sizes } = comp;
  const { i0, j0, k0 } = bbox;
  const activeSegment = _activeEditSegment;

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  const idxLocal3 = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;

  const largestLabel = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  let selectedLabel = -1;
  if (seedVoxel && (operation === "keepSelected" || operation === "removeSelected")) {
    const [si, sj, sk] = seedVoxel;
    const li = si - i0, lj = sj - j0, lk = sk - k0;
    if (li >= 0 && lj >= 0 && lk >= 0 && li < w && lj < h) {
      selectedLabel = labels[li + lj * w + lk * w * h];
    }
  }

  let newSegmentsCreated = 0;
  const createdSegments: { id: number; label: string; color: Color }[] = [];
  const newLabelForComponent = new Map<number, number>();

  const walkAndDecide = (i: number, j: number, k: number, existing: number) => {
    const label = labels[idxLocal3(i, j, k)];
    if (label === undefined || label === -1) return;
    const size = sizes[label];

    switch (operation) {
      case "keepLargest":
        if (label !== largestLabel) changes.push({ i, j, k, prev: existing, next: 0 });
        break;
      case "removeSmall":
        if (size < minimumSizeVoxels) changes.push({ i, j, k, prev: existing, next: 0 });
        break;
      case "keepSelected":
        if (selectedLabel !== -1 && label !== selectedLabel) changes.push({ i, j, k, prev: existing, next: 0 });
        break;
      case "removeSelected":
        if (selectedLabel !== -1 && label === selectedLabel) changes.push({ i, j, k, prev: existing, next: 0 });
        break;
      case "splitToSegments": {
        // The largest island IS the original class — it keeps living under
        // `activeSegment` (no voxel change needed for it), exactly like
        // splitting a custom-made class does. Only the smaller islands are
        // peeled off into fresh Class_N segments; without this check every
        // component (largest included) got reassigned to a new id and the
        // original class vanished entirely instead of just shedding its
        // extra islands.
        if (label === largestLabel) break;
        if (!newLabelForComponent.has(label)) {
          const nextIdx = _getNextAvailableSegmentIndex() + newLabelForComponent.size;
          newLabelForComponent.set(label, nextIdx);
        }
        const target = newLabelForComponent.get(label)!;
        changes.push({ i, j, k, prev: existing, next: target });
        break;
      }
    }
  };

  for (let k = bbox.k0; k <= bbox.k1; k++)
    for (let j = bbox.j0; j <= bbox.j1; j++)
      for (let i = bbox.i0; i <= bbox.i1; i++) {
        if (!maskFilter(i, j, k)) continue;
        const existing = vm.getAtIJK(i, j, k);
        if (existing !== activeSegment) continue;
        walkAndDecide(i, j, k, existing);
      } // <-- was missing

  if (operation === "splitToSegments") {
    newSegmentsCreated = newLabelForComponent.size;
    for (const newIdx of newLabelForComponent.values()) {
      const color = colorForNewClass(newIdx);
      const label = `Class_${newIdx}`;
      registerNewSegmentColor(newIdx, color);
      _customSegmentLabels[newIdx] = label;
      createdSegments.push({ id: newIdx, label, color });
    }
  }

  if (!changes.length) return { changedVoxels: 0, newSegmentsCreated: 0, createdSegments };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length, newSegmentsCreated, createdSegments };
}
// ============================================================================
// SECTION: Morphology (Erode / Dilate)
// ============================================================================

function _segBBox(vm: any, segmentIndex: number, margin: number) {
  const [dimX, dimY, dimZ] = vm.dimensions;
  let data: ArrayLike<number> | undefined;
  try { data = vm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!data || !data.length) return null;
  const sliceSize = dimX * dimY;
  let i0 = dimX, i1 = -1, j0 = dimY, j1 = -1, k0 = dimZ, k1 = -1;
  for (let idx = 0; idx < data.length; idx++) {
    if (data[idx] !== segmentIndex) continue;
    const k = (idx / sliceSize) | 0;
    const rem = idx - k * sliceSize;
    const j = (rem / dimX) | 0;
    const i = rem - j * dimX;
    if (i < i0) i0 = i; if (i > i1) i1 = i;
    if (j < j0) j0 = j; if (j > j1) j1 = j;
    if (k < k0) k0 = k; if (k > k1) k1 = k;
  }
  if (i1 < 0) return null; // segment is empty
  return {
    i0: Math.max(0, i0 - margin), i1: Math.min(dimX - 1, i1 + margin),
    j0: Math.max(0, j0 - margin), j1: Math.min(dimY - 1, j1 + margin),
    k0: Math.max(0, k0 - margin), k1: Math.min(dimZ - 1, k1 + margin),
  };
}

// Splits a local (already-cropped-to-bbox) binary mask into "thick" and
// "thin" halves by CONNECTED COMPONENT, not by the mask's overall bbox.
// This is the fix for margin/smoothing/hollow deleting a one-slice
// annotation that lives inside an otherwise-3D segment class: the old guards
// measured the extent of the whole segment (every voxel sharing that
// class/index anywhere in the volume), so a single-slice blob only got
// protected when it happened to be the ONLY thing with that class index.
// Any other paint elsewhere under the same class — even unrelated to what's
// visible on screen — made the whole-segment extent >1 and silently
// disabled the guard. Per-component extent is what "3D structure" actually
// means: each connected blob is checked on its own, so a thin island is
// protected even when it shares a class with a genuinely 3D blob elsewhere,
// and a genuinely 3D blob is still fully eroded/smoothed/hollowed as normal.
function _splitThinComponents(mask: Uint8Array, w: number, h: number, d: number): { thick: Uint8Array; thin: Uint8Array; hasThin: boolean } {
  const n = w * h * d;
  const labels = new Int32Array(n).fill(-1);
  const thick = new Uint8Array(n);
  const thin = new Uint8Array(n);
  let hasThin = false;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    labels[start] = start;
    const stack = [start];
    const comp: number[] = [start];
    let i0 = w, i1 = -1, j0 = h, j1 = -1, k0 = d, k1 = -1;
    while (stack.length) {
      const lin = stack.pop()!;
      const k = Math.floor(lin / (w * h));
      const rem = lin - k * w * h;
      const j = Math.floor(rem / w);
      const i = rem - j * w;
      if (i < i0) i0 = i; if (i > i1) i1 = i;
      if (j < j0) j0 = j; if (j > j1) j1 = j;
      if (k < k0) k0 = k; if (k > k1) k1 = k;
      for (const [di, dj, dk] of _OFFSETS6) {
        const ni = i + di, nj = j + dj, nk = k + dk;
        if (ni < 0 || ni >= w || nj < 0 || nj >= h || nk < 0 || nk >= d) continue;
        const nli = ni + nj * w + nk * w * h;
        if (mask[nli] && labels[nli] === -1) { labels[nli] = start; stack.push(nli); comp.push(nli); }
      }
    }
    const extX = i1 - i0 + 1, extY = j1 - j0 + 1, extZ = k1 - k0 + 1;
    const isThin = extX === 1 || extY === 1 || extZ === 1;
    if (isThin) hasThin = true;
    const dest = isThin ? thin : thick;
    for (const li of comp) dest[li] = 1;
  }
  return { thick, thin, hasThin };
}

function _tightExtentAxis(i0:number,i1:number,j0:number,j1:number,k0:number,k1:number): number | null {
  const extI = i1 - i0 + 1, extJ = j1 - j0 + 1, extK = k1 - k0 + 1;
  const min = Math.min(extI, extJ, extK);
  if (min > 2) return null;
  if (extI === min) return 0;
  if (extJ === min) return 1;
  return 2;
}

function _filterOffsetsAxis(offsets: number[][], axis: number | null): number[][] {
  if (axis === null) return offsets;
  return offsets.filter((o) => o[axis] === 0);
}
const _OFFSETS6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const _OFFSETS26: number[][] = (() => {
  const out: number[][] = [];
  for (let di=-1; di<=1; di++) for (let dj=-1; dj<=1; dj++) for (let dk=-1; dk<=1; dk++)
    if (di || dj || dk) out.push([di, dj, dk]);
  return out;
})();

// Applying `_morphPass` `iterations` times is O(iterations * volume) — fine
// for the small radii used by e.g. post-fill closing, but at margin-tool
// scale (a 100mm grow/shrink can mean iterations in the hundreds) it turns
// into hundreds of full-volume scans and locks up the tab.
//
// A multi-source BFS computes the exact same result — because each
// iteration of `_morphPass` is just "expand one graph layer" using the same
// neighbor offsets — in a single O(volume) pass regardless of how large
// `iterations` is, since each voxel is only ever visited once.
//
// For "erode", a foreground voxel touching the array boundary is removed
// after 1 iteration in the original algorithm (an out-of-bounds neighbor
// counts as background). We reproduce that by padding the working volume
// with one voxel of background on every side before running BFS, so the
// boundary behaves exactly like real background instead of needing a
// special case in the traversal.
function _morphDistanceMask(seed: Uint8Array, w: number, h: number, d: number, offsets: number[][], iterations: number, mode: "dilate" | "erode"): Uint8Array {
  if (iterations <= 0) return seed.slice();

  const runBfs = (bg: Uint8Array, bw: number, bh: number, bd: number): Int32Array => {
    const n = bw * bh * bd;
    const dist = new Int32Array(n).fill(-1);
    let frontier: number[] = [];
    for (let li = 0; li < n; li++) if (bg[li]) { dist[li] = 0; frontier.push(li); }
    let level = 0;
    while (frontier.length && level < iterations) {
      const next: number[] = [];
      for (const li of frontier) {
        const k = (li / (bw * bh)) | 0;
        const rem = li - k * bw * bh;
        const j = (rem / bw) | 0;
        const i = rem - j * bw;
        for (const [di, dj, dk] of offsets) {
          const ni = i + di, nj = j + dj, nk = k + dk;
          if (ni < 0 || ni >= bw || nj < 0 || nj >= bh || nk < 0 || nk >= bd) continue;
          const nli = ni + nj * bw + nk * bw * bh;
          if (dist[nli] === -1) { dist[nli] = level + 1; next.push(nli); }
        }
      }
      frontier = next;
      level++;
    }
    return dist;
  };

  const out = new Uint8Array(seed.length);
  if (mode === "dilate") {
    // Distance from any seeded foreground voxel; survives if within `iterations` steps.
    const dist = runBfs(seed, w, h, d);
    for (let li = 0; li < seed.length; li++) out[li] = dist[li] !== -1 ? 1 : 0;
    return out;
  }

  // erode: pad with a 1-voxel background shell so out-of-bounds = background,
  // matching _morphPass's boundary behavior exactly.
  const pw = w + 2, ph = h + 2, pd = d + 2;
  const bg = new Uint8Array(pw * ph * pd); // 1 = background seed
  for (let k = 0; k < d; k++) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const li = i + j * w + k * w * h;
    if (!seed[li]) {
      const pli = (i + 1) + (j + 1) * pw + (k + 1) * pw * ph;
      bg[pli] = 1;
    }
  }
  // Padded shell itself is background.
  for (let k = 0; k < pd; k++) for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
    if (i === 0 || i === pw - 1 || j === 0 || j === ph - 1 || k === 0 || k === pd - 1) {
      bg[i + j * pw + k * pw * ph] = 1;
    }
  }
  const dist = runBfs(bg, pw, ph, pd);
  for (let k = 0; k < d; k++) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const li = i + j * w + k * w * h;
    if (!seed[li]) { out[li] = 0; continue; }
    const pli = (i + 1) + (j + 1) * pw + (k + 1) * pw * ph;
    const dv = dist[pli];
    out[li] = (dv === -1 || dv > iterations) ? 1 : 0;
  }
  return out;
}

function _applyMorphSequence(
  passes: Array<"dilate" | "erode">,
  iterationsEach: number,
  connectivity: 6 | 26,
  seedVoxel?: [number, number, number],
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vmGlobal = segVolume?.voxelManager as any;
  if (!segVolume || !vmGlobal) return null;
  const activeSegment = _activeEditSegment;
  const margin = iterationsEach * passes.length + 1;

  let vm: any, i0: number, i1: number, j0: number, j1: number, k0: number, k1: number, w: number, h: number, d: number;
  let otherMask: Uint8Array | null = null;
  let thinAxis: number | null;
  let seedSelfMask: Uint8Array | null = null;

  if (seedVoxel) {
    // Connected-component labeling of the whole active segment is expensive
    // (full-volume flood fill) — compute it once and reuse it for both the
    // tight-extent check and the padded isolate call, instead of redoing it
    // three separate times (the "island" scope used to pay for this 3x).
    const comp = _activeSegmentComponents(connectivity);
    if (!comp) return null;
    const tight = _isolateComponentAt(seedVoxel, connectivity, 0, comp);
    thinAxis = tight ? _tightExtentAxis(tight.i0, tight.i1, tight.j0, tight.j1, tight.k0, tight.k1) : null;
    const iso = _isolateComponentAt(seedVoxel, connectivity, margin, comp);
    if (!iso) return null;
    ({ vm, i0, i1, j0, j1, k0, k1, w, h, d, otherMask } = iso);
    seedSelfMask = iso.selfMask;
  } else {
    const tight = _segBBox(vmGlobal, activeSegment, 0);
    thinAxis = tight ? _tightExtentAxis(tight.i0, tight.i1, tight.j0, tight.j1, tight.k0, tight.k1) : null;
    const bbox = _segBBox(vmGlobal, activeSegment, margin);
    if (!bbox) return null;
    vm = vmGlobal;
    ({ i0, i1, j0, j1, k0, k1 } = bbox);
    w = i1 - i0 + 1; h = j1 - j0 + 1; d = k1 - k0 + 1;
  }

  const offsets = _filterOffsetsAxis(connectivity === 6 ? _OFFSETS6 : _OFFSETS26, thinAxis);
  const idxLocal = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;

  let cur = new Uint8Array(w * h * d);
  if (seedVoxel) {
    cur.set(seedSelfMask!);
  } else {
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
      if (vm.getAtIJK(i, j, k) === activeSegment) cur[idxLocal(i, j, k)] = 1;
  }

  // BFS-based distance transform: exactly equivalent to running _morphPass
  // `iterationsEach` times (each BFS layer == one pass), but O(volume) total
  // instead of O(iterations * volume). This is what keeps large mm margins
  // (which can translate to hundreds of iterations) from freezing the tab.
  for (const mode of passes) {
    cur = _morphDistanceMask(cur, w, h, d, offsets, iterationsEach, mode);
  }

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const li = idxLocal(i, j, k);
    if (otherMask && otherMask[li]) continue;
    if (!maskFilter(i, j, k)) continue; // <-- global masking gate
    const wantFg = cur[li] === 1;
    const existing = vm.getAtIJK(i, j, k);
    if (wantFg && existing !== activeSegment) {
      if (existing !== 0) continue;
      changes.push({ i, j, k, prev: existing, next: activeSegment });
    } else if (!wantFg && existing === activeSegment) {
      changes.push({ i, j, k, prev: existing, next: 0 });
    }
  }
  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}

export function erodeActiveSegment(iterations = 1, connectivity: 6 | 26 = 6, seedVoxel?: [number, number, number], maskFilter: MaskFilter = () => true) {
  return _applyMorphSequence(["erode"], iterations, connectivity, seedVoxel, maskFilter);
}
export function dilateActiveSegment(iterations = 1, connectivity: 6 | 26 = 6, seedVoxel?: [number, number, number], maskFilter: MaskFilter = () => true) {
  return _applyMorphSequence(["dilate"], iterations, connectivity, seedVoxel, maskFilter);
}



function _activeSegmentComponents(connectivity: 6 | 26): { vm: any; bbox: NonNullable<ReturnType<typeof _segBBox>>; w: number; h: number; d: number; labels: Int32Array; sizes: number[] } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const activeSegment = _activeEditSegment;
  const bbox = _segBBox(vm, activeSegment, 1);
  if (!bbox) return null;
  const { i0, i1, j0, j1, k0, k1 } = bbox;
  const w = i1 - i0 + 1, h = j1 - j0 + 1, d = k1 - k0 + 1;
  const idxLocal = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;
  const isFg = new Uint8Array(w * h * d);
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (vm.getAtIJK(i, j, k) === activeSegment) isFg[idxLocal(i, j, k)] = 1;
  }
  const offsets = connectivity === 6 ? _OFFSETS6 : _OFFSETS26;
  const labels = new Int32Array(w * h * d).fill(-1);
  const sizes: number[] = [];
  let nextLabel = 0;
  for (let start = 0; start < isFg.length; start++) {
    if (!isFg[start] || labels[start] !== -1) continue;
    const label = nextLabel++;
    let size = 0;
    const stack = [start];
    labels[start] = label;
    while (stack.length) {
      const lin = stack.pop()!;
      size++;
      const k = Math.floor(lin / (w * h));
      const rem = lin - k * w * h;
      const j = Math.floor(rem / w);
      const i = rem - j * w;
      for (const [di, dj, dk] of offsets) {
        const ni = i + di, nj = j + dj, nk = k + dk;
        if (ni < 0 || ni >= w || nj < 0 || nj >= h || nk < 0 || nk >= d) continue;
        const nli = ni + nj * w + nk * w * h;
        if (isFg[nli] && labels[nli] === -1) { labels[nli] = label; stack.push(nli); }
      }
    }
    sizes.push(size);
  }
  return { vm, bbox, w, h, d, labels, sizes };
}
function _isolateComponentAt(
  seed: [number, number, number],
  connectivity: 6 | 26,
  marginVoxels: number,
  precomputedComp?: ReturnType<typeof _activeSegmentComponents>
): {
  vm: any;
  i0: number; i1: number; j0: number; j1: number; k0: number; k1: number;
  w: number; h: number; d: number;
  selfMask: Uint8Array;
  otherMask: Uint8Array;
} | null {
  // Connected-component labeling of the whole active segment is expensive
  // (full-volume flood fill) — reuse a caller-supplied result instead of
  // recomputing it every time this is called.
  const comp = precomputedComp ?? _activeSegmentComponents(connectivity);
  if (!comp) return null;
  const { vm, bbox, w: compW, h: compH, labels } = comp;
  const { i0: cbi0, j0: cbj0, k0: cbk0 } = bbox;
  const [si, sj, sk] = seed;
  const li = si - cbi0, lj = sj - cbj0, lk = sk - cbk0;
  if (li < 0 || lj < 0 || lk < 0 || li >= compW || lj >= compH) return null;
  const targetLabel = labels[li + lj * compW + lk * compW * compH];
  if (targetLabel === undefined || targetLabel === -1) return null; // clicked voxel isn't this segment

  // Tight bbox around just the clicked component (not the whole segment).
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, k0 = Infinity, k1 = -Infinity;
  for (let idx = 0; idx < labels.length; idx++) {
    if (labels[idx] !== targetLabel) continue;
    const k = Math.floor(idx / (compW * compH));
    const rem = idx - k * compW * compH;
    const j = Math.floor(rem / compW);
    const i = rem - j * compW;
    const gi = i + cbi0, gj = j + cbj0, gk = k + cbk0;
    if (gi < i0) i0 = gi; if (gi > i1) i1 = gi;
    if (gj < j0) j0 = gj; if (gj > j1) j1 = gj;
    if (gk < k0) k0 = gk; if (gk > k1) k1 = gk;
  }
  if (i1 < i0) return null;

  const [dimX, dimY, dimZ] = vm.dimensions;
  i0 = Math.max(0, i0 - marginVoxels); j0 = Math.max(0, j0 - marginVoxels); k0 = Math.max(0, k0 - marginVoxels);
  i1 = Math.min(dimX - 1, i1 + marginVoxels); j1 = Math.min(dimY - 1, j1 + marginVoxels); k1 = Math.min(dimZ - 1, k1 + marginVoxels);
  const w = i1 - i0 + 1, h = j1 - j0 + 1, d = k1 - k0 + 1;
  const idxLocal = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;
  const selfMask = new Uint8Array(w * h * d);
  const otherMask = new Uint8Array(w * h * d);
  const activeSegment = _activeEditSegment;

  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (vm.getAtIJK(i, j, k) !== activeSegment) continue;
    const ci = i - cbi0, cj = j - cbj0, ck = k - cbk0;
    const inCompBox = ci >= 0 && cj >= 0 && ck >= 0 && ci < compW && cj < compH;
    const lbl = inCompBox ? labels[ci + cj * compW + ck * compW * compH] : -2;
    if (lbl === targetLabel) selfMask[idxLocal(i, j, k)] = 1;
    else otherMask[idxLocal(i, j, k)] = 1;
  }
  return { vm, i0, i1, j0, j1, k0, k1, w, h, d, selfMask, otherMask };
}


// ============================================================================
// SECTION: Slice Copy & Shape Interpolation (SDT)
// ============================================================================

// ---------------------------------------------------------------------------
// Copy/paste a segment's 2D footprint from the current slice to another
// slice along the same pane's through-plane axis
// ---------------------------------------------------------------------------

export function copySegmentToAdjacentSlice(
  pane: CinePane,
  sliceOffset = 1,
  activeSegment = _activeEditSegment
): { changedVoxels: number } | null {
  const viewport = _getMprViewport(pane);
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!viewport || !segVolume || !vm) return null;

  const [dimX, dimY, dimZ] = vm.dimensions;
  const dims = [dimX, dimY, dimZ];
  const axis = _sliceAxisForPane(pane);
  const srcIndex = viewport.getSliceIndex();
  const dstIndex = srcIndex + sliceOffset;
  if (dstIndex < 0 || dstIndex >= dims[axis]) {
    console.warn("Copy to adjacent slice: destination is out of range.");
    return null;
  }

  const changes: Array<{ i: number; j: number; k: number; prev: number }> = [];
  const setIJK = (a: number, b: number, atSrc: boolean): [number, number, number] => {
    // Map a 2D (a,b) footprint coordinate back to IJK at either the source or
    // destination slice, depending on which axis is the through-plane one.
    if (axis === 2) return [a, b, atSrc ? srcIndex : dstIndex]; // axial: slices along k
    if (axis === 0) return [atSrc ? srcIndex : dstIndex, a, b]; // sagittal: slices along i
    return [a, atSrc ? srcIndex : dstIndex, b]; // coronal: slices along j
  };

  // Iterate the two in-plane axes only
  const [dimA, dimB] =
    axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];

  for (let b = 0; b < dimB; b++) {
    for (let a = 0; a < dimA; a++) {
      const [si, sj, sk] = setIJK(a, b, true);
      if (vm.getAtIJK(si, sj, sk) !== activeSegment) continue;
      const [di, dj, dk] = setIJK(a, b, false);
      const existing = vm.getAtIJK(di, dj, dk);
      if (existing !== 0 && existing !== activeSegment) continue; // don't steal another organ's voxel
      if (existing === activeSegment) continue; // already set
      changes.push({ i: di, j: dj, k: dk, prev: existing });
    }
  }
  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, activeSegment);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, activeSegment); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}

// ---------------------------------------------------------------------------
// Shape-based (SDT) interpolation between two annotated slices of the same
// segment, along one pane's axis. For each slice in between: interpolate the
// two slices' signed distance transforms and threshold at 0. Much better
// than nearest-neighbor copy for slices that differ noticeably in shape.
// ---------------------------------------------------------------------------

// 2D chamfer-style approximate Euclidean SDT (two-pass, sub-pixel accurate
// enough for interpolation purposes
function _signedDistanceTransform2D(mask: Uint8Array, w: number, h: number, clampDist = 40): Float32Array {
  const INF = 1e6;
  const dist = new Float32Array(w * h);
  const idx = (x: number, y: number) => x + y * w;

  const chamfer = (fg: Uint8Array): Float32Array => {
    const d = new Float32Array(w * h).fill(INF);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!fg[idx(x, y)]) d[idx(x, y)] = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (x > 0) d[i] = Math.min(d[i], d[idx(x - 1, y)] + 1);
      if (y > 0) d[i] = Math.min(d[i], d[idx(x, y - 1)] + 1);
      if (x > 0 && y > 0) d[i] = Math.min(d[i], d[idx(x - 1, y - 1)] + 1.4142);
      if (x < w - 1 && y > 0) d[i] = Math.min(d[i], d[idx(x + 1, y - 1)] + 1.4142);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = idx(x, y);
      if (x < w - 1) d[i] = Math.min(d[i], d[idx(x + 1, y)] + 1);
      if (y < h - 1) d[i] = Math.min(d[i], d[idx(x, y + 1)] + 1);
      if (x < w - 1 && y < h - 1) d[i] = Math.min(d[i], d[idx(x + 1, y + 1)] + 1.4142);
      if (x > 0 && y < h - 1) d[i] = Math.min(d[i], d[idx(x - 1, y + 1)] + 1.4142);
    }
    return d;
  };

  const distOutside = chamfer(mask);
  const inverted = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inverted[i] = mask[i] ? 0 : 1;
  const distInside = chamfer(inverted);

  // Clamp both fields to a narrow band. Without this, a background pixel far from
  // the shape on ONE slice gets an unbounded negative value that swamps a modest
  // positive "depth inside" value from the OTHER slice when blended — collapsing
  // the interpolated interior down to just the overlapping boundary ring instead
  // of a solid fill.
  for (let i = 0; i < w * h; i++) {
    dist[i] = mask[i] ? Math.min(distOutside[i], clampDist) : -Math.min(distInside[i], clampDist);
  }
  return dist;
}

// Converts a VIEWPORT slice number (what the user sees / types — i.e. what
// `viewport.getSliceIndex()` and `sliceInfo.total` are based on) into the real
// volume-space IJK index along that pane's through-plane axis. These are only
// guaranteed to be the same number when the volume's direction matrix is
// identity — see the comment on getVolumeSliceIndexForPane above. For any
// other orientation (common for real NIfTI data) they can differ by an offset
// and/or be reversed, which is why "slice 93" typed by the user was landing on
// the wrong IJK slice and never finding the segment the user actually drew.
// We navigate the pane to the requested viewport slice, read back the true
// IJK index via the existing camera/world→index helper, then restore the
// viewport's original position so this is invisible to the user.
function _viewportSliceToVolumeIJK(pane: CinePane, viewportSliceIndex: number): number | null {
  const viewport = _getMprViewport(pane);
  if (!viewport) return null;
  const original = viewport.getSliceIndex();
  const delta = viewportSliceIndex - original;
  if (delta !== 0) viewport.scroll(delta);
  const ijk = getVolumeSliceIndexForPane(pane);
  const after = viewport.getSliceIndex();
  const restoreDelta = original - after;
  if (restoreDelta !== 0) viewport.scroll(restoreDelta);
  return ijk;
}

function _extractSliceMask(vm: any, pane: CinePane, sliceIndex: number, segmentIndex: number): { mask: Uint8Array; dimA: number; dimB: number } {
  const [dimX, dimY, dimZ] = vm.dimensions;
  const axis = _sliceAxisForPane(pane);
  const [dimA, dimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const mask = new Uint8Array(dimA * dimB);
  const at = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, sliceIndex] : axis === 0 ? [sliceIndex, a, b] : [a, sliceIndex, b];
  for (let b = 0; b < dimB; b++) for (let a = 0; a < dimA; a++) {
    const [i, j, k] = at(a, b);
    if (vm.getAtIJK(i, j, k) === segmentIndex) mask[a + b * dimA] = 1;
  }
  return { mask, dimA, dimB };
}

// Flood-fills from the border of a dimA x dimB slice grid and returns which
// background cells were unreachable - i.e., truly enclosed holes, not the
// exterior. Used to patch the annulus artifact that SDT blending can produce
// between two anchor slices whose shapes have shifted position.
function _fillEnclosedHoles(mask: Uint8Array, dimA: number, dimB: number): Uint8Array {
  const reached = new Uint8Array(dimA * dimB);
  const stack: number[] = [];
  const idx = (a: number, b: number) => a + b * dimA;
  const pushIfBg = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= dimA || b >= dimB) return;
    const li = idx(a, b);
    if (!mask[li] && !reached[li]) { reached[li] = 1; stack.push(li); }
  };
  for (let a = 0; a < dimA; a++) { pushIfBg(a, 0); pushIfBg(a, dimB - 1); }
  for (let b = 0; b < dimB; b++) { pushIfBg(0, b); pushIfBg(dimA - 1, b); }
  while (stack.length) {
    const li = stack.pop()!;
    const a = li % dimA, b = Math.floor(li / dimA);
    pushIfBg(a + 1, b); pushIfBg(a - 1, b); pushIfBg(a, b + 1); pushIfBg(a, b - 1);
  }
  const out = new Uint8Array(dimA * dimB);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !reached[i] ? 1 : 0;
  return out;
}

export function interpolateSegmentBetweenSlices(
  pane: CinePane,
  sliceA: number,
  sliceB: number,
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true

): { changedVoxels: number; slicesWritten: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) {
    console.warn("Interpolate: no segmentation loaded.");
    return null;
  }
  if (sliceA === sliceB) {
    console.warn("Interpolate: pick two different slices.");
    return null;
  }
  // sliceA/sliceB arrive as viewport slice numbers — resolve them to real IJK
  // indices before doing any mask work (see _viewportSliceToVolumeIJK).
  const ijkA = _viewportSliceToVolumeIJK(pane, sliceA);
  const ijkB = _viewportSliceToVolumeIJK(pane, sliceB);
  if (ijkA == null || ijkB == null) {
    console.warn("Interpolate: could not resolve the requested slices on this pane.");
    return null;
  }
  const lo = Math.min(ijkA, ijkB);
  const hi = Math.max(ijkA, ijkB);
  if (hi - lo < 2) {
    console.warn("Interpolate: slices are adjacent, nothing in between to fill.");
    return { changedVoxels: 0, slicesWritten: 0 };
  }

  const { mask: maskA, dimA, dimB } = _extractSliceMask(vm, pane, lo, segmentIndex);
  const { mask: maskB } = _extractSliceMask(vm, pane, hi, segmentIndex);
  const countA = maskA.reduce((s, v) => s + v, 0);
  const countB = maskB.reduce((s, v) => s + v, 0);
  if (!countA || !countB) {
    console.warn(
      `Interpolate: segment ${segmentIndex} not found on slice ${!countA ? lo + 1 : hi + 1} of pane "${pane}". ` +
      "Draw it fully on BOTH marked slices with the SAME organ selected before interpolating."
    );
    return null;
  }

  const sdtA = _signedDistanceTransform2D(maskA, dimA, dimB);
  const sdtB = _signedDistanceTransform2D(maskB, dimA, dimB);
  const axis = _sliceAxisForPane(pane);
  const at = (a: number, b: number, slice: number): [number, number, number] =>
    axis === 2 ? [a, b, slice] : axis === 0 ? [slice, a, b] : [a, slice, b];

  const changes: Array<{ i: number; j: number; k: number; prev: number }> = [];
  const totalSteps = hi - lo;
  for (let slice = lo + 1; slice < hi; slice++) {
    const t = (slice - lo) / totalSteps;
    const sliceMask = new Uint8Array(dimA * dimB);
    for (let b = 0; b < dimB; b++) {
      for (let a = 0; a < dimA; a++) {
        const li = a + b * dimA;
        if (sdtA[li] * (1 - t) + sdtB[li] * t >= 0) sliceMask[li] = 1;
      }
    }
    const healed = _fillEnclosedHoles(sliceMask, dimA, dimB);
    for (let b = 0; b < dimB; b++) {
      for (let a = 0; a < dimA; a++) {
        const li = a + b * dimA;
        if (!healed[li]) continue;
        const [i, j, k] = at(a, b, slice);
        if (!maskFilter(i, j, k)) continue; // <-- gate
        const existing = vm.getAtIJK(i, j, k);
        if (existing === segmentIndex) continue; // already this class — nothing to change
        changes.push({ i, j, k, prev: existing }); // overwrite anything else, same as brush/smart-fill
      }
    }
  }

  if (!changes.length) {
    console.warn("Interpolate: computed shapes but every target voxel was already occupied by another segment.");
    return { changedVoxels: 0, slicesWritten: 0 };
  }
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length, slicesWritten: hi - lo - 1 };
}

export function copySegmentAcrossSlices(
  pane: CinePane,
  fromSlice: number,
  toSlice: number,
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true
): { changedVoxels: number; slicesWritten: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) {
    console.warn("Copy across slices: no segmentation loaded.");
    return null;
  }
  if (fromSlice === toSlice) {
    console.warn("Copy across slices: pick two different slices.");
    return { changedVoxels: 0, slicesWritten: 0 };
  }
  // fromSlice/toSlice arrive as viewport slice numbers — resolve them to real
  // IJK indices before doing any mask work (see _viewportSliceToVolumeIJK).
  const ijkFrom = _viewportSliceToVolumeIJK(pane, fromSlice);
  const ijkTo = _viewportSliceToVolumeIJK(pane, toSlice);
  if (ijkFrom == null || ijkTo == null) {
    console.warn("Copy across slices: could not resolve the requested slices on this pane.");
    return null;
  }
  const lo = Math.min(ijkFrom, ijkTo);
  const hi = Math.max(ijkFrom, ijkTo);

  const { mask: srcMask, dimA, dimB } = _extractSliceMask(vm, pane, ijkFrom, segmentIndex);
  const count = srcMask.reduce((s, v) => s + v, 0);
  if (!count) {
    console.warn(
      `Copy across slices: segment ${segmentIndex} not found on the source slice (${fromSlice + 1}) of pane "${pane}". ` +
      "Draw it fully there first, with that organ selected in the dropdown."
    );
    return null;
  }

  const axis = _sliceAxisForPane(pane);
  const at = (a: number, b: number, slice: number): [number, number, number] =>
    axis === 2 ? [a, b, slice] : axis === 0 ? [slice, a, b] : [a, slice, b];

  const changes: Array<{ i: number; j: number; k: number; prev: number }> = [];
  for (let slice = lo; slice <= hi; slice++) {
    if (slice === ijkFrom) continue;
    for (let b = 0; b < dimB; b++) {
      for (let a = 0; a < dimA; a++) {
        if (!srcMask[a + b * dimA]) continue;
        const [i, j, k] = at(a, b, slice);
        if (!maskFilter(i, j, k)) continue; // <-- gate
        const existing = vm.getAtIJK(i, j, k);
        if (existing === segmentIndex) continue;
        changes.push({ i, j, k, prev: existing });
      }
    }
  }

  if (!changes.length) {
    console.warn("Copy across slices: nothing written — every target voxel was already occupied.");
    return { changedVoxels: 0, slicesWritten: 0 };
  }
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length, slicesWritten: hi - lo };
}

const _interpEndpoints: Record<CinePane, number | null> = { axial: null, sagittal: null, coronal: null };

export function setInterpolationEndpoint(pane: CinePane, sliceIndex: number) {
  _interpEndpoints[pane] = sliceIndex;
}
export function getInterpolationEndpoint(pane: CinePane): number | null {
  return _interpEndpoints[pane];
}
export function clearInterpolationEndpoints(pane: CinePane) {
  _interpEndpoints[pane] = null;
}
// CornerstoneNifti2.ts — add near lassoCommitPolygon

export type ScissorsOperation = "eraseInside" | "eraseOutside" | "fillInside" | "fillOutside";
export type ScissorsSliceCut = "unlimited" | "positive" | "negative" | "symmetric";

export interface ScissorsCutParams {
  operation: ScissorsOperation;
  sliceCut: ScissorsSliceCut;
  sliceCutDepthMm: number;
  applyToVisibleSegments: boolean;
  visibleSegmentIndices: number[];
}

function _rasterizePolygonInsideMask(
  dimA: number,
  dimB: number,
  polygonAB: Array<[number, number]>
): Uint8Array {
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const [a, b] of polygonAB) {
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }
  const boxA0 = Math.max(0, Math.floor(minA) - 1);
  const boxA1 = Math.min(dimA - 1, Math.ceil(maxA) + 1);
  const boxB0 = Math.max(0, Math.floor(minB) - 1);
  const boxB1 = Math.min(dimB - 1, Math.ceil(maxB) + 1);
  const w = boxA1 - boxA0 + 1;
  const h = boxB1 - boxB0 + 1;
  const full = new Uint8Array(dimA * dimB);
  if (w < 2 || h < 2 || polygonAB.length < 3) return full;

  const idxLocal = (a: number, b: number) => (a - boxA0) + (b - boxB0) * w;
  const boundary = new Uint8Array(w * h);
  const drawLine = (a0: number, b0: number, a1: number, b1: number) => {
    let x0 = Math.round(a0), y0 = Math.round(b0);
    const x1 = Math.round(a1), y1 = Math.round(b1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (x0 >= boxA0 && x0 <= boxA1 && y0 >= boxB0 && y0 <= boxB1) boundary[idxLocal(x0, y0)] = 1;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  for (let i = 0; i < polygonAB.length; i++) {
    const [a0, b0] = polygonAB[i];
    const [a1, b1] = polygonAB[(i + 1) % polygonAB.length];
    drawLine(a0, b0, a1, b1);
  }

  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const li = x + y * w;
    if (boundary[li] || outside[li]) return;
    outside[li] = 1;
    stack.push(li);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (stack.length) {
    const li = stack.pop()!;
    const x = li % w, y = Math.floor(li / w);
    tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const li = x + y * w;
      if (!outside[li]) full[(x + boxA0) + (y + boxB0) * dimA] = 1; // boundary + interior
    }
  }
  return full;
}
export function cutSegmentWithPolygon(
  pane: CinePane,
  canvasPoints: Array<[number, number]>,
  params: ScissorsCutParams,
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const voxelPts = canvasPoints.map((cp) => canvasPointToVoxel(pane, cp));
  if (voxelPts.some((v) => !v) || voxelPts.length < 3) return null;
  const pts = voxelPts as Array<[number, number, number]>;

  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const [dimX, dimY, dimZ] = vm.dimensions;

  const axis = _sliceAxisForPane(pane);
  const throughVals = pts
    .map((p) => (axis === 2 ? p[2] : axis === 0 ? p[0] : p[1]))
    .sort((a, b) => a - b);
  const drawnSlice = throughVals[Math.floor(throughVals.length / 2)];

  const [dimA, dimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const polygonAB: Array<[number, number]> = pts.map((p) =>
    axis === 2 ? [p[0], p[1]] : axis === 0 ? [p[1], p[2]] : [p[0], p[2]]
  );
  const insideMask = _rasterizePolygonInsideMask(dimA, dimB, polygonAB);

  const spacing = segVolume.spacing as number[];
  const axisSpacing = spacing[axis] || 1;
  const dimAxis = axis === 2 ? dimZ : axis === 0 ? dimX : dimY;

  let sliceLo = drawnSlice, sliceHi = drawnSlice;
  if (params.sliceCut !== "unlimited" && params.sliceCutDepthMm > 0) {
    const depthVoxels = Math.max(0, Math.round(params.sliceCutDepthMm / axisSpacing));
    if (params.sliceCut === "symmetric") {
      sliceLo = Math.max(0, drawnSlice - depthVoxels);
      sliceHi = Math.min(dimAxis - 1, drawnSlice + depthVoxels);
    } else if (params.sliceCut === "positive") {
      sliceHi = Math.min(dimAxis - 1, drawnSlice + depthVoxels);
    } else if (params.sliceCut === "negative") {
      sliceLo = Math.max(0, drawnSlice - depthVoxels);
    }
  }

  const targets =
    params.applyToVisibleSegments && params.visibleSegmentIndices.length
      ? params.visibleSegmentIndices
      : [segmentIndex];

  const at = (a: number, b: number, slice: number): [number, number, number] =>
    axis === 2 ? [a, b, slice] : axis === 0 ? [slice, a, b] : [a, slice, b];

  const wantsInside = params.operation === "eraseInside" || params.operation === "fillInside";
  const paints = params.operation === "fillInside" || params.operation === "fillOutside";

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  for (let slice = sliceLo; slice <= sliceHi; slice++) {
    for (let b = 0; b < dimB; b++) {
      for (let a = 0; a < dimA; a++) {
        const isInside = insideMask[a + b * dimA] === 1;
        if (isInside !== wantsInside) continue;
        const [i, j, k] = at(a, b, slice);
        if (!maskFilter(i, j, k)) continue;
        for (const target of targets) {
          const existing = vm.getAtIJK(i, j, k);
          if (paints) {
            if (existing === target) continue;
            changes.push({ i, j, k, prev: existing, next: target });
          } else {
            if (existing !== target) continue;
            changes.push({ i, j, k, prev: existing, next: 0 });
          }
        }
      }
    }
  }

  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}
// ============================================================================
// SECTION: Lasso (Straight-Edge Polygon Fill)
// ============================================================================

// ---------------------------------------------------------------------------
// Rasterizes a closed polygon (in one slice's 2D pixel space) into the active
// segment on that single slice, via scanline-style flood fill from the
// polygon boundary. Shared by lassoCommitPolygon below.
// ---------------------------------------------------------------------------

function _rasterizeClosedPolygon(
  pane: CinePane,
  sliceIndex: number,
  polygonAB: Array<[number, number]>,
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true
): { filledVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm || polygonAB.length < 3) return null;

  const [dimX, dimY, dimZ] = vm.dimensions;
  const axis = _sliceAxisForPane(pane);
  const [dimA, dimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const at = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, sliceIndex] : axis === 0 ? [sliceIndex, a, b] : [a, sliceIndex, b];

  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const [a, b] of polygonAB) {
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }
  const boxA0 = Math.max(0, Math.floor(minA) - 1);
  const boxA1 = Math.min(dimA - 1, Math.ceil(maxA) + 1);
  const boxB0 = Math.max(0, Math.floor(minB) - 1);
  const boxB1 = Math.min(dimB - 1, Math.ceil(maxB) + 1);
  const w = boxA1 - boxA0 + 1;
  const h = boxB1 - boxB0 + 1;
  if (w < 2 || h < 2) return { filledVoxels: 0 };

  const idxLocal = (a: number, b: number) => (a - boxA0) + (b - boxB0) * w;

  const boundary = new Uint8Array(w * h);
  const drawLine = (a0: number, b0: number, a1: number, b1: number) => {
    let x0 = Math.round(a0), y0 = Math.round(b0);
    const x1 = Math.round(a1), y1 = Math.round(b1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (x0 >= boxA0 && x0 <= boxA1 && y0 >= boxB0 && y0 <= boxB1) {
        boundary[idxLocal(x0, y0)] = 1;
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  for (let i = 0; i < polygonAB.length; i++) {
    const [a0, b0] = polygonAB[i];
    const [a1, b1] = polygonAB[(i + 1) % polygonAB.length];
    drawLine(a0, b0, a1, b1);
  }

  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const li = x + y * w;
    if (boundary[li] || outside[li]) return;
    outside[li] = 1;
    stack.push(li);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (stack.length) {
    const li = stack.pop()!;
    const x = li % w, y = Math.floor(li / w);
    tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
  }

  const changes: Array<{ i: number; j: number; k: number; prev: number }> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const li = x + y * w;
      if (outside[li]) continue;
      const a = x + boxA0, b = y + boxB0;
      const [i, j, k] = at(a, b);
      if (!maskFilter(i, j, k)) continue; // <-- gate
      if (i < 0 || j < 0 || k < 0 || i >= dimX || j >= dimY || k >= dimZ) continue;
      const existing = vm.getAtIJK(i, j, k);
      if (existing === segmentIndex) continue; // already this class — nothing to change
      changes.push({ i, j, k, prev: existing }); // overwrite anything else, same as the brush
    }
  }

  if (!changes.length) return { filledVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { filledVoxels: changes.length };
}
// CornerstoneNifti2.ts — add near _rasterizeClosedPolygon / lassoCommitPolygon

export type ScissorsCutOperation = "eraseInside" | "eraseOutside" | "fillInside" | "fillOutside";

export type ScissorsCutOptions = {
  operation: ScissorsCutOperation;
  applyToVisibleSegments?: boolean;
  visibleSegmentIndices?: number[];
  // Restrict the cut to a range of slices around the drawn slice, in mm each
  // direction along the through-plane axis. null/0 = unlimited (only the drawn slice).
  sliceCutDepthMm?: number;
  sliceCutMode?: "unlimited" | "positive" | "negative" | "symmetric";
};

// Rasterizes the polygon into a same-size 0/1 mask over the pane's 2D footprint,
// WITHOUT touching the labelmap — used by scissors to know inside/outside before
// deciding erase vs fill per-voxel.
function _rasterizePolygonMask(
  dimA: number,
  dimB: number,
  polygonAB: Array<[number, number]>
): Uint8Array {
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const [a, b] of polygonAB) {
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }
  const boxA0 = Math.max(0, Math.floor(minA) - 1);
  const boxA1 = Math.min(dimA - 1, Math.ceil(maxA) + 1);
  const boxB0 = Math.max(0, Math.floor(minB) - 1);
  const boxB1 = Math.min(dimB - 1, Math.ceil(maxB) + 1);
  const w = boxA1 - boxA0 + 1;
  const h = boxB1 - boxB0 + 1;
  const full = new Uint8Array(dimA * dimB);
  if (w < 2 || h < 2 || polygonAB.length < 3) return full;

  const idxLocal = (a: number, b: number) => (a - boxA0) + (b - boxB0) * w;
  const boundary = new Uint8Array(w * h);
  const drawLine = (a0: number, b0: number, a1: number, b1: number) => {
    let x0 = Math.round(a0), y0 = Math.round(b0);
    const x1 = Math.round(a1), y1 = Math.round(b1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (x0 >= boxA0 && x0 <= boxA1 && y0 >= boxB0 && y0 <= boxB1) boundary[idxLocal(x0, y0)] = 1;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  for (let i = 0; i < polygonAB.length; i++) {
    const [a0, b0] = polygonAB[i];
    const [a1, b1] = polygonAB[(i + 1) % polygonAB.length];
    drawLine(a0, b0, a1, b1);
  }

  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const li = x + y * w;
    if (boundary[li] || outside[li]) return;
    outside[li] = 1;
    stack.push(li);
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (stack.length) {
    const li = stack.pop()!;
    const x = li % w, y = Math.floor(li / w);
    tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const li = x + y * w;
      const inside = !outside[li] && !boundary[li] ? 1 : (boundary[li] ? 1 : 0);
      if (inside) full[(x + boxA0) + (y + boxB0) * dimA] = 1;
    }
  }
  return full;
}

// Applies a scissors cut using the drawn polygon (in one slice's 2D pixel space).
// Unlike lassoCommitPolygon (always fills), this branches on operation:
//   eraseInside  — clear the active segment's voxels inside the shape
//   eraseOutside — clear the active segment's voxels outside the shape
//   fillInside   — paint the active segment inside the shape
//   fillOutside  — paint the active segment outside the shape (rare, but Slicer supports it)
// sliceCutMode/Depth extends the cut to neighboring slices along the through-plane axis.
export function applyScissorsCut(
  pane: CinePane,
  canvasPoints: Array<[number, number]>,
  options: ScissorsCutOptions,
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const voxelPts = canvasPoints.map((cp) => canvasPointToVoxel(pane, cp));
  if (voxelPts.some((v) => !v) || voxelPts.length < 3) {
    console.warn("Scissors: draw a closed shape with at least 3 points inside the volume.");
    return null;
  }
  const pts = voxelPts as Array<[number, number, number]>;

  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const [dimX, dimY, dimZ] = vm.dimensions;

  const axis = _sliceAxisForPane(pane);
  const throughVals = pts
    .map((p) => (axis === 2 ? p[2] : axis === 0 ? p[0] : p[1]))
    .sort((a, b) => a - b);
  const drawnSlice = throughVals[Math.floor(throughVals.length / 2)];

  const [dimA, dimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const polygonAB: Array<[number, number]> = pts.map((p) =>
    axis === 2 ? [p[0], p[1]] : axis === 0 ? [p[1], p[2]] : [p[0], p[2]]
  );
  const insideMask = _rasterizePolygonMask(dimA, dimB, polygonAB);

  // Resolve which slices this cut touches.
  const spacing = segVolume.spacing as number[];
  const axisSpacing = spacing[axis] || 1;
  const mode = options.sliceCutMode ?? "unlimited";
  let sliceLo = drawnSlice, sliceHi = drawnSlice;
  if (mode !== "unlimited" && options.sliceCutDepthMm) {
    const depthVoxels = Math.max(0, Math.round(options.sliceCutDepthMm / axisSpacing));
    const dimAxis = axis === 2 ? dimZ : axis === 0 ? dimX : dimY;
    if (mode === "symmetric") {
      sliceLo = Math.max(0, drawnSlice - depthVoxels);
      sliceHi = Math.min(dimAxis - 1, drawnSlice + depthVoxels);
    } else if (mode === "positive") {
      sliceHi = Math.min(dimAxis - 1, drawnSlice + depthVoxels);
    } else if (mode === "negative") {
      sliceLo = Math.max(0, drawnSlice - depthVoxels);
    }
  }

  const targets =
    options.applyToVisibleSegments && options.visibleSegmentIndices?.length
      ? options.visibleSegmentIndices
      : [segmentIndex];

  const at = (a: number, b: number, slice: number): [number, number, number] =>
    axis === 2 ? [a, b, slice] : axis === 0 ? [slice, a, b] : [a, slice, b];

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  const wantsInside = options.operation === "eraseInside" || options.operation === "fillInside";
  const paints = options.operation === "fillInside" || options.operation === "fillOutside";

  for (let slice = sliceLo; slice <= sliceHi; slice++) {
    for (let b = 0; b < dimB; b++) {
      for (let a = 0; a < dimA; a++) {
        const isInside = insideMask[a + b * dimA] === 1;
        if (isInside !== wantsInside) continue;
        const [i, j, k] = at(a, b, slice);
        if (!maskFilter(i, j, k)) continue; // <-- gate
        for (const target of targets) {
          const existing = vm.getAtIJK(i, j, k);
          if (paints) {
            if (existing === target) continue;
            changes.push({ i, j, k, prev: existing, next: target });
          } else {
            if (existing !== target) continue;
            changes.push({ i, j, k, prev: existing, next: 0 });
          }
        }
      }
    }
  }
  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}
// Plain (straight-edge) lasso — every clicked canvas point is converted to a
// voxel directly, and the resulting polygon is rasterized in one pass. No
// edge-snapping: the outline is exactly what the user drew.
export function lassoCommitPolygon(
  pane: CinePane,
  canvasPoints: Array<[number, number]>,
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true
): { filledVoxels: number } | null {
  const voxelPts = canvasPoints.map((cp) => canvasPointToVoxel(pane, cp));
  if (voxelPts.some((v) => !v)) {
    console.warn("Lasso: one or more points landed outside the volume.");
    return null;
  }
  const pts = voxelPts as Array<[number, number, number]>;

  const axis = _sliceAxisForPane(pane);
  const throughVals = pts
    .map((p) => (axis === 2 ? p[2] : axis === 0 ? p[0] : p[1]))
    .sort((a, b) => a - b);
  const sliceIndex = throughVals[Math.floor(throughVals.length / 2)];

  const polygonAB: Array<[number, number]> = pts.map((p) =>
    axis === 2 ? [p[0], p[1]] : axis === 0 ? [p[1], p[2]] : [p[0], p[2]]
  );

  return _rasterizeClosedPolygon(pane, sliceIndex, polygonAB, segmentIndex, maskFilter);
}
// ============================================================================
// SECTION: Mouse Tool Release Helper
// ============================================================================

export function releasePrimaryMouseTools() {
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (!toolGroup) return;
  toolGroup.setToolDisabled(CrosshairsTool.toolName);
  toolGroup.setToolDisabled(PanTool.toolName);
  for (const name of EDIT_TOOL_NAMES) toolGroup.setToolDisabled(name);
  for (const name of MEASUREMENT_TOOL_NAMES) toolGroup.setToolPassive(name);
}

export function extractSegmentSurface(
  segmentIndex: number,
  manifestCenter: [number, number, number],
  // Pass a snapshot (e.g. from consumePreEditSegmentSnapshot) to build the
  // surface from a frozen mask instead of the current live labelmap — used
  // to exclude the very stroke that triggered the switch into live-mesh
  // rendering in the first place.
  precomputedMask?: { mask: Uint8Array; dims: [number, number, number] } | null
): LiveMeshResult | null {
  const volume = cache.getVolume(segmentationId);
  if (!volume) return null;

  const built = precomputedMask ?? _buildBinaryMask(segmentIndex);
  if (!built) return null;
  const { mask, dims } = built;

  // Nothing painted yet for this class.
  let any = false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
  if (!any) return null;

  const { padded, pdims } = _padVolume(mask, dims);
  const { points, polys } = _runMarchingCubes(padded, pdims);
  if (!points.length) return null;

  const positions = _transformVertices(
    points,
    volume.origin as number[],
    volume.spacing as number[],
    volume.direction as number[],
    manifestCenter
  );
  const indices = _vtkPolysToIndices(polys);

  return { positions, indices };
}
// ============================================================================
// SECTION: Smoothing (median) — mirrors Slicer's Smoothing effect's Median
// method: same "kernel size in mm -> voxel radius" conversion.
// ============================================================================

export type SmoothingMethod = "median";

const MAX_SMOOTHING_KERNEL_MM = 3;

function _kernelRadiusVoxels(kernelMm: number, spacing: number[]): [number, number, number] {
  // Cap at the same 3mm ceiling the UI slider enforces — a stray call site
  // (or a future UI regression) passing something like 50mm would otherwise
  // blow the kernel radius out to dozens of voxels, making the bbox/filter
  // loops below O(radius^3) against a huge volume and hanging the tab.
  const clampedMm = Math.min(MAX_SMOOTHING_KERNEL_MM, Math.max(0, kernelMm));
  return [
    Math.max(1, Math.round(clampedMm / 2 / spacing[0])),
    Math.max(1, Math.round(clampedMm / 2 / spacing[1])),
    Math.max(1, Math.round(clampedMm / 2 / spacing[2])),
  ];
}

// 3D median filter over a binary mask within a local bbox — Slicer's "Median" method.
function _medianFilter3D(mask: Uint8Array, w: number, h: number, d: number, rx: number, ry: number, rz: number): Uint8Array {
  const idx = (i: number, j: number, k: number) => i + j * w + k * w * h;
  const out = new Uint8Array(mask.length);
  for (let k = 0; k < d; k++) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let on = 0, total = 0;
    for (let dk = -rz; dk <= rz; dk++) for (let dj = -ry; dj <= ry; dj++) for (let di = -rx; di <= rx; di++) {
      const ni = i + di, nj = j + dj, nk = k + dk;
      if (ni < 0 || ni >= w || nj < 0 || nj >= h || nk < 0 || nk >= d) continue;
      total++;
      if (mask[idx(ni, nj, nk)]) on++;
    }
    out[idx(i, j, k)] = on * 2 >= total ? 1 : 0;
  }
  return out;
}

// applyToVisibleSegments mirrors Slicer's "Apply to visible segments" checkbox —
// when true, runs on every currently-visible segment index, not just the active one.
export function applySmoothing(
  kernelMm: number,
  applyToVisibleSegments = false,
  visibleSegmentIndices: number[] = [],
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const spacing = segVolume.spacing as number[];
  const [rx, ry, rz] = _kernelRadiusVoxels(kernelMm, spacing);
  const targets = applyToVisibleSegments && visibleSegmentIndices.length ? visibleSegmentIndices : [_activeEditSegment];

  let totalChanged = 0;
  const allChanges: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];

  for (const segmentIndex of targets) {
    const bbox = _segBBox(vm, segmentIndex, Math.max(rx, ry, rz) + 1);
    if (!bbox) continue;
    const { i0, i1, j0, j1, k0, k1 } = bbox;
    const w = i1 - i0 + 1, h = j1 - j0 + 1, d = k1 - k0 + 1;
    const idxLocal = (i: number, j: number, k: number) => (i - i0) + (j - j0) * w + (k - k0) * w * h;
    let originalCount = 0;
    const wholeSegMask = new Uint8Array(w * h * d);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
      if (vm.getAtIJK(i, j, k) === segmentIndex) {
        wholeSegMask[idxLocal(i, j, k)] = 1; originalCount++;
      }
    if (originalCount === 0) continue;

    // Split by CONNECTED COMPONENT, not by the whole segment's bbox — a
    // segment confined to a single slice along any axis (an annotation
    // drawn on just one axial/sagittal/coronal slice) is inherently 2D, and
    // even a per-axis-capped 3D median filter still runs its in-plane
    // radius across that thin sliver, wiping every voxel's majority vote.
    // Checking the whole class's extent missed this whenever the class had
    // ANY other voxels elsewhere in the volume (even a genuinely-3D blob
    // unrelated to the thin one) — that made the whole-segment extent >1 and
    // silently let the thin blob through to be wiped. Per-component extent
    // fixes that: each connected blob is judged on its own. "thin"
    // components are left untouched below; "thick" (genuinely 3D)
    // components go through the median filter as normal.
    const { thick, thin, hasThin } = _splitThinComponents(wholeSegMask, w, h, d);
    if (!thick.some((v) => v)) continue; // whole segment (in this bbox) was thin — nothing to smooth

    // Recompute the TRUE extent from the thick voxels only — this is what
    // the kernel radius must be capped against, not the padded bbox above
    // and not the (possibly thin-inflated) whole-segment extent.
    let ti0 = i1, ti1 = i0, tj0 = j1, tj1 = j0, tk0 = k1, tk1 = k0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!thick[idxLocal(i, j, k)]) continue;
      if (i < ti0) ti0 = i; if (i > ti1) ti1 = i;
      if (j < tj0) tj0 = j; if (j > tj1) tj1 = j;
      if (k < tk0) tk0 = k; if (k > tk1) tk1 = k;
    }
    const trueExtentX = ti1 - ti0 + 1;
    const trueExtentY = tj1 - tj0 + 1;
    const trueExtentZ = tk1 - tk0 + 1;

    // A box-kernel majority filter is inherently erosive on convex boundaries
    // (curvature means the true surface always sits at <50% local occupancy),
    // so an oversized kernel relative to the segment eats straight through it.
    // Capping per axis against the segment's own true extent (allowing
    // radius 0, i.e. "don't smooth across an axis the object doesn't extend
    // into") fixes the general over-smoothing case for segments that do span
    // multiple slices.
    const segRx = Math.min(rx, Math.floor(trueExtentX / 2));
    const segRy = Math.min(ry, Math.floor(trueExtentY / 2));
    const segRz = Math.min(rz, Math.floor(trueExtentZ / 2));

    // Filter only the thick component(s) — thin ones are restored verbatim
    // after, never passed through the filter at all.
    const original = thick;
    let filtered = _medianFilter3D(original, w, h, d, segRx, segRy, segRz);
    let survivingCount = 0;
    for (let v = 0; v < filtered.length; v++) if (filtered[v]) survivingCount++;

    // Safety net: smoothing should refine a boundary, never delete the
    // segment outright. A majority filter is erosive on anything thinner
    // than its kernel. Instead of either wiping the segment or leaving it
    // completely untouched (both of which look like "nothing smoothed"),
    // back the radius down in unison one step at a time and retry until
    // something survives — still smooths the edges, just as gently as it
    // takes. Radius (0,0,0) is an identity pass, so this always terminates
    // with the segment intact.
    let curRx = segRx, curRy = segRy, curRz = segRz;
    while (survivingCount === 0 && (curRx > 0 || curRy > 0 || curRz > 0)) {
      curRx = Math.max(0, curRx - 1);
      curRy = Math.max(0, curRy - 1);
      curRz = Math.max(0, curRz - 1);
      filtered = _medianFilter3D(original, w, h, d, curRx, curRy, curRz);
      survivingCount = 0;
      for (let v = 0; v < filtered.length; v++) if (filtered[v]) survivingCount++;
    }
    if (survivingCount === 0 && !hasThin) continue; // segment was already empty — nothing to do
    const cur = filtered;
    // Thin components are never smoothed — restore them verbatim.
    for (let li = 0; li < cur.length; li++) if (thin[li]) cur[li] = 1;

    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!maskFilter(i, j, k)) continue; // <-- gate
      const wantFg = cur[idxLocal(i, j, k)] === 1;
      const existing = vm.getAtIJK(i, j, k);
      if (wantFg && existing !== segmentIndex) {
        if (existing !== 0) continue;
        allChanges.push({ i, j, k, prev: existing, next: segmentIndex });
      } else if (!wantFg && existing === segmentIndex) {
        allChanges.push({ i, j, k, prev: existing, next: 0 });
      }
    }
  }

  if (!allChanges.length) return { changedVoxels: 0 };
  for (const c of allChanges) vm.setAtIJK(c.i, c.j, c.k, c.next);
  totalChanged = allChanges.length;
  _pushFillHistory({
    undo: () => { for (const c of allChanges) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of allChanges) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: totalChanged };
}

// ============================================================================
// SECTION: Logical Operators — mirrors Slicer's Logical operators effect:
// Copy / Add / Invert / Clear / Fill, with an optional "Bypass masking" flag
// (skip the existing-voxel-ownership check). Subtract/Intersect are omitted:
// this segmentation is a single shared label array (one segment index per
// voxel), so two segments can never truly overlap in the data — those two
// ops would always be no-ops (subtract) or wipe the whole target
// (intersect). Re-add them only if segments move to independent per-segment
// masks.
// ============================================================================

export type LogicalOperation = "copy" | "add" | "invert" | "clear" | "fill";

export function applyLogicalOperator(
  operation: LogicalOperation,
  targetSegmentIndex: number,
  sourceSegmentIndex: number | null,
  bypassMasking = false,
  maskFilter: MaskFilter = () => true
): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const [dimX, dimY, dimZ] = vm.dimensions;

  const changes: Array<{ i: number; j: number; k: number; prev: number; next: number }> = [];
  const setVoxel = (i: number, j: number, k: number, next: number) => {
    if (!maskFilter(i, j, k)) return; // <-- gate
    const prev = vm.getAtIJK(i, j, k);
    if (prev === next) return;
    if (!bypassMasking && next !== 0 && prev !== 0 && prev !== targetSegmentIndex) return;
    changes.push({ i, j, k, prev, next });
  };
  for (let k = 0; k < dimZ; k++) for (let j = 0; j < dimY; j++) for (let i = 0; i < dimX; i++) {
    const targetOn = vm.getAtIJK(i, j, k) === targetSegmentIndex;
    const sourceOn = sourceSegmentIndex !== null && vm.getAtIJK(i, j, k) === sourceSegmentIndex;
    switch (operation) {
      case "copy":
        if (sourceOn) setVoxel(i, j, k, targetSegmentIndex);
        else if (targetOn) setVoxel(i, j, k, 0);
        break;
      case "add":
        if (sourceOn) setVoxel(i, j, k, targetSegmentIndex);
        break;
      case "invert":
        setVoxel(i, j, k, targetOn ? 0 : targetSegmentIndex);
        break;
      case "clear":
        if (targetOn) setVoxel(i, j, k, 0);
        break;
      case "fill":
        setVoxel(i, j, k, targetSegmentIndex);
        break;
    }
  }

  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, c.next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}

// ============================================================================
// SECTION: Level Tracing — mirrors Slicer's Level Tracing effect: trace the
// iso-contour of equal-or-similar intensity around the point the cursor is
// over, on the current slice, then fill the traced outline. Implemented as a
// 2D contour trace via marching-squares-style boundary following on a
// thresholded slice mask, using the same _extractSliceMask/_rasterizeClosedPolygon
// machinery already used by Copy/Interpolate/Lasso.
//
// Slicer's own Level Tracing effect has no sensitivity/tolerance control —
// it just traces the region of matching intensity under the cursor. We match
// that: the tolerance below is a fixed internal constant, not user-facing.
// ============================================================================

const LEVEL_TRACE_TOLERANCE_HU = 45;

// The four operations Level Tracing can commit, same semantics as the Scissors
// tool's operation set: "inside"/"outside" refer to the traced iso-intensity
// region on this slice, "fill" writes segmentIndex, "erase" writes 0 (clears).
export type LevelTraceOperation = "fillInside" | "fillOutside" | "eraseInside" | "eraseOutside";

export function levelTraceAtPoint(
  pane: CinePane,
  sliceIndex: number,
  seedIJK: [number, number, number],
  segmentIndex = _activeEditSegment,
  maskFilter: MaskFilter = () => true,
  toleranceHu: number = LEVEL_TRACE_TOLERANCE_HU
): { filledVoxels: number } | null {
  const ctVolume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  const segVolume = cache.getVolume(segmentationId);
  if (!ctVolume || !segVolume) return null;
  const ctVm = ctVolume.voxelManager as any;
  const segVm = segVolume.voxelManager as any;
  if (!ctVm || !segVm) return null;

  const [dimX, dimY, dimZ] = ctVm.dimensions;
  let ctData: ArrayLike<number> | undefined;
  try { ctData = ctVm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!ctData || !ctData.length) return null;

  const axis = _sliceAxisForPane(pane);
  const [dimA, dimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const at = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, sliceIndex] : axis === 0 ? [sliceIndex, a, b] : [a, sliceIndex, b];
  const [si, sj, sk] = seedIJK;
  const seedA = axis === 2 ? si : axis === 0 ? sj : si;
  const seedB = axis === 2 ? sj : axis === 0 ? sk : sk;
  const sliceSize = dimX * dimY;
  const idxOf = (i: number, j: number, k: number) => i + j * dimX + k * sliceSize;

  const seedHu = ctData[idxOf(si, sj, sk)];
  const inBand = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= dimA || b >= dimB) return false;
    const [i, j, k] = at(a, b);
    return Math.abs(ctData![idxOf(i, j, k)] - seedHu) <= toleranceHu;
  };

  // Flood-fill the connected iso-intensity region on this single slice (this is
  // what Slicer's level tracing traces the boundary of before filling).
  const mask = new Uint8Array(dimA * dimB);
  const stack: number[] = [seedA + seedB * dimA];
  mask[stack[0]] = 1;
  while (stack.length) {
    const li = stack.pop()!;
    const a = li % dimA, b = Math.floor(li / dimA);
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const na = a + da, nb = b + db;
      if (!inBand(na, nb)) continue;
      const nli = na + nb * dimA;
      if (!mask[nli]) { mask[nli] = 1; stack.push(nli); }
    }
  }

  const changes: Array<{ i: number; j: number; k: number; prev: number }> = [];
  for (let b = 0; b < dimB; b++) for (let a = 0; a < dimA; a++) {
    if (!mask[a + b * dimA]) continue;
    const [i, j, k] = at(a, b);
    if (!maskFilter(i, j, k)) continue; // <-- gate
    const existing = segVm.getAtIJK(i, j, k);
    if (existing === segmentIndex) continue;
    changes.push({ i, j, k, prev: existing });
  }
  if (!changes.length) return { filledVoxels: 0 };
  for (const c of changes) segVm.setAtIJK(c.i, c.j, c.k, segmentIndex);
  _pushFillHistory({
    undo: () => { for (const c of changes) segVm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) segVm.setAtIJK(c.i, c.j, c.k, segmentIndex); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { filledVoxels: changes.length };
}
export function isSegmentPresent(segmentIndex: number): boolean {
  const volume = cache.getVolume(segmentationId);
  const vm = volume?.voxelManager as any;
  if (!volume || !vm) {
    // Expected while the segmentation volume is still loading — not an error.
    return false;
  }
  let data: ArrayLike<number> | undefined;
  try { data = vm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!data || !data.length) {
    return false;
  }
  for (let i = 0; i < data.length; i++) {
    if (data[i] === segmentIndex) return true;
  }
  return false;
}
export function hasSegmentationVolume(): boolean {
  return !!cache.getVolume(segmentationId);
}

// ============================================================================
// SECTION: Level Tracing — live preview + commit (3D Slicer style). On every
// mouse move, flood-fill the connected same-intensity region under the
// cursor on the current slice and hand back a canvas-space outline for a
// preview; a click commits the last-computed region into the active
// segment. No user-facing sensitivity control — matches Slicer, which traces
// off the cursor's own pixel value with a fixed internal band.
//
// Previously this was clipped to a small fixed-radius window, which is what
// produced the square "bounding box" look whenever the real uniform-intensity
// region was bigger than the window — the flood fill hit the window edge and
// got cut off into a box instead of following the actual tissue boundary.
// Tracing the full slice removes that artifact; the `MAX_TRACE_PIXELS` cap
// below only guards against pathological cases (e.g. a seed landing in a
// vast uniform air region) turning into an unbounded fill.
// ============================================================================

export type LevelTraceMask = {
  mask: Uint8Array;
  dimA: number;
  dimB: number;
  boxA0: number;
  boxB0: number;
  sliceIndex: number;
};

// Safety cap on how much of a slice a single trace is allowed to claim —
// not a "window" in the old sense (nothing gets geometrically clipped: the
// flood fill still runs edge-to-edge across the slice), just a circuit
// breaker so an accidental click on a huge uniform region (e.g. background
// air) can't fill the majority of the slice.
const MAX_TRACE_PIXELS = 60000;

// Flood-fills the connected iso-intensity region around seedIJK on one slice.
// Does NOT write to the segmentation — call commitLevelTraceMask to apply it.
export function computeLevelTraceMask(
  pane: CinePane,
  seedIJK: [number, number, number],
  toleranceHu: number = LEVEL_TRACE_TOLERANCE_HU
): LevelTraceMask | null {
  const ctVolume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  if (!ctVolume) return null;
  const ctVm = ctVolume.voxelManager as any;
  if (!ctVm) return null;

  const [dimX, dimY, dimZ] = ctVm.dimensions;
  let ctData: ArrayLike<number> | undefined;
  try { ctData = ctVm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }
  if (!ctData || !ctData.length) return null;

  const axis = _sliceAxisForPane(pane);
  const [dimA, dimB] = axis === 2 ? [dimX, dimY] : axis === 0 ? [dimY, dimZ] : [dimX, dimZ];
  const sliceOf = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, seedIJK[2]] : axis === 0 ? [seedIJK[0], a, b] : [a, seedIJK[1], b];
  const [si, sj, sk] = seedIJK;
  const seedA = axis === 2 ? si : axis === 0 ? sj : si;
  const seedB = axis === 2 ? sj : axis === 0 ? sk : sk;

  const sliceSize = dimX * dimY;
  const idxOf = (i: number, j: number, k: number) => i + j * dimX + k * sliceSize;
  const seedHu = ctData[idxOf(si, sj, sk)];

  const local = (a: number, b: number) => a + b * dimA;
  const inBand = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= dimA || b >= dimB) return false;
    const [i, j, k] = sliceOf(a, b);
    return Math.abs(ctData![idxOf(i, j, k)] - seedHu) <= toleranceHu;
  };

  const mask = new Uint8Array(dimA * dimB);
  const stack: number[] = [local(seedA, seedB)];
  mask[stack[0]] = 1;
  let filled = 1;
  // 8-connected neighborhood — matches Slicer's ITK-based level tracing,
  // which walks diagonals as well as orthogonal neighbors. The previous
  // 4-connected fill let single-pixel-wide diagonal seams (common at
  // oblique tissue boundaries and partial-volume edges) act as a wall,
  // so the trace would stop short of the real boundary instead of
  // following it all the way around.
  while (stack.length) {
    const li = stack.pop()!;
    const a = li % dimA, b = Math.floor(li / dimA);
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const na = a + da, nb = b + db;
      if (!inBand(na, nb)) continue;
      const nli = local(na, nb);
      if (!mask[nli]) {
        mask[nli] = 1;
        filled++;
        if (filled > MAX_TRACE_PIXELS) return null; // background/huge uniform region — not a useful trace
        stack.push(nli);
      }
    }
  }

  return {
    mask, dimA, dimB, boxA0: 0, boxB0: 0,
    sliceIndex: axis === 2 ? sk : axis === 0 ? si : sj,
  };
}

// Writes a previously-computed mask into (or out of) the active segment on its
// slice, per `operation`:
//  - fillInside:  write segmentIndex where the trace mask is set (old/only behavior)
//  - eraseInside: write 0 where the trace mask is set
//  - fillOutside: write segmentIndex everywhere on the slice EXCEPT the trace mask
//  - eraseOutside: write 0 everywhere on the slice EXCEPT the trace mask
export function commitLevelTraceMask(
  pane: CinePane,
  traced: LevelTraceMask,
  segmentIndex: number,
  operation: LevelTraceOperation = "fillInside",
  maskFilter: MaskFilter = () => true
): { filledVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const segVm = segVolume?.voxelManager as any;
  if (!segVolume || !segVm) return null;
  const axis = _sliceAxisForPane(pane);
  const at = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, traced.sliceIndex] : axis === 0 ? [traced.sliceIndex, a, b] : [a, traced.sliceIndex, b];

  const wantsInside = operation === "fillInside" || operation === "eraseInside";
  const paints = operation === "fillInside" || operation === "fillOutside";
  const next = paints ? segmentIndex : 0;

  // Use the solid, hole-free fill derived from the trace's outer boundary —
  // not the raw intensity mask, which can be porous (small vessels,
  // calcifications, noise) and previously left gaps in fillInside/eraseInside,
  // and made fillOutside/eraseOutside act against the wrong region entirely.
  const solidMask = _solidFillFromLevelTraceMask(traced);

  const changes: Array<{ i: number; j: number; k: number; prev: number }> = [];
  for (let b = 0; b < traced.dimB; b++) for (let a = 0; a < traced.dimA; a++) {
    const isInside = solidMask[a + b * traced.dimA] === 1;
    if (isInside !== wantsInside) continue;
    const [i, j, k] = at(a + traced.boxA0, b + traced.boxB0);
    if (!maskFilter(i, j, k)) continue; // <-- gate
    const existing = segVm.getAtIJK(i, j, k);
    if (paints) {
      if (existing === next) continue;
    } else {
      if (existing !== segmentIndex) continue; // erase only touches the target segment
    }
    changes.push({ i, j, k, prev: existing });
  }
  if (!changes.length) return { filledVoxels: 0 };
  for (const c of changes) segVm.setAtIJK(c.i, c.j, c.k, next);
  _pushFillHistory({
    undo: () => { for (const c of changes) segVm.setAtIJK(c.i, c.j, c.k, c.prev); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) segVm.setAtIJK(c.i, c.j, c.k, next); _notifySegmentationChanged(); },
  });
  _notifySegmentationChanged();
  return { filledVoxels: changes.length };
}

// Converts a traced mask's boundary into a canvas-space polygon (Moore-neighbor
// boundary trace, then IJK -> world -> canvas per point) — one outline, good
// enough for a live preview.
// Traces the outer boundary of a flood-filled region mask via Moore-neighbor
// tracing and returns it as a polygon in the mask's own local (a,b) pixel
// coordinates — shared by the canvas-path preview (below) and by the solid
// interior fill used to commit fillInside/eraseInside/fillOutside/eraseOutside
// without leaving holes wherever the underlying intensity mask was porous.
function _traceMaskBoundaryAB(mask: Uint8Array, dimA: number, dimB: number): Array<[number, number]> | null {
  let startA = -1, startB = -1;
  outer: for (let b = 0; b < dimB; b++) {
    for (let a = 0; a < dimA; a++) {
      if (mask[a + b * dimA]) { startA = a; startB = b; break outer; }
    }
  }
  if (startA === -1) return null;

  const isFg = (a: number, b: number) => a >= 0 && b >= 0 && a < dimA && b < dimB && mask[a + b * dimA] === 1;
  const dirs: Array<[number, number]> = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const boundary: Array<[number, number]> = [];
  let curA = startA, curB = startB;
  let backtrackDir = 6;
  const maxSteps = dimA * dimB * 4;
  for (let step = 0; step < maxSteps; step++) {
    boundary.push([curA, curB]);
    let found = false;
    for (let k = 0; k < 8; k++) {
      const dirIdx = (backtrackDir + 1 + k) % 8;
      const [da, db] = dirs[dirIdx];
      const na = curA + da, nb = curB + db;
      if (isFg(na, nb)) {
        curA = na; curB = nb;
        backtrackDir = (dirIdx + 4) % 8;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (curA === startA && curB === startB && boundary.length > 2) break;
  }
  return boundary.length >= 3 ? boundary : null;
}

// Turns the raw (potentially porous, hole-riddled) intensity flood-fill mask
// into a solid filled region: trace its outer boundary, then rasterize that
// boundary as a closed polygon exactly like the Scissors tool does. This is
// what fillInside/eraseInside/fillOutside/eraseOutside should actually judge
// "inside" against — the outline the user sees in the preview — not the raw
// per-pixel intensity match, which naturally has gaps (calcifications, small
// vessels, noise) inside an otherwise uniform organ. Falls back to the raw
// mask if the boundary trace fails (e.g. a 1-2px sliver with no clean contour).
function _solidFillFromLevelTraceMask(traced: LevelTraceMask): Uint8Array {
  const boundaryAB = _traceMaskBoundaryAB(traced.mask, traced.dimA, traced.dimB);
  if (!boundaryAB) return traced.mask;
  const solid = _rasterizePolygonInsideMask(traced.dimA, traced.dimB, boundaryAB);
  return solid;
}

export function levelTraceMaskToCanvasPath(pane: CinePane, traced: LevelTraceMask): Array<[number, number]> | null {
  const engine = getRenderingEngine(renderingEngineId);
  const volume = _currentCtVolumeId ? cache.getVolume(_currentCtVolumeId) : undefined;
  if (!engine || !volume?.imageData) return null;
  const viewport = engine.getViewport(CINE_VIEWPORT_BY_PANE[pane]) as any;
  if (!viewport) return null;

  const { dimA, dimB, boxA0, boxB0, sliceIndex } = traced;
  const axis = _sliceAxisForPane(pane);
  const at = (a: number, b: number): [number, number, number] =>
    axis === 2 ? [a, b, sliceIndex] : axis === 0 ? [sliceIndex, a, b] : [a, sliceIndex, b];

  const boundary = _traceMaskBoundaryAB(traced.mask, dimA, dimB);
  if (!boundary) return null;

  const points: Array<[number, number]> = [];
  for (const [a, b] of boundary) {
    const [i, j, k] = at(a + boxA0, b + boxB0);
    const world = volume.imageData.indexToWorld([i, j, k]);
    try {
      const canvasPt = viewport.worldToCanvas(world);
      points.push([canvasPt[0], canvasPt[1]]);
    } catch {
      /* skip unmappable point */
    }
  }
  return points.length >= 3 ? points : null;
}

export type MaskFilter = (i: number, j: number, k: number) => boolean;

// Builds a voxel-level predicate from the global MaskingSelect choice. `ids` is the
// resolved segment set ("all segments" / "visible segments" / just the active one);
// "everywhere" ignores ids entirely. Every edit function below ANDs this into its
// existing per-voxel accept check, so "outside" truly means "outside those segments'
// current voxels" — not just "which segment index the operation targets."
export function buildMaskFilter(area: MaskingArea, ids: number[]): MaskFilter {
  if (area === "everywhere") return () => true;

  // No concrete target resolved for this scope (e.g. "this segment" selected
  // but no active/target segment yet) — don't silently fall back to
  // "allow everything" or "block everything"; just no-op back to unrestricted
  // and let the caller decide whether to warn the user.
  if (ids.length === 0) {
    console.warn(`Masking scope "${area}" has no resolved segment ids — ignoring scope for this operation.`);
    return () => true;
  }

  const idSet = new Set(ids);
  const inside = area.startsWith("inside");
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!vm) return () => true;

  return (i: number, j: number, k: number) => {
    const label = vm.getAtIJK(i, j, k);
    return inside ? idSet.has(label) : !idSet.has(label);
  };
}


// Locks/unlocks segments for the BRUSH based on the current global masking
// selection (not just "lock everything except active"): "everywhere" unlocks
// all; inside/outside-segment(s) mirrors what maskFilter does for other tools.
function _applyBrushLockState(activeIndex: number, unlockedIds: number[] | "all") {
  try {
    const volume = cache.getVolume(segmentationId);
    const vm = volume?.voxelManager as any;
    if (!volume || !vm) return;
    let data: ArrayLike<number> | undefined;
    try { data = vm.getCompleteScalarDataArray?.(); } catch { /* fall through */ }

    let maxSeen = 0;
    if (data && data.length) {
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (typeof v === "number" && v > maxSeen) maxSeen = v;
      }
    }

    const upper = Math.max(maxSeen, _lastColorLUT?.length ?? 0, activeIndex);
    const unlockedSet = unlockedIds === "all" ? null : new Set(unlockedIds);
    // Start at 0 (background), not 1 — background must be explicitly lockable too,
    // or "inside segments" scopes can never actually exclude unsegmented voxels
    // (background would silently stay paintable regardless of scope).
    for (let i = 0; i <= upper; i++) {
      const isUnlocked = i === activeIndex || unlockedIds === "all" || unlockedSet!.has(i);
      segmentation.segmentLocking.setSegmentIndexLocked(segmentationId, i, !isUnlocked);
    }
  } catch {
    /* segmentation not loaded yet */
  }
}



export function getActiveEditSegment(): number {
  return _activeEditSegment;
}

// Reads the raw segmentation label at a given voxel index — used to check
// whether an island-picker click actually landed inside the segment the
// operation is about to run on (islands only exist within the active
// segment, so a click anywhere else can't be a valid pick).
export function getSegmentAtVoxel(voxel: [number, number, number]): number | undefined {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return undefined;
  const [i, j, k] = voxel;
  const [dimX, dimY, dimZ] = vm.dimensions;
  if (i < 0 || j < 0 || k < 0 || i >= dimX || j >= dimY || k >= dimZ) return undefined;
  const res = vm.getAtIJK(i, j, k);
  return typeof res === "number" ? res : undefined;
}

// Permanently clears every voxel belonging to a segment (used when a segment
// is deleted from the Segments popup — without this, deleting only hid the
// row in the UI while the labelmap data for it stayed in the volume, so it
// could still show up in the 3D render / masking scopes / islands, etc).
export function deleteSegmentEverywhere(segmentIndex: number): { changedVoxels: number } | null {
  const segVolume = cache.getVolume(segmentationId);
  const vm = segVolume?.voxelManager as any;
  if (!segVolume || !vm) return null;
  const [dimX, dimY, dimZ] = vm.dimensions;
  const changes: Array<{ i: number; j: number; k: number }> = [];
  for (let k = 0; k < dimZ; k++) {
    for (let j = 0; j < dimY; j++) {
      for (let i = 0; i < dimX; i++) {
        if (vm.getAtIJK(i, j, k) === segmentIndex) changes.push({ i, j, k });
      }
    }
  }
  if (!changes.length) return { changedVoxels: 0 };
  for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, 0);
  _pushFillHistory({
    undo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, segmentIndex); _notifySegmentationChanged(); },
    redo: () => { for (const c of changes) vm.setAtIJK(c.i, c.j, c.k, 0); _notifySegmentationChanged(); },
  });
  if (_activeEditSegment === segmentIndex) _activeEditSegment = 0;
  _notifySegmentationChanged();
  return { changedVoxels: changes.length };
}

export function setActiveEditSegment(segmentIndex: number) {
  _activeEditSegment = segmentIndex;
  // Grab the "before any stroke" baseline now, while it's still true — see
  // _capturePreEditSnapshotIfAbsent for why this can't wait until the first
  // edit is reported.
  _capturePreEditSnapshotIfAbsent(segmentIndex);
  try {
    segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, segmentIndex);
    // Re-apply using whatever masking scope was last set, so switching the active
    // segment doesn't silently reset locking back to "only this segment."
    _applyBrushLockState(segmentIndex, _brushUnlockedScope);
  } catch {
    /* segmentation not loaded yet */
  }
}

// Module-level: which segments the brush is currently allowed to paint over,
// besides the active one. "all" = everywhere (no locking). Set by the UI whenever
// the global masking selection or its resolved id list changes.
let _brushUnlockedScope: number[] | "all" = [];

// Called by the UI (VisualizationPage) whenever maskingArea/resolved ids change,
// so the brush's lock state always matches the same "Applies to" selection every
// other tool's maskFilter already respects.
export function setBrushMaskingScope(scope: number[] | "all") {
  _brushUnlockedScope = scope;
  _applyBrushLockState(_activeEditSegment, scope);
}

let _brushStrokeSnapshot: ArrayLike<number> | null = null;

// Call when a brush/eraser stroke starts (pointerdown on a pane while brush/eraser is active).
export function beginBrushMaskGuard() {
  const volume = cache.getVolume(segmentationId);
  const vm = volume?.voxelManager as any;
  if (!volume || !vm) { _brushStrokeSnapshot = null; return; }
  try {
    const data = vm.getCompleteScalarDataArray?.();
    _brushStrokeSnapshot = data && data.length ? (data as any).slice() : null;
  } catch {
    _brushStrokeSnapshot = null;
  }
}

// Same inside/outside rule as buildMaskFilter, but evaluated against a plain
// label snapshot instead of the live volume — endBrushMaskGuard must judge
// each voxel by what it WAS before the stroke, not what the brush painted.
function buildSnapshotMaskFilter(
  area: MaskingArea,
  ids: number[],
  snapshot: ArrayLike<number>,
  dimX: number,
  dimY: number
): MaskFilter {
  if (area === "everywhere") return () => true;
  if (ids.length === 0) return () => true;
  const idSet = new Set(ids);
  const inside = area.startsWith("inside");
  const sliceSize = dimX * dimY;
  return (i: number, j: number, k: number) => {
    const label = snapshot[i + j * dimX + k * sliceSize];
    return inside ? idSet.has(label) : !idSet.has(label);
  };
}

// Call when the stroke ends (pointerup) — reverts anything the brush touched
// outside the given masking scope. Takes `area`/`ids` rather than a
// pre-built MaskFilter, because a filter built from the live volume would
// read each voxel's label AFTER the stroke wrote it — judging eligibility
// from the pre-stroke snapshot instead is what makes "inside"/"outside"
// scopes revert the right voxels.
export function endBrushMaskGuard(area: MaskingArea, ids: number[]) {
  const snapshot = _brushStrokeSnapshot;
  _brushStrokeSnapshot = null;
  if (!snapshot) return;
  if (area === "everywhere") return; // nothing was restricted — nothing to revert
  const volume = cache.getVolume(segmentationId);
  const vm = volume?.voxelManager as any;
  if (!volume || !vm) return;
  const [dimX, dimY, dimZ] = vm.dimensions;
  const sliceSize = dimX * dimY;
  const filter = buildSnapshotMaskFilter(area, ids, snapshot, dimX, dimY);
  let reverted = 0;
  for (let k = 0; k < dimZ; k++) for (let j = 0; j < dimY; j++) for (let i = 0; i < dimX; i++) {
    const idx = i + j * dimX + k * sliceSize;
    const before = snapshot[idx];
    const after = vm.getAtIJK(i, j, k);
    if (after !== before && !filter(i, j, k)) {
      vm.setAtIJK(i, j, k, before);
      reverted++;
    }
  }
  if (reverted) _notifySegmentationChanged();
}
