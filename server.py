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

import json, os, uuid, shutil, zipfile, logging, datetime, subprocess
from pathlib import Path
from threading import Thread

# ── Make locally-downloaded binaries (Render test deployment) findable ────────
_local_bin = Path(__file__).parent / 'bin'
if _local_bin.exists():
    os.environ['PATH'] = f"{_local_bin}:{os.environ.get('PATH', '')}"

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger("webmriqc")

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


def _jdir(job_id: str) -> Path:
    return JOB_ROOT / job_id

def job_create(job_id: str):
    _jdir(job_id).mkdir(parents=True, exist_ok=True)
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

def generate_dcm2bids_config(temp_dir: Path) -> Path:
    config = {
        "descriptions": [
            {"datatype": "anat",  "suffix": "T1w",
             "criteria": {"SeriesDescription": "*T1*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERMANY|OTHER).*"]},
             "sidecar_changes": {"ProtocolName": "T1w"}},
            {"datatype": "anat",  "suffix": "T2w",
             "criteria": {"SeriesDescription": "*T2*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERMANY).*"]},
             "sidecar_changes": {"ProtocolName": "T2w"}},
            {"datatype": "anat",  "suffix": "FLAIR",
             "criteria": {"SeriesDescription": "*FLAIR*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERMANY).*"]}},
            {"datatype": "func",  "suffix": "bold",
             "criteria": {"SeriesDescription": "*BOLD*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|FMRI|OTHER).*"]},
             "sidecar_changes": {"TaskName": "rest"}},
            {"datatype": "func",  "suffix": "sbref",
             "criteria": {"SeriesDescription": "*SBRef*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|FMRI|OTHER).*"]}},
            {"datatype": "dwi",   "suffix": "dwi",
             "criteria": {"SeriesDescription": "*DWI*|*DTI*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|DIFFUSION).*"]},
             "sidecar_changes": {"PhaseEncodingDirection": "j", "TotalReadoutTime": 0.028}},
            {"datatype": "fmap",  "suffix": "phasediff",
             "criteria": {"SeriesDescription": "*FMRI_DISTORTION*",
                          "ImageType": ["ORIGINAL", "(?i).*(P|PHASE).*"]}},
            {"datatype": "fmap",  "suffix": "magnitude",
             "criteria": {"SeriesDescription": "*FMRI_DISTORTION*",
                          "ImageType": ["ORIGINAL", "(?i).*(M|MAG).*"]}},
            {"datatype": "perf",  "suffix": "asl",
             "criteria": {"SeriesDescription": "*ASL*|*Perfusion*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERFUSION).*"]}},
            {"datatype": "func",  "suffix": "bold",
             "criteria": {"SeriesDescription": "*Nback*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|FMRI).*"]},
             "sidecar_changes": {"TaskName": "nback"}},
            {"datatype": "anat",  "suffix": "MESE",
             "criteria": {"SeriesDescription": "*MultiEcho*",
                          "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|MULTIECHO).*"]}},
        ],
        "default_entities": {"subject": "{subject}", "session": "{session}"},
    }
    p = temp_dir / "dcm2bids_config.json"
    p.write_text(json.dumps(config, indent=2))
    return p


def run_dcm2bids(dicom_dir: Path, bids_out: Path,
                 subj_id: str, ses_id: str, config_file: Path) -> str:
    cmd = ["dcm2bids", "-d", str(dicom_dir), "-p", subj_id,
           "-c", str(config_file), "-o", str(bids_out)]
    if ses_id:
        cmd += ["-s", ses_id]
    log.info("CMD: %s", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = f"CMD: {' '.join(cmd)}\n\n{r.stdout}\n{r.stderr}".strip()
    if r.returncode != 0:
        raise RuntimeError(f"dcm2bids failed (exit {r.returncode}):\n{r.stderr[-3000:]}")
    return out


def classify_and_move_original_files(bids_out: Path, subj_id: str, ses_id: str):
    tmp_root = bids_out / "tmp_dcm2bids"
    if not tmp_root.exists():
        return
    candidates = [
        tmp_root / f"sub-{subj_id}_ses-{ses_id}",
        tmp_root / f"sub-{subj_id}",
        tmp_root,
    ]
    tmp_folder = next(
        (p for p in candidates if p.exists() and any(p.rglob("*.json"))),
        tmp_root,
    )
    ses_dir = bids_out / f"sub-{subj_id}" / (f"ses-{ses_id}" if ses_id else "")
    ses_dir.mkdir(parents=True, exist_ok=True)
    modality_paths = {
        "anat": ses_dir / "anat", "dwi": ses_dir / "dwi",
        "func": ses_dir / "func", "perf": ses_dir / "perf",
    }
    for json_file in tmp_folder.rglob("*.json"):
        try:
            meta = json.loads(json_file.read_text())
        except Exception:
            continue
        image_type = meta.get("ImageType", [])
        if isinstance(image_type, str):
            image_type = [image_type]
        if not any("original" in t.lower() for t in image_type):
            continue
        desc  = (meta.get("SeriesDescription", "") + " " + meta.get("ProtocolName", "")).lower()
        pulse = meta.get("PulseSequenceName", "").lower()
        if   "t1" in desc and "flair" not in desc:               modality, suffix = "anat", "T1w"
        elif "t2" in desc:                                        modality, suffix = "anat", "T2w"
        elif "flair" in desc or "fluid" in desc:                  modality, suffix = "anat", "FLAIR"
        elif "dwi"  in desc or "dti" in desc:                    modality, suffix = "dwi",  "dwi"
        elif any(k in desc for k in ("bold","fmri","functional")) or "epi" in pulse:
                                                                  modality, suffix = "func", "bold"
        elif "asl" in desc or "perfusion" in desc:               modality, suffix = "perf", "asl"
        else:
            continue
        nii = json_file.with_suffix(".nii.gz")
        if not nii.exists():
            nii = json_file.with_suffix(".nii")
        if not nii.exists():
            continue
        tgt = modality_paths[modality]
        tgt.mkdir(parents=True, exist_ok=True)
        base = f"sub-{subj_id}" + (f"_ses-{ses_id}" if ses_id else "") + f"_{suffix}"
        shutil.move(str(json_file), str(tgt / f"{base}.json"))
        shutil.move(str(nii),       str(tgt / f"{base}.nii.gz"))
    shutil.rmtree(tmp_root, ignore_errors=True)


def create_bids_top_level_files(bids_dir: Path, subject_id: str):
    dd = bids_dir / "dataset_description.json"
    if not dd.exists():
        dd.write_text(json.dumps({
            "Name": "MRIQC Dataset", "BIDSVersion": "1.6.0", "License": "CC0",
            "Authors": ["Philip Nkwam", "Udunna Anazodo", "Maruf Adewole", "Sekinat Aderibigbe"],
            "DatasetType": "raw",
        }, indent=2))
    (bids_dir / "README").write_text("# BIDS Dataset\nGenerated by WebMRIQC.\n")
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
        "ok": True,
        "dcm2bids": shutil.which("dcm2bids") is not None,
        "dcm2niix": shutil.which("dcm2niix") is not None,
        "mriqc":    shutil.which("mriqc")    is not None,
    }


# ── Job status + download ─────────────────────────────────────────────────────

@app.get("/job/{job_id}")
def get_job_status(job_id: str):
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
):
    participant_label = participant_label.strip()
    if not participant_label or not participant_label.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400, "Participant label must be alphanumeric")

    job_id   = str(uuid.uuid4())[:8]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True)

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
        try:
            # Extract
            dicom_dir = work_dir / "dicoms"
            dicom_dir.mkdir()
            try:
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(dicom_dir)
            except zipfile.BadZipFile:
                job_error(job_id, "Uploaded file is not a valid ZIP")
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            # Convert
            bids_out    = work_dir / "bids"
            bids_out.mkdir()
            config_file = generate_dcm2bids_config(work_dir)
            try:
                conv_log = run_dcm2bids(dicom_dir, bids_out, participant_label, session_id, config_file)
            except FileNotFoundError:
                job_error(job_id, "dcm2bids not found. Is it installed in this environment?")
                shutil.rmtree(work_dir, ignore_errors=True)
                return
            except RuntimeError as e:
                job_error(job_id, str(e))
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            # Organise
            classify_and_move_original_files(bids_out, participant_label, session_id)
            create_bids_top_level_files(bids_out, participant_label)
            (bids_out / "conversion_log.txt").write_text(conv_log)

            # Package
            zip_out = work_dir / "bids_output"
            shutil.make_archive(str(zip_out), "zip", root_dir=bids_out)
            job_done(job_id, zip_out.with_suffix(".zip"), f"bids_sub-{participant_label}")
        except Exception as e:
            log.exception("[%s] Unexpected error in conversion thread", job_id)
            job_error(job_id, f"Conversion failed: {e}")
            shutil.rmtree(work_dir, ignore_errors=True)

    Thread(target=_run, daemon=True).start()
    return {"job_id": job_id}


# ── MRIQC ─────────────────────────────────────────────────────────────────────

@app.post("/run-mriqc")
async def run_mriqc_endpoint(
    bids_zip:          UploadFile = File(...),
    participant_label: str = Form(""),
    modalities:        str = Form("T1w"),
    session_id:        str = Form(""),
    n_procs:           int = Form(4),
    mem_gb:            int = Form(8),
):
    if not shutil.which("mriqc"):
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

    job_create(job_id)

    def _run():
        try:
            # Extract BIDS ZIP
            bids_dir = work_dir / "bids"
            bids_dir.mkdir()
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(bids_dir)

            out_dir    = work_dir / "mriqc_out"
            work_mriqc = work_dir / "mriqc_work"
            out_dir.mkdir(); work_mriqc.mkdir()

            # Build mriqc command
            cmd = [
                "mriqc",
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
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=7_200)
            log.info("[%s] mriqc rc=%d", job_id, r.returncode)
            if r.returncode != 0:
                job_error(job_id, f"mriqc failed (exit {r.returncode}):\n{r.stderr[-3000:]}")
                shutil.rmtree(work_dir, ignore_errors=True)
                return

            # Package results
            zip_out = work_dir / "results"
            shutil.make_archive(str(zip_out), "zip", root_dir=out_dir)
            label = f"mriqc_{participant_label}" if participant_label else "mriqc_results"
            job_done(job_id, zip_out.with_suffix(".zip"), label)
        except subprocess.TimeoutExpired:
            job_error(job_id, "mriqc timed out after 2 hours")
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception as e:
            log.exception("[%s] Unexpected error in MRIQC thread", job_id)
            job_error(job_id, f"MRIQC failed: {e}")
            shutil.rmtree(work_dir, ignore_errors=True)

    Thread(target=_run, daemon=True).start()
    return {"job_id": job_id}


# ══════════════════════════════════════════════════════════════════════════════
# Serve the React build  (must be last — catch-all)
# ══════════════════════════════════════════════════════════════════════════════
DIST = Path(__file__).parent / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        return FileResponse(str(DIST / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
