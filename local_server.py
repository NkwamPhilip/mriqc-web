"""
Local DICOM → BIDS conversion server.
Runs dcm2bids on your machine — no data leaves your computer.

Requirements:
  pip install fastapi uvicorn python-multipart
  # dcm2bids and dcm2niix must be on your PATH

Start:
  uvicorn local_server:app --port 8000

Then open the React app (npm run dev) at http://localhost:3000
"""
import json
import uuid
import shutil
import zipfile
import logging
import datetime
import subprocess
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger("local-bids")

app = FastAPI(title="Local DICOM→BIDS Converter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORK_ROOT = Path("/tmp/mriqc_local")
WORK_ROOT.mkdir(parents=True, exist_ok=True)


# ── Conversion helpers — adapted directly from stream.py ─────────────────────

def generate_dcm2bids_config(temp_dir: Path) -> Path:
    config = {
        "descriptions": [
            {
                "datatype": "anat", "suffix": "T1w",
                "criteria": {"SeriesDescription": "*T1*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERMANY|OTHER).*"]},
                "sidecar_changes": {"ProtocolName": "T1w"},
            },
            {
                "datatype": "anat", "suffix": "T2w",
                "criteria": {"SeriesDescription": "*T2*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERMANY).*"]},
                "sidecar_changes": {"ProtocolName": "T2w"},
            },
            {
                "datatype": "anat", "suffix": "FLAIR",
                "criteria": {"SeriesDescription": "*FLAIR*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERMANY).*"]},
            },
            {
                "datatype": "func", "suffix": "bold",
                "criteria": {"SeriesDescription": "*BOLD*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|FMRI|OTHER).*"]},
                "sidecar_changes": {"TaskName": "rest"},
            },
            {
                "datatype": "func", "suffix": "sbref",
                "criteria": {"SeriesDescription": "*SBRef*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|FMRI|OTHER).*"]},
            },
            {
                "datatype": "dwi", "suffix": "dwi",
                "criteria": {"SeriesDescription": "*DWI*|*DTI*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|DIFFUSION).*"]},
                "sidecar_changes": {"PhaseEncodingDirection": "j", "TotalReadoutTime": 0.028},
            },
            {
                "datatype": "fmap", "suffix": "phasediff",
                "criteria": {"SeriesDescription": "*FMRI_DISTORTION*",
                             "ImageType": ["ORIGINAL", "(?i).*(P|PHASE).*"]},
            },
            {
                "datatype": "fmap", "suffix": "magnitude",
                "criteria": {"SeriesDescription": "*FMRI_DISTORTION*",
                             "ImageType": ["ORIGINAL", "(?i).*(M|MAG).*"]},
            },
            {
                "datatype": "perf", "suffix": "asl",
                "criteria": {"SeriesDescription": "*ASL*|*Perfusion*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|PERFUSION).*"]},
            },
            {
                "datatype": "func", "suffix": "bold",
                "criteria": {"SeriesDescription": "*Nback*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|FMRI).*"]},
                "sidecar_changes": {"TaskName": "nback"},
            },
            {
                "datatype": "anat", "suffix": "MESE",
                "criteria": {"SeriesDescription": "*MultiEcho*",
                             "ImageType": ["ORIGINAL", "(?i).*(PRIMARY|MULTIECHO).*"]},
            },
        ],
        "default_entities": {"subject": "{subject}", "session": "{session}"},
    }
    config_file = temp_dir / "dcm2bids_config.json"
    config_file.write_text(json.dumps(config, indent=2))
    return config_file


def run_dcm2bids(dicom_dir: Path, bids_out: Path, subj_id: str, ses_id: str, config_file: Path) -> str:
    """Run dcm2bids subprocess; return combined stdout+stderr log."""
    cmd = ["dcm2bids", "-d", str(dicom_dir), "-p", subj_id,
           "-c", str(config_file), "-o", str(bids_out)]
    if ses_id:
        cmd += ["-s", ses_id]
    log.info("CMD: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    output = f"CMD: {' '.join(cmd)}\n\n{result.stdout}\n{result.stderr}".strip()
    if result.returncode != 0:
        log.error("dcm2bids failed (rc=%d):\n%s", result.returncode, result.stderr)
        raise RuntimeError(f"dcm2bids failed (exit {result.returncode}):\n{result.stderr[-3000:]}")
    return output


def classify_and_move_original_files(bids_out: Path, subj_id: str, ses_id: str):
    """Move ORIGINAL NIfTI+JSON pairs from tmp_dcm2bids into proper BIDS folders."""
    tmp_root = bids_out / "tmp_dcm2bids"
    if not tmp_root.exists():
        return

    # dcm2bids may name the subfolder differently depending on version / session
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
        "anat": ses_dir / "anat",
        "dwi":  ses_dir / "dwi",
        "func": ses_dir / "func",
        "perf": ses_dir / "perf",
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
            log.info("Skip derived: %s", json_file.name)
            continue

        desc = (meta.get("SeriesDescription", "") + " " +
                meta.get("ProtocolName", "")).lower()
        pulse = meta.get("PulseSequenceName", "").lower()

        if "t1" in desc and "flair" not in desc:
            modality, suffix = "anat", "T1w"
        elif "t2" in desc:
            modality, suffix = "anat", "T2w"
        elif "flair" in desc or "fluid" in desc:
            modality, suffix = "anat", "FLAIR"
        elif "dwi" in desc or "dti" in desc:
            modality, suffix = "dwi", "dwi"
        elif any(k in desc for k in ("bold", "fmri", "functional", "activation")) or "epi" in pulse:
            modality, suffix = "func", "bold"
        elif "asl" in desc or "perfusion" in desc:
            modality, suffix = "perf", "asl"
        else:
            log.info("Unclassified: %s", json_file.name)
            continue

        nii = json_file.with_suffix(".nii.gz")
        if not nii.exists():
            nii = json_file.with_suffix(".nii")
        if not nii.exists():
            log.warning("No NIfTI for %s — skipping", json_file.name)
            continue

        target = modality_paths[modality]
        target.mkdir(parents=True, exist_ok=True)
        base = f"sub-{subj_id}" + (f"_ses-{ses_id}" if ses_id else "") + f"_{suffix}"
        shutil.move(str(json_file), str(target / f"{base}.json"))
        shutil.move(str(nii), str(target / f"{base}.nii.gz"))
        log.info("Moved %s → %s/", base, modality)

    shutil.rmtree(tmp_root, ignore_errors=True)


def create_bids_top_level_files(bids_dir: Path, subject_id: str):
    dd = bids_dir / "dataset_description.json"
    if not dd.exists():
        dd.write_text(json.dumps({
            "Name": "MRIQC Dataset",
            "BIDSVersion": "1.6.0",
            "License": "CC0",
            "Authors": ["Philip Nkwam", "Udunna Anazodo", "Maruf Adewole", "Sekinat Aderibigbe"],
            "DatasetType": "raw",
        }, indent=2))

    readme = bids_dir / "README"
    if not readme.exists():
        readme.write_text("# BIDS Dataset\nGenerated by WebMRIQC local converter.\n")

    changes = bids_dir / "CHANGES"
    if not changes.exists():
        changes.write_text(f"1.0.0 {datetime.date.today()}\n  - Initial BIDS conversion\n")

    pts_tsv = bids_dir / "participants.tsv"
    if not pts_tsv.exists():
        pts_tsv.write_text(f"participant_id\tage\tsex\nsub-{subject_id}\tN/A\tN/A\n")

    pts_json = bids_dir / "participants.json"
    if not pts_json.exists():
        pts_json.write_text(json.dumps({
            "participant_id": {"Description": "Unique participant ID"},
            "age": {"Description": "Age in years"},
            "sex": {"Description": "Biological sex"},
        }, indent=2))


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "ok": True,
        "dcm2bids": shutil.which("dcm2bids") is not None,
        "dcm2niix": shutil.which("dcm2niix") is not None,
    }


@app.post("/convert-dicom")
async def convert_dicom(
    background_tasks: BackgroundTasks,
    dicom_zip: UploadFile = File(...),
    participant_label: str = Form("01"),
    session_id: str = Form(""),
):
    participant_label = participant_label.strip()
    if not participant_label or not participant_label.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400, "Participant label must be alphanumeric")

    job_id = str(uuid.uuid4())[:8]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True)

    try:
        # 1. Save uploaded ZIP
        zip_path = work_dir / "dicoms.zip"
        with open(zip_path, "wb") as f:
            while chunk := await dicom_zip.read(1024 * 1024):
                f.write(chunk)
        log.info("[%s] Saved upload: %s bytes", job_id, zip_path.stat().st_size)

        # 2. Extract DICOMs
        dicom_dir = work_dir / "dicoms"
        dicom_dir.mkdir()
        try:
            with zipfile.ZipFile(zip_path) as zf:
                log.info("[%s] ZIP has %d entries", job_id, len(zf.namelist()))
                zf.extractall(dicom_dir)
        except zipfile.BadZipFile:
            raise HTTPException(400, "Uploaded file is not a valid ZIP")

        # 3. Run dcm2bids (stream.py logic)
        bids_out = work_dir / "bids"
        bids_out.mkdir()
        config_file = generate_dcm2bids_config(work_dir)

        try:
            conv_log = run_dcm2bids(dicom_dir, bids_out, participant_label, session_id, config_file)
        except FileNotFoundError:
            raise HTTPException(500,
                "dcm2bids not found. Install it with:\n  pip install dcm2bids\n"
                "and ensure dcm2niix is also on your PATH."
            )
        except RuntimeError as e:
            raise HTTPException(500, str(e))

        # 4. Organise files (stream.py logic)
        classify_and_move_original_files(bids_out, participant_label, session_id)
        create_bids_top_level_files(bids_out, participant_label)

        # 5. Write log so frontend can display it in the BIDS tree panel
        (bids_out / "conversion_log.txt").write_text(conv_log)

        # 6. Zip and return
        zip_out = work_dir / "bids_output"
        shutil.make_archive(str(zip_out), "zip", root_dir=bids_out)
        zip_out_path = work_dir / "bids_output.zip"
        log.info("[%s] Done — %s bytes", job_id, zip_out_path.stat().st_size)

        background_tasks.add_task(shutil.rmtree, str(work_dir), True)
        return FileResponse(
            str(zip_out_path),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=bids_sub-{participant_label}.zip"},
        )

    except HTTPException:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(work_dir, ignore_errors=True)
        log.exception("[%s] Unexpected error", job_id)
        raise HTTPException(500, f"Conversion failed: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("local_server:app", host="0.0.0.0", port=8000, reload=False)
