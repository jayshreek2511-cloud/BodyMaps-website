"""
flask-server/services/nninteractive_predictor.py

Talks to a nnInteractive server (local or remote Colab tunnel) via
nnInteractiveRemoteInferenceSession.

Server URL is read from NNINTERACTIVE_SERVER_URL (default: http://127.0.0.1:1527).
API key is read from NN_INTERACTIVE_API_KEY — the client picks it up automatically
from the env, or it can be passed explicitly; both paths are handled below.

CONFIRMED end-to-end on bdmap1 against PanTS_00000001 (2026-08-15):
  - add_point_interaction(coords, include_interaction=True)
      coords = [i, j, k]  -> works, produced 142284 voxels on a test seed.
  - add_bbox_interaction(bbox, include_interaction=True)
      bbox = [[x_lo, x_hi], [y_lo, y_hi], [z_lo, z_hi]]  (per-axis pairs,
      NOT two corner points). Exactly one axis must have size == 1 (a 2D
      box on a single slice) -- size == 0 raises ValueError, and all three
      axes > 1 raises "3D bounding box... not supported by the loaded
      model checkpoint" (this checkpoint is 2D-box-only). Produced 16227
      voxels on a 30x30 test box.

Every box prompt is flattened to zero thickness on whichever axis has the
smallest extent -- see _corners_to_axis_pairs(). This matches a box drawn
on one 2D viewport pane, but has NOT yet been verified against a real
frontend box-drag; verify this once wired up.

Since api_blueprint.py's `_ANALYSIS_SLOTS` semaphore already serializes all
calls into `interactive_segment()`, one shared session with no extra locking
here is safe. Gunicorn is `--workers 1 --threads 8` (single process), so this
module-level cache is correctly shared across every request thread.
"""
from __future__ import annotations

import os

import numpy as np

# Read at import time so the value is stable for the process lifetime.
# flask-server/app.py calls load_dotenv() before any blueprint is imported,
# so NNINTERACTIVE_SERVER_URL is already in os.environ by the time this
# module is first imported.
SERVER_URL: str = os.environ.get("NNINTERACTIVE_SERVER_URL", "http://127.0.0.1:1527")

_session = None
_cached_case_key: str | None = None
_cached_ct_shape: tuple | None = None
_target_buffer: np.ndarray | None = None


def _new_session():
    """Create a fresh nnInteractiveRemoteInferenceSession.

    The client reads NN_INTERACTIVE_API_KEY from os.environ automatically
    (api_key=None triggers the env-var lookup inside the constructor).
    Passing it explicitly here too makes the path unambiguous and allows
    override without restarting the server.

    write_timeout governs how long the HTTP client waits while uploading the
    CT array to the server. A full-res float32 volume (~200 MB) over a Colab
    tunnel can easily take 2–3 minutes, so the default 120 s is too tight.
    set_image_read_timeout governs how long it waits for the server-side
    preprocessing response after the upload completes; 600 s (the client
    default) is already generous but is kept explicit here for clarity.
    """
    from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
    api_key = os.environ.get("NN_INTERACTIVE_API_KEY")
    write_timeout = float(os.environ.get("NNINTERACTIVE_WRITE_TIMEOUT_SECONDS", "300"))
    set_image_timeout = float(os.environ.get("NNINTERACTIVE_SET_IMAGE_TIMEOUT_SECONDS", "600"))
    return nnInteractiveRemoteInferenceSession(
        server_url=SERVER_URL,
        api_key=api_key or None,  # None → client falls back to its own env lookup
        write_timeout=write_timeout,
        set_image_read_timeout=set_image_timeout,
    )


def _get_session():
    global _session
    if _session is None:
        _session = _new_session()
        if not _session.ping():
            _session = None
            raise RuntimeError(
                f"nninteractive-server not reachable at {SERVER_URL} — "
                "check it's running and that NNINTERACTIVE_SERVER_URL / "
                "NN_INTERACTIVE_API_KEY are set correctly."
            )
    return _session


def _reset_session() -> None:
    """Discard the cached session so the next call creates a fresh one.

    Called when SessionExpiredError is caught (Colab restart / 10 min idle).
    """
    global _session, _cached_case_key, _cached_ct_shape, _target_buffer
    try:
        if _session is not None:
            _session.close()
    except Exception:
        pass
    _session = None
    _cached_case_key = None
    _cached_ct_shape = None
    _target_buffer = None


def _ensure_volume_loaded(ct: np.ndarray, case_key: str) -> None:
    global _cached_case_key, _cached_ct_shape, _target_buffer
    session = _get_session()
    if _cached_case_key == case_key and _cached_ct_shape == ct.shape:
        return
    session.set_image(ct[None])
    _target_buffer = np.zeros(ct.shape, dtype=np.uint8)
    session.set_target_buffer(_target_buffer)
    _cached_case_key = case_key
    _cached_ct_shape = ct.shape


def _corners_to_axis_pairs(lo, hi) -> list[list[int]]:
    lo, hi = list(lo), list(hi)
    extents = [hi[d] - lo[d] for d in range(3)]
    flatten_axis = min(range(3), key=lambda d: extents[d])
    pairs = []
    for d in range(3):
        if d == flatten_axis:
            start = lo[d]
            pairs.append([start, start + 1])
        else:
            end = hi[d] if hi[d] > lo[d] else lo[d] + 1
            pairs.append([lo[d], end])
    return pairs


def predict(
    ct: np.ndarray,
    case_key: str,
    point_ijk=None,
    box_ijk=None,
) -> np.ndarray:
    from nnInteractive.inference.remote.remote_session import SessionExpiredError

    def _run_prompt():
        session = _get_session()
        _ensure_volume_loaded(ct, case_key)
        session.reset_interactions()
        if point_ijk is not None:
            session.add_point_interaction(list(point_ijk), include_interaction=True)
        elif box_ijk is not None:
            lo, hi = box_ijk
            axis_pairs = _corners_to_axis_pairs(lo, hi)
            session.add_bbox_interaction(axis_pairs, include_interaction=True)
        else:
            raise ValueError("predict() needs point_ijk or box_ijk")
        return _target_buffer.copy()

    try:
        return _run_prompt()
    except SessionExpiredError:
        # Colab restarted or the session was idle for longer than
        # idle_timeout_seconds (typically 10 min). Drop the cached session
        # and retry once with a fresh lease.
        print("[nninteractive_predictor] SessionExpiredError — resetting session and retrying once.")
        _reset_session()
        return _run_prompt()  # raises on second failure, caught in advanced_analysis.py