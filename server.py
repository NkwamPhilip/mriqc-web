"""
WebMRIQC — combined server
Handles everything in one process:
  POST /convert-dicom        → start async DICOM→BIDS job, returns {job_id}
  POST /run-mriqc            → start async MRIQC job,    returns {job_id}
  GET  /job/{id}             → poll job status
  GET  /job/{id}/download    → fetch result ZIP when done
  GET  /health               → tool availability
  GET  /*                    → serves the React build (dist/)

Jobs run in background threads so the HTTP response returns immediately —
this prevents Cloudflare (and any other proxy) from timing out on long
dcm2bids / MRIQC runs. Job state is stored on disk so all uvicorn workers
can read it.

Deploy with Docker:
  docker compose up -d --build

Or locally (with a venv that has dcm2bids + mriqc installed):
  uvicorn server:app --host 0.0.0.0 --port 8000
"""

import json, os, uuid, shutil, zipfile, logging, datetime, subprocess, re, gzip, struct
from collections import deque
from pathlib import Path
from threading import Thread, Lock

# ── Make locally-downloaded binaries (Render test deployment) findable ────────
_local_bin = Path(__file__).parent / 'bin'
if _local_bin.exists():
    os.environ['PATH'] = f"{_local_bin}:{os.environ.get('PATH', '')}"

# ── Also ensure common conda / pip bin dirs are on PATH ──────────────────────
# nipreps/mriqc uses a conda environment; make sure its bin dir is reachable
# by subprocesses even if the entrypoint activation was skipped.
for _conda_bin in [
    "/opt/conda/bin",
    "/opt/conda/envs/mriqc/bin",
    "/usr/local/bin",
]:
    if Path(_conda_bin).is_dir() and _conda_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{_conda_bin}:{os.environ['PATH']}"

from fastapi import (
    FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Body, Header,
)
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger("webmriqc")

# ── Resolve tool paths once at startup ───────────────────────────────────────
DCM2BIDS_BIN          = shutil.which("dcm2bids")
DCM2BIDS_HELPER_BIN   = shutil.which("dcm2bids_helper")
DCM2BIDS_SCAFFOLD_BIN = shutil.which("dcm2bids_scaffold")
DCM2NIIX_BIN          = shutil.which("dcm2niix")
MRIQC_BIN             = shutil.which("mriqc")
log.info("PATH=%s", os.environ.get("PATH", ""))
log.info("Tool paths → dcm2bids=%s  helper=%s  scaffold=%s  dcm2niix=%s  mriqc=%s",
         DCM2BIDS_BIN, DCM2BIDS_HELPER_BIN, DCM2BIDS_SCAFFOLD_BIN, DCM2NIIX_BIN, MRIQC_BIN)

app = FastAPI(title="WebMRIQC")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORK_ROOT = Path("/tmp/webmriqc")
WORK_ROOT.mkdir(parents=True, exist_ok=True)

# ── Async job store (filesystem-based, multi-worker safe) ─────────────────────
# Each job gets a directory under JOB_ROOT:
#   running      — sentinel while job is in progress
#   done         — written with the label when job succeeds
#   error.txt    — written with the error message on failure
#   result.zip   — the output ZIP (moved here on success)

JOB_ROOT = Path("/tmp/webmriqc_jobs")
JOB_ROOT.mkdir(parents=True, exist_ok=True)

# ══════════════════════════════════════════════════════════════════════════════
# Job queue  (MRIQC only — DICOM/BIDS conversion is lightweight, runs direct)
#
# MAX_CONCURRENT_JOBS — how many MRIQC runs can execute in parallel.
#   Tuned for the MAILAB scalar server: 384 CPUs / 1.5 TB RAM.
#   Each job is given 36 cores + 128 GB:
#     10 jobs × 36 cores = 360 of 384 CPUs
#     10 jobs × 128 GB   = 1,280 of 1,500 GB RAM  (220 GB free for OS)
#   Override with the MAX_CONCURRENT_JOBS env var in docker-compose.yml.
#
# MAX_QUEUE_SIZE — maximum users allowed to wait.  Requests beyond this are
#   rejected immediately with HTTP 503 and a friendly message.
# ══════════════════════════════════════════════════════════════════════════════

MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "10"))
MAX_QUEUE_SIZE      = int(os.environ.get("MAX_QUEUE_SIZE",      "100"))

# Approximate processing time per job in minutes — used for wait estimates.
# With 36 cores + 128 GB per job, T1w ANTs registration runs in ~2–3 min.
_EST_MINUTES_PER_JOB = 3

_q_lock  : Lock          = Lock()
_active  : set[str]      = set()   # job_ids currently running MRIQC
_pending : deque         = deque() # deque of (job_id, runner_callable)


def _q_enqueue(job_id: str, runner) -> bool:
    """
    Try to run job_id immediately; queue it if the server is at capacity.
    Returns True if the job was queued (not yet started), False if started now.
    Raises ValueError if the queue is full.
    """
    with _q_lock:
        if len(_active) < MAX_CONCURRENT_JOBS:
            _active.add(job_id)
            Thread(target=runner, daemon=True).start()
            return False
        if len(_pending) >= MAX_QUEUE_SIZE:
            raise ValueError(
                f"The server queue is full ({MAX_QUEUE_SIZE} jobs waiting). "
                "Please try again in a few hours."
            )
        _pending.append((job_id, runner))
        log.info("[queue] Job %s queued at position %d", job_id, len(_pending))
        return True


def _q_release(job_id: str):
    """
    Called by a finishing MRIQC thread to release its compute slot and hand
    off to the next waiting job (if any).
    """
    with _q_lock:
        _active.discard(job_id)
        if _pending and len(_active) < MAX_CONCURRENT_JOBS:
            next_id, next_runner = _pending.popleft()
            _active.add(next_id)
            log.info("[queue] Promoting job %s from queue → active", next_id)
            Thread(target=next_runner, daemon=True).start()


def _q_cancel(job_id: str) -> bool:
    """Remove a queued job before it starts. Returns True if removed."""
    with _q_lock:
        before = len(_pending)
        new_q  = deque((jid, fn) for jid, fn in _pending if jid != job_id)
        _pending.clear()
        _pending.extend(new_q)
        return len(_pending) < before


def _q_status(job_id: str) -> dict | None:
    """
    Return live queue/run state for job_id, or None if it's not in memory.
    Callers should fall through to the file-based sentinels (done / error.txt)
    when this returns None.
    """
    with _q_lock:
        if job_id in _active:
            return {
                "status":         "running",
                "queue_position": 0,
                "total_queued":   len(_pending),
                "active_jobs":    len(_active),
            }
        pending_ids = [jid for jid, _ in _pending]
        if job_id in pending_ids:
            pos  = pending_ids.index(job_id) + 1   # 1-based
            total = len(_pending)
            return {
                "status":              "queued",
                "queue_position":      pos,
                "total_queued":        total,
                "estimated_wait_min":  pos * _EST_MINUTES_PER_JOB,
                "active_jobs":         len(_active),
            }
    return None


def _q_snapshot() -> dict:
    """Return a queue health snapshot for /health."""
    with _q_lock:
        return {
            "active":          len(_active),
            "pending":         len(_pending),
            "max_concurrent":  MAX_CONCURRENT_JOBS,
            "max_queue":       MAX_QUEUE_SIZE,
            "busy":            len(_active) >= MAX_CONCURRENT_JOBS,
        }


def _jdir(job_id: str) -> Path:
    return JOB_ROOT / job_id

def job_create(job_id: str, running: bool = True):
    """Create the job directory. Set running=False for queued jobs."""
    _jdir(job_id).mkdir(parents=True, exist_ok=True)
    if running:
        (_jdir(job_id) / "running").touch()

def job_done(job_id: str, result_zip: Path, label: str = ""):
    dest = _jdir(job_id) / "result.zip"
    shutil.move(str(result_zip), str(dest))
    (_jdir(job_id) / "running").unlink(missing_ok=True)
    (_jdir(job_id) / "done").write_text(label)
    log.info("[%s] Job done → %s", job_id, dest)

def job_error(job_id: str, message: str):
    (_jdir(job_id) / "running").unlink(missing_ok=True)
    (_jdir(job_id) / "error.txt").write_text(message)
    log.error("[%s] Job error: %s", job_id, message)

def job_status(job_id: str) -> dict | None:
    d = _jdir(job_id)
    if not d.exists():
        return None
    if (d / "done").exists():
        return {"status": "done"}
    if (d / "error.txt").exists():
        return {"status": "error", "error": (d / "error.txt").read_text()}
    return {"status": "running"}


# ══════════════════════════════════════════════════════════════════════════════
# DICOM → BIDS helpers
# ══════════════════════════════════════════════════════════════════════════════

def _as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])


def _re_any(text: str, *patterns: str) -> bool:
    return any(re.search(p, text) for p in patterns)


# Substrings that mark a series as a derived map / localizer / report — never raw
_SKIP_SUBSTR = (
    "localizer", "scout", "survey", "aahead", "3-plane", "3 plane", "plane_loc",
    "phoenix", "screenshot", "screen save", "report", "results",
    "tracew", "_adc", "adc_", " adc", "_fa", "colfa", "fractional aniso",
    "_cbf", "_rbv", "_mtt", "_ttp", "_tmax", "perfusion_weighted",
)


def _nii_nvols(nii_path: Path):
    """Number of volumes (NIfTI dim[4]), dependency-free. None if unknown."""
    try:
        opener = gzip.open if str(nii_path).endswith(".gz") else open
        with opener(nii_path, "rb") as f:
            hdr = f.read(352)
        if len(hdr) < 352:
            return None
        dims = struct.unpack("<8h", hdr[40:56])     # little-endian first
        if not (1 <= dims[0] <= 7):                 # wrong endianness → big-endian
            dims = struct.unpack(">8h", hdr[40:56])
        return dims[4] if dims[0] >= 4 else 1
    except Exception:
        return None


def _task_name(desc: str) -> str:
    if "rest" in desc:
        return "rest"
    m = re.search(r"task[_\-]?([a-z0-9]+)", desc)
    if m:
        return m.group(1)
    for name in ("nback", "faces", "gambling", "language", "motor",
                 "emotion", "memory", "stroop", "flanker"):
        if name in desc:
            return name
    return "task"


def _pe_dir(meta: dict) -> dict:
    mapping = {"j-": "AP", "j": "PA", "i-": "RL", "i": "LR", "k-": "IS", "k": "SI"}
    d = mapping.get(str(meta.get("PhaseEncodingDirection", "")))
    return {"dir": d} if d else {}


def classify_series(meta: dict, has_bval: bool, n_vols):
    """
    Decide the BIDS datatype/suffix/entities for ONE converted NIfTI from its
    dcm2niix sidecar. Returns either
        {"datatype","suffix","entities":{...}, "sidecar":{...}}   → keep, or
        {"skip": "<reason>"}                                      → drop.

    Classification is metadata-first (ImageType + sequence params) and name
    second, so it works for any uploaded subject regardless of how the scanner
    labelled the series — it catches MPRAGE / BRAVO / SPACE etc., not just *T1*.
    """
    itype = [str(x).upper() for x in _as_list(meta.get("ImageType"))]
    desc  = " ".join(str(meta.get(k, "")) for k in
                     ("SeriesDescription", "ProtocolName", "SequenceName")).lower()
    is_deriv = "DERIVED" in itype

    # ── always-drop "junk": localizers / screenshots / derived parametric maps
    # These are never wanted — not even by the fallback rescue (junk=True).
    # NOTE: a DERIVED/SECONDARY tag alone is NOT junk: de-identified or
    # NIfTI-derived exports tag the real scan that way, so it must fall through.
    if any(s in desc for s in _SKIP_SUBSTR):
        return {"skip": f"derived/aux series ({meta.get('SeriesDescription', '?')})", "junk": True}
    if "LOCALIZER" in itype:
        return {"skip": "localizer", "junk": True}

    # ── diffusion ────────────────────────────────────────────────────────────
    if has_bval or "DIFFUSION" in itype or _re_any(desc, r"\bdwi\b", r"\bdti\b",
                                                    r"diffusion", r"\bhardi\b"):
        if is_deriv:
            return {"skip": "derived diffusion map", "junk": True}
        return {"datatype": "dwi", "suffix": "dwi", "entities": {}}

    # ── field maps ───────────────────────────────────────────────────────────
    if _re_any(desc, r"field.?map", r"\bfmap\b", r"gre.?field", r"\bb0\b",
               r"distortion", r"topup", r"pepolar", r"se.?epi"):
        if _re_any(desc, r"se.?epi", r"pepolar", r"topup", r"distortion") and \
           (n_vols is None or n_vols <= 10):
            return {"datatype": "fmap", "suffix": "epi", "entities": _pe_dir(meta)}
        if "PHASE" in itype or "P" in itype:
            return {"datatype": "fmap", "suffix": "phasediff", "entities": {}}
        return {"datatype": "fmap", "suffix": "magnitude", "entities": {}}

    # ── functional ───────────────────────────────────────────────────────────
    if _re_any(desc, r"\bbold\b", r"\bfmri\b", r"resting", r"\brest\b",
               r"\btask\b", r"ep2d.?bold", r"\bfunc\b") and (n_vols is None or n_vols > 1):
        task = _task_name(desc)
        return {"datatype": "func", "suffix": "bold",
                "entities": {"task": task}, "sidecar": {"TaskName": task}}
    if _re_any(desc, r"sbref", r"single.?band"):
        return {"datatype": "func", "suffix": "sbref",
                "entities": {"task": _task_name(desc)}}

    # ── anatomical ───────────────────────────────────────────────────────────
    if _re_any(desc, r"flair"):
        return {"datatype": "anat", "suffix": "FLAIR", "entities": {}}
    if _re_any(desc, r"\bt2w?\b", r"\bspace\b", r"\bcube\b", r"\btse\b") \
       and not _re_any(desc, r"t2star", r"t2\*"):
        return {"datatype": "anat", "suffix": "T2w", "entities": {}}
    if _re_any(desc, r"mprage", r"mp.?rage", r"memprage", r"\bt1w?\b",
               r"bravo", r"fspgr", r"\bspgr\b", r"\btfl\b", r"\bmpr\b"):
        return {"datatype": "anat", "suffix": "T1w", "entities": {}}
    # MPRAGE-like even when oddly named: 3D inversion-recovery with a short TE
    if str(meta.get("MRAcquisitionType", "")).upper() == "3D" and \
       meta.get("InversionTime") and (meta.get("EchoTime") or 99) < 10:
        return {"datatype": "anat", "suffix": "T1w", "entities": {}}

    # Not a recognized standard modality, but may still be a real image (e.g. a
    # de-identified NIfTI-derived export). Mark as non-junk so the rescue in
    # build_bids_from_dicom() can place it instead of yielding an empty dataset.
    return {"skip": f"no standard-modality match ({meta.get('SeriesDescription', '?')})",
            "junk": False}


def _run_cmd(cmd: list, label: str):
    """Run a subprocess, log truncated output, return (returncode, combined log)."""
    log.info("CMD: %s", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, env=os.environ.copy())
    if r.stdout.strip():
        log.info("%s stdout: %s", label, r.stdout[-2000:])
    if r.stderr.strip():
        log.info("%s stderr: %s", label, r.stderr[-2000:])
    return r.returncode, f"$ {' '.join(cmd)}\n{r.stdout}\n{r.stderr}".strip()


def _custom_entities(entities: dict) -> list:
    """Turn a {task, acq, dir, run, echo} dict into dcm2bids custom_entities tokens."""
    order = ("task", "acq", "dir", "run", "echo")
    return [f"{k}-{entities[k]}" for k in order if entities.get(k) not in (None, "")]


def build_dcm2bids_config(helper_dir: Path, config_path: Path,
                          fallback_suffix: str = "T1w"):
    """
    Generate a dcm2bids config FROM the helper sidecars, so its criteria are
    guaranteed to match this subject's real series — the key to "the right files
    get picked". classify_series() decides each series' datatype/suffix; junk
    (localizers / derived maps) is omitted; a series with no standard-modality
    match is mapped to anat/<fallback_suffix> instead of being dropped (handles
    de-identified / NIfTI-derived DICOMs).

    Returns (descriptions, kept_lines, skipped_lines).
    """
    kept, skipped_lines = [], []
    for js in sorted(helper_dir.glob("*.json")):
        nii = js.with_suffix(".nii.gz")
        if not nii.exists():
            nii = js.with_suffix(".nii")
        if not nii.exists():
            continue
        try:
            meta = json.loads(js.read_text())
        except Exception:
            meta = {}
        decision = classify_series(meta, js.with_suffix(".bval").exists(), _nii_nvols(nii))
        label = meta.get("SeriesDescription") or js.stem
        if "skip" in decision and decision.get("junk"):
            skipped_lines.append(f"  [-] {label}  ({decision['skip']})")
            continue
        if "skip" in decision:                       # non-junk, unrecognized → fallback
            datatype, suffix, entities, sidecar, fb = "anat", fallback_suffix, {}, {}, True
        else:
            datatype, suffix = decision["datatype"], decision["suffix"]
            entities = dict(decision.get("entities", {}))
            sidecar = decision.get("sidecar", {})
            fb = False
        kept.append({"series": meta.get("SeriesNumber", 0),
                     "desc": meta.get("SeriesDescription", ""),
                     "datatype": datatype, "suffix": suffix, "entities": entities,
                     "sidecar": sidecar, "label": label, "fallback": fb})

    # run- numbering for repeated acquisitions of the same type
    groups = {}
    for k in kept:
        gkey = (k["datatype"], k["suffix"], k["entities"].get("task"),
                k["entities"].get("dir"), k["entities"].get("acq"))
        groups.setdefault(gkey, []).append(k)
    for members in groups.values():
        if len(members) > 1:
            for i, k in enumerate(sorted(members, key=lambda x: x["series"]), 1):
                k["entities"]["run"] = i

    # one description per series, with criteria that match exactly one series
    desc_counts = {}
    for k in kept:
        desc_counts[k["desc"]] = desc_counts.get(k["desc"], 0) + 1
    descriptions, kept_lines = [], []
    for k in kept:
        # prefer a unique, non-empty SeriesDescription; else the always-unique
        # SeriesNumber — so dcm2bids never maps one series to two descriptions.
        if k["desc"] and desc_counts[k["desc"]] == 1:
            criteria = {"SeriesDescription": k["desc"]}
        else:
            criteria = {"SeriesNumber": k["series"]}
        entry = {"datatype": k["datatype"], "suffix": k["suffix"], "criteria": criteria}
        ents = _custom_entities(k["entities"])
        if ents:
            entry["custom_entities"] = ents
        if k["sidecar"]:
            entry["sidecar_changes"] = k["sidecar"]
        descriptions.append(entry)
        kept_lines.append(f"  [+] {k['label']}  ->  {k['datatype']}/{k['suffix']}"
                          f"{''.join('_' + e for e in ents)}"
                          f"{' (fallback)' if k['fallback'] else ''}")

    config_path.write_text(json.dumps(
        {"search_method": "fnmatch", "case_sensitive": False,
         "descriptions": descriptions}, indent=2))
    return descriptions, kept_lines, skipped_lines


def _validate_bids(bids_out: Path, subj_id: str) -> str:
    """
    Best-effort, NON-BLOCKING BIDS check. Confirms what MRIQC needs
    (dataset_description + at least one image with a JSON sidecar) and runs the
    official bids-validator if it is installed. Never raises.
    """
    lines = ["-- validation (non-blocking) ------------------------------"]
    ok_dd  = (bids_out / "dataset_description.json").exists()
    images = list((bids_out / f"sub-{subj_id}").rglob("*.nii.gz"))
    paired = bool(images) and all(
        i.with_suffix("").with_suffix(".json").exists() for i in images)
    lines.append(f"  [{'+' if ok_dd  else '-'}] dataset_description.json")
    lines.append(f"  [{'+' if images else '-'}] {len(images)} image(s) under sub-{subj_id}")
    lines.append(f"  [{'+' if paired else '-'}] every image has a JSON sidecar")
    validator = shutil.which("bids-validator")
    if validator:
        try:
            rc, out = _run_cmd([validator, str(bids_out)], "bids-validator")
            lines.append(f"  bids-validator exit={rc} (informational only):")
            lines.append(out[-1500:])
        except Exception as e:
            lines.append(f"  bids-validator could not run: {e}")
    else:
        lines.append("  bids-validator not installed — structural check only.")
    return "\n".join(lines)


def build_bids_from_dicom(dicom_dir: Path, bids_out: Path,
                          subj_id: str, ses_id: str,
                          fallback_suffix: str = "T1w") -> str:
    """
    Standard dcm2bids conversion for one subject:
      1. dcm2bids_scaffold      — create the BIDS skeleton.
      2. dcm2bids_helper        — convert every series to NIfTI+JSON to inspect.
      3. build_dcm2bids_config  — generate a config FROM those sidecars so the
         criteria match this subject's real series (incl. de-identified scans).
      4. dcm2bids               — pick the matched files and place them in BIDS.
      5. validate               — non-blocking sanity check.
    Raises RuntimeError (with the helper breakdown) only if no image lands in the
    dataset, so MRIQC is always handed a non-empty BIDS folder.
    """
    full_log = []

    # 1. scaffold ─────────────────────────────────────────────────────────────
    rc, out = _run_cmd([DCM2BIDS_SCAFFOLD_BIN or "dcm2bids_scaffold",
                        "-o", str(bids_out), "--force"], "scaffold")
    full_log.append(out)
    if rc != 0:
        raise RuntimeError(f"dcm2bids_scaffold failed (exit {rc}):\n{out[-1500:]}")

    # 2. helper → tmp_dcm2bids/helper/*.{nii.gz,json} ─────────────────────────
    rc, out = _run_cmd([DCM2BIDS_HELPER_BIN or "dcm2bids_helper",
                        "-d", str(dicom_dir), "-o", str(bids_out), "--force"], "helper")
    full_log.append(out)
    helper_dir = bids_out / "tmp_dcm2bids" / "helper"
    if rc != 0 or not helper_dir.exists():
        raise RuntimeError(f"dcm2bids_helper failed (exit {rc}):\n{out[-1500:]}")

    # 3. generate the config from the helper sidecars ─────────────────────────
    config_path = bids_out / "code" / "dcm2bids_config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    descriptions, kept_lines, skipped_lines = build_dcm2bids_config(
        helper_dir, config_path, fallback_suffix)
    full_log.append("-- generated dcm2bids config --------------------------------\n"
                    f"config: {config_path}\n" + "\n".join(kept_lines or ["  (none)"])
                    + (("\nomitted (junk/localizer/derived):\n" + "\n".join(skipped_lines))
                       if skipped_lines else ""))
    if not descriptions:
        raise RuntimeError(
            "No usable series found by dcm2bids_helper — only junk/localizer/"
            "derived images were present:\n" + "\n".join(skipped_lines)
            + "\n\nUpload a subject that contains an anatomical/functional scan."
        )

    # 4. run dcm2bids — it picks the matched files and lays out the BIDS tree ──
    cmd = [DCM2BIDS_BIN or "dcm2bids", "-d", str(dicom_dir), "-p", subj_id,
           "-c", str(config_path), "-o", str(bids_out),
           "--auto_extract_entities", "--force_dcm2bids", "--clobber"]
    if ses_id:
        cmd += ["-s", ses_id]
    rc, out = _run_cmd(cmd, "dcm2bids")
    full_log.append(out)
    if rc != 0:
        raise RuntimeError(f"dcm2bids failed (exit {rc}):\n{out[-2000:]}")

    # 5. hard guarantee MRIQC gets data, then non-blocking validation ─────────
    sub_dir = bids_out / f"sub-{subj_id}"
    images  = list(sub_dir.rglob("*.nii.gz")) if sub_dir.exists() else []
    if not images:
        raise RuntimeError(
            "dcm2bids ran but placed no images in the BIDS folder (config did not "
            "match). Helper series were:\n" + "\n".join(kept_lines + skipped_lines)
        )

    # overwrite the scaffold's empty README / dataset_description Name so the
    # dataset is clean (scaffold ships a 0-byte README that fails validation)
    create_bids_top_level_files(bids_out, subj_id)

    full_log.append(_validate_bids(bids_out, subj_id))
    full_log.append(f"RESULT: {len(images)} image(s) in sub-{subj_id} — ready for MRIQC")

    # tidy the working dir so the packaged BIDS zip is clean
    shutil.rmtree(bids_out / "tmp_dcm2bids", ignore_errors=True)
    log.info("BIDS conversion complete: %d image(s) for sub-%s", len(images), subj_id)
    return "\n\n".join(full_log)


def create_bids_top_level_files(bids_dir: Path, subject_id: str):
    # Always (over)write dataset_description — dcm2bids_scaffold ships one with an
    # empty Name and a single blank author, which the BIDS validator flags.
    (bids_dir / "dataset_description.json").write_text(json.dumps({
        "Name": "MRIQC Dataset", "BIDSVersion": "1.6.0", "License": "CC0",
        "Authors": ["Philip Nkwam", "Udunna Anazodo", "Maruf Adewole", "Sekinat Aderibigbe"],
        "DatasetType": "raw",
    }, indent=2))
    # Non-empty README (scaffold's is 0 bytes → EMPTY_FILE error).
    (bids_dir / "README").write_text(
        "# BIDS Dataset\n\n"
        "Generated by WebMRIQC (DICOM to BIDS via dcm2bids) for MRIQC quality control.\n"
        "Each subject folder contains the converted anatomical/functional NIfTI images "
        "and their JSON sidecars.\n")
    (bids_dir / "CHANGES").write_text(f"1.0.0 {datetime.date.today()}\n  - Initial BIDS conversion\n")
    pts = bids_dir / "participants.tsv"
    if not pts.exists():
        pts.write_text(f"participant_id\tage\tsex\nsub-{subject_id}\tN/A\tN/A\n")
    pj = bids_dir / "participants.json"
    if not pj.exists():
        pj.write_text(json.dumps({
            "participant_id": {"Description": "Unique participant ID"},
            "age": {"Description": "Age in years"},
            "sex": {"Description": "Biological sex"},
        }, indent=2))


# ══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {
        "ok":       True,
        "dcm2bids": DCM2BIDS_BIN is not None,
        "dcm2niix": DCM2NIIX_BIN is not None,
        "mriqc":    MRIQC_BIN    is not None,
        "queue":    _q_snapshot(),
    }


@app.delete("/job/{job_id}")
def cancel_job(job_id: str):
    """Remove a queued (not yet started) job from the waiting list."""
    removed = _q_cancel(job_id)
    if removed:
        job_error(job_id, "Cancelled by user before processing started")
    return {"cancelled": removed}


@app.get("/debug/env")
def debug_env():
    """Returns PATH and resolved tool locations — useful for diagnosing
    container environments.  Not sensitive: no secrets are exposed."""
    return JSONResponse({
        "PATH":      os.environ.get("PATH", ""),
        "dcm2bids":  DCM2BIDS_BIN,
        "dcm2niix":  DCM2NIIX_BIN,
        "mriqc":     MRIQC_BIN,
        "python":    shutil.which("python") or shutil.which("python3"),
        "work_root": str(WORK_ROOT),
        "job_root":  str(JOB_ROOT),
        "cwd":       str(Path.cwd()),
    })


# ── Job status + download ─────────────────────────────────────────────────────

@app.get("/job/{job_id}")
def get_job_status(job_id: str):
    # In-memory queue state is authoritative for queued / running jobs.
    qs = _q_status(job_id)
    if qs:
        return qs
    # Fall through to persistent file sentinels for done / error.
    st = job_status(job_id)
    if st is None:
        raise HTTPException(404, "Job not found")
    return st


@app.get("/job/{job_id}/download")
def download_job_result(background_tasks: BackgroundTasks, job_id: str):
    st = job_status(job_id)
    if st is None:
        raise HTTPException(404, "Job not found")
    if st["status"] == "error":
        raise HTTPException(500, st.get("error", "Job failed"))
    if st["status"] != "done":
        raise HTTPException(425, "Job not ready yet")

    result = _jdir(job_id) / "result.zip"
    if not result.exists():
        raise HTTPException(404, "Result file missing — job may have expired")

    label = (_jdir(job_id) / "done").read_text().strip() or job_id
    background_tasks.add_task(shutil.rmtree, str(_jdir(job_id)), True)
    return FileResponse(
        str(result),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=result_{label}.zip"},
    )


# ── DICOM → BIDS ──────────────────────────────────────────────────────────────

@app.post("/convert-dicom")
async def convert_dicom(
    dicom_zip:        UploadFile = File(...),
    participant_label: str = Form("01"),
    session_id:        str = Form(""),
    modality:          str = Form("T1w"),   # fallback suffix for de-identified scans
    authorization:    str = Header(None),
):
    participant_label = participant_label.strip()
    if not participant_label or not participant_label.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400, "Participant label must be alphanumeric")

    # Standard anatomical suffix to fall back to when a series has no recognizable
    # modality name (de-identified / NIfTI-derived uploads). Whitelisted so it can
    # never inject bad text into BIDS filenames; unknown values default to T1w.
    fallback_suffix = modality.strip() if modality.strip() in (
        "T1w", "T2w", "FLAIR", "PDw", "T2starw") else "T1w"

    job_id   = str(uuid.uuid4())[:8]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True)

    # Track this submission if the request is from a logged-in user (no-op for guests)
    _record_submission(_user_from_header(authorization), job_id, "dicom",
                       f"DICOM→BIDS · sub-{participant_label}")

    # Save upload synchronously (this is fast — it's just writing bytes)
    try:
        zip_path = work_dir / "dicoms.zip"
        with open(zip_path, "wb") as f:
            while chunk := await dicom_zip.read(1024 * 1024):
                f.write(chunk)
        log.info("[%s] Upload saved: %d bytes", job_id, zip_path.stat().st_size)
    except Exception as e:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(500, f"Upload failed: {e}")

    job_create(job_id)

    def _run():
        log.info("[%s] Conversion thread started — work_dir=%s", job_id, work_dir)
        try:
            # ── Extract ──────────────────────────────────────────────────────
            dicom_dir = work_dir / "dicoms"
            dicom_dir.mkdir(parents=True, exist_ok=True)
            log.info("[%s] Extracting ZIP → %s", job_id, dicom_dir)
            try:
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(dicom_dir)
            except zipfile.BadZipFile:
                job_error(job_id, "Uploaded file is not a valid ZIP")
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            # Flatten one extra directory level if the ZIP contained a folder
            # (e.g. dicom.zip → DICOM/ → *.dcm  becomes  dicom_dir/ → *.dcm)
            entries = list(dicom_dir.iterdir())
            if len(entries) == 1 and entries[0].is_dir():
                inner = entries[0]
                for f in inner.iterdir():
                    shutil.move(str(f), str(dicom_dir / f.name))
                inner.rmdir()
                log.info("[%s] Flattened ZIP top-level folder '%s'", job_id, inner.name)

            dicom_count = sum(1 for _ in dicom_dir.rglob("*") if _.is_file())
            log.info("[%s] Extracted %d files", job_id, dicom_count)

            # ── Convert ──────────────────────────────────────────────────────
            bids_out = work_dir / "bids"
            bids_out.mkdir(parents=True, exist_ok=True)
            log.info("[%s] Converting DICOM→BIDS via dcm2bids (binary=%s) …", job_id, DCM2BIDS_BIN)
            try:
                conv_log = build_bids_from_dicom(dicom_dir, bids_out, participant_label,
                                                 session_id, fallback_suffix=fallback_suffix)
            except FileNotFoundError:
                msg = (
                    f"dcm2bids toolchain not found (searched PATH={os.environ.get('PATH','')!r}). "
                    "Are dcm2bids, dcm2bids_helper, dcm2bids_scaffold and dcm2niix installed?"
                )
                log.error("[%s] %s", job_id, msg)
                job_error(job_id, msg)
                shutil.rmtree(work_dir, ignore_errors=True)
                return
            except RuntimeError as e:
                # Includes the "no usable images" case, with the per-series breakdown.
                log.error("[%s] Conversion error: %s", job_id, e)
                job_error(job_id, str(e))
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            log.info("[%s] DICOM→BIDS finished OK", job_id)

            # Top-level BIDS files are written inside build_bids_from_dicom().
            (bids_out / "conversion_log.txt").write_text(conv_log)

            # ── Package ──────────────────────────────────────────────────────
            zip_out = work_dir / "bids_output"
            log.info("[%s] Archiving BIDS output …", job_id)
            shutil.make_archive(str(zip_out), "zip", root_dir=bids_out)
            job_done(job_id, zip_out.with_suffix(".zip"), f"bids_sub-{participant_label}")
            # Clean up heavy source files; keep only the result in job dir
            shutil.rmtree(work_dir, ignore_errors=True)
            log.info("[%s] Done ✓", job_id)

        except Exception as e:
            log.exception("[%s] Unexpected error in conversion thread", job_id)
            try:
                job_error(job_id, f"Conversion failed: {e}")
            except Exception:
                log.exception("[%s] job_error() itself raised", job_id)
            shutil.rmtree(work_dir, ignore_errors=True)

    Thread(target=_run, daemon=True).start()
    log.info("[%s] Thread dispatched", job_id)
    return {"job_id": job_id}


# ── MRIQC ─────────────────────────────────────────────────────────────────────

@app.post("/run-mriqc")
async def run_mriqc_endpoint(
    bids_zip:          UploadFile = File(...),
    participant_label: str = Form(""),
    modalities:        str = Form("T1w"),
    session_id:        str = Form(""),
    n_procs:           int = Form(36),   # 36 cores × 10 jobs = 360 of 384 CPUs
    mem_gb:            int = Form(128),  # 128 GB  × 10 jobs = 1.28 TB of 1.5 TB RAM
    authorization:     str = Header(None),
):
    if not MRIQC_BIN:
        raise HTTPException(503, "mriqc is not installed in this environment")

    job_id   = str(uuid.uuid4())[:8]
    work_dir = WORK_ROOT / f"mriqc_{job_id}"
    work_dir.mkdir(parents=True)

    # Save upload
    try:
        zip_path = work_dir / "bids.zip"
        with open(zip_path, "wb") as f:
            while chunk := await bids_zip.read(1024 * 1024):
                f.write(chunk)
        log.info("[%s] BIDS upload saved: %d bytes", job_id, zip_path.stat().st_size)
    except Exception as e:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(500, f"Upload failed: {e}")

    # Don't touch the "running" sentinel yet — the job may be queued first.
    job_create(job_id, running=False)

    # Track this submission if the request is from a logged-in user (no-op for guests)
    _mods = modalities.strip() or "T1w"
    _record_submission(_user_from_header(authorization), job_id, "mriqc",
                       f"MRIQC · {_mods}" + (f" · sub-{participant_label}" if participant_label else ""))

    def _run():
        # Mark as running only now, when the compute slot has been granted.
        (_jdir(job_id) / "running").touch()
        log.info("[%s] MRIQC thread started — work_dir=%s", job_id, work_dir)
        try:
            # ── Extract BIDS ZIP ──────────────────────────────────────────────
            bids_dir = work_dir / "bids"
            bids_dir.mkdir(parents=True, exist_ok=True)
            log.info("[%s] Extracting BIDS ZIP → %s", job_id, bids_dir)
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(bids_dir)

            # Flatten one extra directory level if the ZIP had a top-level folder
            entries = list(bids_dir.iterdir())
            if len(entries) == 1 and entries[0].is_dir():
                inner = entries[0]
                for f in inner.iterdir():
                    shutil.move(str(f), str(bids_dir / f.name))
                inner.rmdir()
                log.info("[%s] Flattened BIDS ZIP top-level folder '%s'", job_id, inner.name)

            out_dir    = work_dir / "mriqc_out"
            work_mriqc = work_dir / "mriqc_work"
            out_dir.mkdir(parents=True, exist_ok=True)
            work_mriqc.mkdir(parents=True, exist_ok=True)

            # ── Build mriqc command ───────────────────────────────────────────
            binary = MRIQC_BIN or "mriqc"
            cmd = [
                binary,
                str(bids_dir), str(out_dir),
                "participant",
                "--nprocs", str(n_procs),
                "--mem-gb", str(mem_gb),
                "--work-dir", str(work_mriqc),
                "--no-sub",
                "--verbose-reports",
            ]
            if participant_label:
                cmd += ["--participant-label", participant_label]
            valid_mods = {"T1w", "T2w", "bold", "dwi", "asl"}
            for mod in modalities.split():
                if mod in valid_mods:
                    cmd += ["-m", mod]
            if session_id:
                cmd += ["--session-id", session_id]

            log.info("[%s] Running: %s", job_id, " ".join(cmd))
            r = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=7_200, env=os.environ.copy())
            log.info("[%s] mriqc rc=%d", job_id, r.returncode)
            if r.stderr:
                log.info("[%s] mriqc stderr (last 2000): %s", job_id, r.stderr[-2000:])
            if r.returncode != 0:
                job_error(job_id, f"mriqc failed (exit {r.returncode}):\n{r.stderr[-3000:]}")
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            # ── Package results ───────────────────────────────────────────────
            zip_out = work_dir / "results"
            log.info("[%s] Archiving MRIQC output …", job_id)
            shutil.make_archive(str(zip_out), "zip", root_dir=out_dir)
            label = f"mriqc_{participant_label}" if participant_label else "mriqc_results"
            job_done(job_id, zip_out.with_suffix(".zip"), label)
            shutil.rmtree(work_dir, ignore_errors=True)
            log.info("[%s] MRIQC done ✓", job_id)

        except subprocess.TimeoutExpired:
            log.error("[%s] mriqc timed out after 2 hours", job_id)
            try:
                job_error(job_id, "mriqc timed out after 2 hours")
            except Exception:
                log.exception("[%s] job_error() itself raised", job_id)
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception as e:
            log.exception("[%s] Unexpected error in MRIQC thread", job_id)
            try:
                job_error(job_id, f"MRIQC failed: {e}")
            except Exception:
                log.exception("[%s] job_error() itself raised", job_id)
            shutil.rmtree(work_dir, ignore_errors=True)

    # Wrap _run so the compute slot is released (and the next queued job
    # promoted) when this job finishes — whether it succeeds or fails.
    def _run_and_release():
        try:
            _run()
        finally:
            _q_release(job_id)

    try:
        queued = _q_enqueue(job_id, _run_and_release)
    except ValueError as exc:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(503, str(exc))

    if queued:
        log.info("[%s] MRIQC job queued (pending=%d)", job_id, len(_pending))
    else:
        log.info("[%s] MRIQC thread dispatched immediately", job_id)

    return {"job_id": job_id}


# ══════════════════════════════════════════════════════════════════════════════
# Support — AI chatbot  +  email ticket system
#
# Required env vars:
#   ANTHROPIC_API_KEY  — enables the AI chat assistant (claude-3-5-haiku)
#   SUPPORT_EMAIL      — lab inbox that receives tickets
#   SMTP_HOST          — e.g. smtp.gmail.com
#   SMTP_PORT          — e.g. 587  (TLS)
#   SMTP_USER          — sending Gmail / SMTP address
#   SMTP_PASSWORD      — Gmail App Password (not regular password)
# ══════════════════════════════════════════════════════════════════════════════

import smtplib, textwrap
from email.mime.multipart import MIMEMultipart
from email.mime.text      import MIMEText
from email.mime.base      import MIMEBase
from email                import encoders

_GEMINI_KEY     = os.environ.get("GEMINI_API_KEY",      "")
# Model is overridable via env so you can switch to a newer free model
# without a code change (e.g. gemini-2.5-flash) if Google retires one.
_GEMINI_MODEL   = os.environ.get("GEMINI_MODEL",        "gemini-2.0-flash")
_SUPPORT_EMAIL  = os.environ.get("SUPPORT_EMAIL",       "")
_SMTP_HOST      = os.environ.get("SMTP_HOST",           "smtp.gmail.com")
_SMTP_PORT      = int(os.environ.get("SMTP_PORT",        "587"))
_SMTP_USER      = os.environ.get("SMTP_USER",            "")
_SMTP_PASSWORD  = os.environ.get("SMTP_PASSWORD",        "")

# ── System prompt: MRIQC domain expertise for the chatbot ────────────────────
_CHAT_SYSTEM = textwrap.dedent("""
    You are the WebMRIQC Support Assistant — an expert AI helper for the
    WebMRIQC platform (https://webmriqc.mailab.io), developed by MAILAB
    (Medical Artificial Intelligence Laboratory).

    ## What WebMRIQC does
    WebMRIQC lets neuroimaging researchers:
    • Upload BIDS-formatted datasets or raw DICOM ZIP files
    • Auto-convert DICOM → BIDS with dcm2bids + dcm2niix
    • Run the MRIQC pipeline to compute Image Quality Metrics (IQMs)
    • View results in an interactive dashboard (metric cards, brain figure
      gallery, normative reference comparisons, HTML visual reports)
    • Download the full MRIQC results ZIP
    • Queue system: when the server is busy, jobs wait in a fair queue

    ## Common errors and fixes

    ### Upload / HTTP errors
    • 422 Unprocessable Entity: file is not a valid ZIP, or a required field
      is missing (participant label, modality). Re-check the form.
    • 503 Queue full: server is at capacity. Try again in 1–2 hours.
    • "Upload timed out": file > 2 GB or slow connection. Compress data or
      split into smaller sessions.

    ### DICOM → BIDS conversion errors
    • "dcm2bids failed": DICOMs may be compressed, incomplete, or from an
      unsupported sequence. Check the conversion log in the BIDS ZIP.
    • "No NIfTI files found": the DICOM series did not match any known
      sequence (T1w, T2w, BOLD, DWI, ASL, FLAIR). Verify the SeriesDescription
      in the DICOM header (use dcmdump or MRIcroGL).
    • "dcm2niix not found" / "dcm2bids not found": server config problem
      — submit a support ticket.

    ### MRIQC processing errors
    • "mriqc failed (exit 1)": usually BIDS validation failure. Run
      bids-validator on your dataset before uploading.
    • "No participants found": participant_label doesn't match the sub-XX
      folder in your BIDS dataset. Labels are case-sensitive.
    • "Job timed out after 2 hours": MRIQC ran too long. Try a single
      participant or single session, or reduce the modalities selected.
    • "No metrics found / no TSV": MRIQC completed but produced no IQMs —
      check that the requested modality actually exists in your BIDS data.

    ### BIDS format guidance
    A valid BIDS root must contain:
      dataset_description.json  (required)
      sub-XX/                   (one folder per participant)
        ses-YY/                 (optional session folder)
          anat/                 (T1w, T2w: .nii.gz + .json sidecar)
          func/                 (BOLD: .nii.gz + .json + events.tsv)
          dwi/                  (DWI: .nii.gz + .json + .bvec + .bval)
          perf/                 (ASL: .nii.gz + .json)
    Run `bids-validator` locally first to catch issues before uploading.

    ### IQM interpretation (T1w anatomical)
    CNR  > 2.5 = good  │ tissue contrast vs noise
    SNR  > 15  = good  │ signal vs background noise
    EFC  < 0.5 = good  │ ghosting / blurring (Shannon entropy)
    FBER > 100 = good  │ -1 means not computable (some scanners)
    CJV  < 0.5 = good  │ bias field / tissue inhomogeneity
    INU  < 0.1 = good  │ intensity non-uniformity
    FWHM < 3 mm = good │ spatial smoothness

    ### IQM interpretation (fMRI BOLD)
    tSNR > 40  = good  │ temporal signal stability
    FD   < 0.2 mm = good │ head motion per volume
    DVARS < 1.5 = good │ sudden signal changes (motion spikes)

    ## Reference population
    The dashboard shows a "↑ X%" label — this is how the scan compares to
    33 T1w reference scans from OpenNeuro. 0% means below all references
    (common for clinical 1.5T scanners vs research 3T datasets).

    ## Tips
    • Always keep the browser tab open while a job is processing.
    • The queue ticket (#N) is reserved — the job will start automatically.
    • For large DICOM datasets, zip the DICOM folder (not its parent).
    • If a conversion fails, download the BIDS ZIP — it contains a
      conversion_log.txt with the detailed dcm2bids output.

    ## When to escalate
    If the problem can't be resolved from these guidelines, tell the user
    to submit a ticket via the Contact tab. They should include:
    - The exact error message
    - The scanner make/model and field strength
    - The modality (T1w, BOLD, etc.)
    - The conversion log or error log as an attachment

    Be concise, technically accurate, and friendly. Use bullet points.
    If unsure, say so clearly and suggest submitting a ticket.
""").strip()


# ── AI chat (Google Gemini 1.5 Flash — free tier, no credit card needed) ─────
#
# Free tier limits (as of 2025, via Google AI Studio):
#   15 requests / minute · 1 million tokens / minute · 1 500 requests / day
# That covers thousands of support conversations at zero cost.
# Get a free key at: https://aistudio.google.com/app/apikey

@app.post("/support/chat")
async def support_chat(payload: dict = Body(...)):
    """
    Body: { "messages": [ {"role":"user","content":"..."}, ... ] }
    Returns a text/event-stream SSE stream of JSON chunks:
      data: {"text": "..."}   (partial response)
      data: {"error": "..."}  (problem — shown to the user)
      data: [DONE]            (end of stream)

    Implementation: calls the Gemini REST streaming endpoint directly with
    httpx.  Fully async (no thread/queue bridge) and surfaces BOTH HTTP
    errors (bad key, retired model) AND empty responses — the previous SDK
    version silently swallowed empty completions, so the user saw a blank
    bubble with no explanation.
    """
    if not _GEMINI_KEY:
        raise HTTPException(503, "AI support is not configured — set GEMINI_API_KEY")

    messages = payload.get("messages", [])
    if not messages:
        raise HTTPException(400, "messages array is required")
    messages = messages[-20:]   # clamp history (keeps free-tier tokens low)

    import httpx

    # Build Gemini "contents": user→user, assistant→model.
    contents = []
    for m in messages:
        role = "user" if m.get("role") == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})
    # Gemini requires the first turn to be "user".
    while contents and contents[0]["role"] != "user":
        contents.pop(0)

    body = {
        "system_instruction": {"parts": [{"text": _CHAT_SYSTEM}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.7},
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{_GEMINI_MODEL}:streamGenerateContent?alt=sse&key={_GEMINI_KEY}"
    )

    async def generate():
        got_text = False
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                async with client.stream("POST", url, json=body) as resp:
                    # ── Non-200 → surface the real Gemini error message ──────
                    if resp.status_code != 200:
                        raw = await resp.aread()
                        msg = f"Gemini error {resp.status_code}"
                        try:
                            err = json.loads(raw).get("error", {})
                            msg = err.get("message", msg)
                            # Friendlier hint for the two most common causes
                            if resp.status_code == 404:
                                msg += f"  (model '{_GEMINI_MODEL}' not found — set GEMINI_MODEL to a current model like gemini-2.5-flash)"
                            elif resp.status_code in (400, 403):
                                msg += "  (check your GEMINI_API_KEY is valid)"
                        except Exception:
                            pass
                        log.error("support_chat: %s", msg)
                        yield f"data: {json.dumps({'error': msg})}\n\n"
                        return

                    # ── Stream SSE lines ─────────────────────────────────────
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data:
                            continue
                        try:
                            obj   = json.loads(data)
                            cand  = (obj.get("candidates") or [{}])[0]
                            parts = (cand.get("content") or {}).get("parts") or []
                            text  = "".join(p.get("text", "") for p in parts)
                            if text:
                                got_text = True
                                yield f"data: {json.dumps({'text': text})}\n\n"
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue

            # ── Completed with no text → explain why ─────────────────────────
            if not got_text:
                yield f"data: {json.dumps({'error': 'The AI returned an empty response. The model may be unavailable or the request was blocked. Try again, or set GEMINI_MODEL to a current model (e.g. gemini-2.5-flash).'})}\n\n"
        except Exception as e:
            log.exception("support_chat stream error")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ── Support ticket (email) ────────────────────────────────────────────────────

@app.post("/support/ticket")
async def support_ticket(
    name:        str        = Form(...),
    institution: str        = Form(""),
    email:       str        = Form(...),
    subject:     str        = Form("WebMRIQC Support Request"),
    message:     str        = Form(...),
    attachment:  UploadFile = File(None),
):
    """Send a support ticket email to the lab inbox."""
    if not _SUPPORT_EMAIL:
        raise HTTPException(503, "Email support is not configured on this server")
    if not _SMTP_USER or not _SMTP_PASSWORD:
        raise HTTPException(503, "SMTP credentials not configured")

    # ── Build email ───────────────────────────────────────────────────────────
    msg = MIMEMultipart()
    msg["From"]     = _SMTP_USER
    msg["To"]       = _SUPPORT_EMAIL
    msg["Reply-To"] = email
    msg["Subject"]  = f"[WebMRIQC] {subject}"

    body = textwrap.dedent(f"""
        WebMRIQC Support Ticket
        ══════════════════════════════════════
        Name:        {name}
        Institution: {institution or '—'}
        Email:       {email}
        ──────────────────────────────────────
        {message}
        ══════════════════════════════════════
        Sent via WebMRIQC support form
    """).strip()
    msg.attach(MIMEText(body, "plain"))

    # ── Attach file (optional) ────────────────────────────────────────────────
    if attachment and attachment.filename:
        data = await attachment.read()
        part = MIMEBase("application", "octet-stream")
        part.set_payload(data)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition",
                        f'attachment; filename="{attachment.filename}"')
        msg.attach(part)

    # ── Send ──────────────────────────────────────────────────────────────────
    try:
        with smtplib.SMTP(_SMTP_HOST, _SMTP_PORT, timeout=15) as srv:
            srv.ehlo()
            srv.starttls()
            srv.login(_SMTP_USER, _SMTP_PASSWORD)
            srv.sendmail(_SMTP_USER, _SUPPORT_EMAIL, msg.as_string())
        log.info("Support ticket sent: from=%s subject=%s", email, subject)
    except Exception as e:
        log.exception("Failed to send support ticket")
        raise HTTPException(500, f"Could not send email: {e}")

    return {"sent": True}


# ══════════════════════════════════════════════════════════════════════════════
# User accounts + submission tracking
#
# Dependency-free: stdlib sqlite3 for storage, pbkdf2 for password hashing,
# and a hand-rolled HS256 token (no PyJWT needed).  Guests never touch this —
# accounts are entirely optional.
#
# Env:
#   DATA_DIR     directory for the SQLite DB (default /data — mount a volume!)
#   AUTH_SECRET  HMAC secret for signing tokens. SET THIS in production so
#                tokens survive restarts; if unset a random one is generated
#                each boot (existing logins are invalidated on restart).
# ══════════════════════════════════════════════════════════════════════════════

import sqlite3, hmac, base64, time, secrets
from threading import Lock as _ThreadLock

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    DATA_DIR = JOB_ROOT          # fallback to the already-mounted job volume
_DB_PATH   = DATA_DIR / "webmriqc.db"
_db_lock   = _ThreadLock()

_AUTH_SECRET = os.environ.get("AUTH_SECRET", "") or secrets.token_hex(32)
if not os.environ.get("AUTH_SECRET"):
    log.warning("AUTH_SECRET not set — generated a random one. Logins will "
                "reset on restart. Set AUTH_SECRET in production.")


def _db():
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    with _db_lock, _db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                email       TEXT UNIQUE NOT NULL,
                name        TEXT,
                institution TEXT,
                pw_hash     TEXT NOT NULL,
                pw_salt     TEXT NOT NULL,
                created_at  TEXT NOT NULL
            )""")
        c.execute("""
            CREATE TABLE IF NOT EXISTS submissions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id      TEXT NOT NULL,
                user_id     INTEGER NOT NULL,
                kind        TEXT,
                label       TEXT,
                created_at  TEXT NOT NULL
            )""")
        c.execute("""
            CREATE TABLE IF NOT EXISTS password_resets (
                email       TEXT NOT NULL,
                code_hash   TEXT NOT NULL,
                salt        TEXT NOT NULL,
                expires_at  REAL NOT NULL
            )""")
    log.info("Auth DB ready at %s", _DB_PATH)

_init_db()


# ── Password hashing (pbkdf2-sha256, stdlib) ──────────────────────────────────

def _hash_pw(pw: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000)
    return base64.b64encode(dk).decode(), salt

def _verify_pw(pw: str, stored_hash: str, salt: str) -> bool:
    calc, _ = _hash_pw(pw, salt)
    return hmac.compare_digest(calc, stored_hash)


# ── Minimal signed token (HS256, JWT-compatible) ──────────────────────────────

def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def _b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def _make_token(user_id: int, days: int = 30) -> str:
    header  = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64u(json.dumps({"uid": user_id,
                                "exp": int(time.time()) + days * 86400}).encode())
    sig = hmac.new(_AUTH_SECRET.encode(), f"{header}.{payload}".encode(),
                   hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64u(sig)}"

def _verify_token(token: str):
    try:
        header, payload, sig = token.split(".")
        expect = hmac.new(_AUTH_SECRET.encode(), f"{header}.{payload}".encode(),
                          hashlib.sha256).digest()
        if not hmac.compare_digest(_b64u(expect), sig):
            return None
        data = json.loads(_b64u_dec(payload))
        if data.get("exp", 0) < time.time():
            return None
        return data.get("uid")
    except Exception:
        return None


def _user_public(row) -> dict:
    return {"id": row["id"], "email": row["email"],
            "name": row["name"], "institution": row["institution"]}

def _user_from_header(authorization: str | None):
    """Return the user row for a 'Bearer <token>' header, or None."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    uid = _verify_token(authorization[7:].strip())
    if uid is None:
        return None
    with _db_lock, _db() as c:
        return c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

def _record_submission(user_row, job_id: str, kind: str, label: str):
    """Best-effort: log a submission against a logged-in user (no-op for guests)."""
    if not user_row:
        return
    try:
        with _db_lock, _db() as c:
            c.execute(
                "INSERT INTO submissions (job_id, user_id, kind, label, created_at) "
                "VALUES (?,?,?,?,?)",
                (job_id, user_row["id"], kind, label,
                 datetime.datetime.utcnow().isoformat()),
            )
    except Exception:
        log.exception("Failed to record submission for job %s", job_id)


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/auth/register")
def auth_register(payload: dict = Body(...)):
    email = (payload.get("email") or "").strip().lower()
    pw    = payload.get("password") or ""
    name  = (payload.get("name") or "").strip()
    inst  = (payload.get("institution") or "").strip()

    if "@" not in email or "." not in email:
        raise HTTPException(400, "Please enter a valid email address")
    if len(pw) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")

    pw_hash, pw_salt = _hash_pw(pw)
    try:
        with _db_lock, _db() as c:
            cur = c.execute(
                "INSERT INTO users (email, name, institution, pw_hash, pw_salt, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (email, name, inst, pw_hash, pw_salt,
                 datetime.datetime.utcnow().isoformat()),
            )
            uid = cur.lastrowid
            row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "An account with that email already exists")

    return {"token": _make_token(uid), "user": _user_public(row)}


@app.post("/auth/login")
def auth_login(payload: dict = Body(...)):
    email = (payload.get("email") or "").strip().lower()
    pw    = payload.get("password") or ""
    with _db_lock, _db() as c:
        row = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not row or not _verify_pw(pw, row["pw_hash"], row["pw_salt"]):
        raise HTTPException(401, "Incorrect email or password")
    return {"token": _make_token(row["id"]), "user": _user_public(row)}


@app.get("/auth/me")
def auth_me(authorization: str = Header(None)):
    row = _user_from_header(authorization)
    if not row:
        raise HTTPException(401, "Not authenticated")
    return {"user": _user_public(row)}


@app.get("/auth/submissions")
def auth_submissions(authorization: str = Header(None)):
    row = _user_from_header(authorization)
    if not row:
        raise HTTPException(401, "Not authenticated")
    with _db_lock, _db() as c:
        subs = c.execute(
            "SELECT job_id, kind, label, created_at FROM submissions "
            "WHERE user_id=? ORDER BY id DESC LIMIT 200", (row["id"],),
        ).fetchall()
    # Attach the live status from the filesystem job store / queue.
    out = []
    for s in subs:
        live = _q_status(s["job_id"]) or job_status(s["job_id"]) or {"status": "expired"}
        out.append({
            "job_id":     s["job_id"],
            "kind":       s["kind"],
            "label":      s["label"],
            "created_at": s["created_at"],
            "status":     live.get("status", "unknown"),
            "queue_position": live.get("queue_position"),
        })
    return {"submissions": out}


# ── Password reset ────────────────────────────────────────────────────────────

def _send_email(to_addr: str, subject: str, body_text: str) -> bool:
    """Send a plain-text email via the configured SMTP relay. Returns False
    (without raising) if SMTP isn't configured, so callers can degrade."""
    if not _SMTP_USER or not _SMTP_PASSWORD:
        return False
    msg = MIMEMultipart()
    msg["From"]    = _SMTP_USER
    msg["To"]      = to_addr
    msg["Subject"] = subject
    msg.attach(MIMEText(body_text, "plain"))
    with smtplib.SMTP(_SMTP_HOST, _SMTP_PORT, timeout=15) as srv:
        srv.ehlo(); srv.starttls()
        srv.login(_SMTP_USER, _SMTP_PASSWORD)
        srv.sendmail(_SMTP_USER, to_addr, msg.as_string())
    return True


@app.post("/auth/forgot-password")
def auth_forgot_password(payload: dict = Body(...)):
    """
    Begin a password reset: email a 6-digit code that expires in 15 minutes.
    Always returns success so attackers can't enumerate which emails exist.
    """
    email = (payload.get("email") or "").strip().lower()
    GENERIC = {"ok": True,
               "message": "If an account exists for that email, a reset code has been sent."}
    if "@" not in email:
        return GENERIC

    with _db_lock, _db() as c:
        user = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if not user:
        return GENERIC          # don't reveal non-existence

    code             = f"{secrets.randbelow(1_000_000):06d}"     # 6-digit
    code_hash, salt  = _hash_pw(code)                            # never store plaintext
    expires          = time.time() + 15 * 60

    with _db_lock, _db() as c:
        c.execute("DELETE FROM password_resets WHERE email=?", (email,))   # invalidate old codes
        c.execute("INSERT INTO password_resets (email, code_hash, salt, expires_at) "
                  "VALUES (?,?,?,?)", (email, code_hash, salt, expires))

    subject = "Your WebMRIQC password reset code"
    body = textwrap.dedent(f"""
        You requested a password reset for your WebMRIQC account.

        Your reset code is:  {code}

        This code expires in 15 minutes. If you didn't request this, you can
        safely ignore this email — your password will not change.

        — WebMRIQC
    """).strip()

    try:
        sent = _send_email(email, subject, body)
    except Exception:
        log.exception("forgot-password: email send failed")
        sent = False

    if not sent:
        # SMTP not configured (or failed) — log the code so testing still works.
        # In production with SMTP set, the code is emailed and never logged.
        log.warning("[forgot-password] code for %s: %s", email, code)

    return GENERIC


@app.post("/auth/reset-password")
def auth_reset_password(payload: dict = Body(...)):
    """Complete a reset: verify the emailed code, then set the new password."""
    email = (payload.get("email") or "").strip().lower()
    code  = (payload.get("code") or "").strip()
    newpw = payload.get("password") or ""

    if len(newpw) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")

    with _db_lock, _db() as c:
        row = c.execute(
            "SELECT * FROM password_resets WHERE email=? ORDER BY expires_at DESC LIMIT 1",
            (email,),
        ).fetchone()

    if not row or row["expires_at"] < time.time() or not _verify_pw(code, row["code_hash"], row["salt"]):
        raise HTTPException(400, "Invalid or expired reset code")

    pw_hash, pw_salt = _hash_pw(newpw)
    with _db_lock, _db() as c:
        c.execute("UPDATE users SET pw_hash=?, pw_salt=? WHERE email=?",
                  (pw_hash, pw_salt, email))
        c.execute("DELETE FROM password_resets WHERE email=?", (email,))   # one-time use

    log.info("Password reset completed for %s", email)
    return {"ok": True, "message": "Your password has been reset. You can now sign in."}


# ══════════════════════════════════════════════════════════════════════════════
# Serve the React build  (must be last — catch-all)
# ══════════════════════════════════════════════════════════════════════════════
DIST = Path(__file__).parent / "dist"
if DIST.exists():
    # Mount the Vite asset bundle (hashed JS/CSS).
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        # Serve any file that exists verbatim in dist/ (brain.obj, favicon.svg,
        # etc.) — this is what the original catch-all missed, causing the browser
        # to receive index.html instead of the OBJ file.
        candidate = DIST / full_path
        if full_path and candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        # All unknown paths → SPA index so React Router can handle them.
        return FileResponse(str(DIST / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
