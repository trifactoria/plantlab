"""Durable capture spool - Part 9 of the Pi Zero edge-agent task.

Mirrors src/lib/operations/agentSpool.ts's design and directory layout
(``pending/uploading/acknowledged/failed`` + a small sqlite state db) using
Python's stdlib ``sqlite3`` instead of Node's ``node:sqlite``. A capture is
written to disk and recorded in the db *before* any network call is
attempted - it survives an agent restart or power loss because both the
file and its bookkeeping row exist on disk at that point, independent of
whatever happens next.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

STATES = ("pending", "uploading", "acknowledged", "failed")

# Exponential backoff for retrying a failed upload - matches the intent of
# agentSpool.ts's retry model. Capped so a long-offline node doesn't wait
# unboundedly long once connectivity returns.
BASE_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 30 * 60
MAX_ATTEMPTS_BEFORE_MAX_BACKOFF = 6


@dataclass
class SpoolRecord:
    job_id: str
    capture_id: str
    assignment_id: str
    capture_source_id: str
    local_file_path: str
    captured_at: str
    sha256: str
    byte_size: int
    attempt_count: int
    next_retry_at: Optional[str]
    last_error: Optional[str]
    state: str


class Spool:
    def __init__(self, root: str, max_spool_bytes: int = 512 * 1024 * 1024):
        self.root = Path(root)
        self.max_spool_bytes = max_spool_bytes
        self._db: Optional[sqlite3.Connection] = None

    def init(self) -> None:
        for state in STATES:
            self.dir(state).mkdir(parents=True, exist_ok=True)
        self.dir("logs").mkdir(parents=True, exist_ok=True)

        self._db = sqlite3.connect(str(self.root / "state.sqlite"))
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS spool_records (
                jobId TEXT PRIMARY KEY,
                captureId TEXT NOT NULL UNIQUE,
                assignmentId TEXT NOT NULL,
                captureSourceId TEXT NOT NULL,
                localFilePath TEXT NOT NULL,
                capturedAt TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                byteSize INTEGER NOT NULL,
                attemptCount INTEGER NOT NULL DEFAULT 0,
                nextRetryAt TEXT,
                lastError TEXT,
                state TEXT NOT NULL
            )
            """
        )
        self._db.execute("CREATE INDEX IF NOT EXISTS spool_records_state_nextRetryAt_idx ON spool_records(state, nextRetryAt)")
        self._db.commit()

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    def dir(self, name: str) -> Path:
        return self.root / ("logs" if name == "logs" else "spool" / Path(name))

    def pending_path(self, capture_id: str) -> str:
        return str(self.dir("pending") / f"{capture_id}.jpg")

    def spool_size_bytes(self) -> int:
        total = 0
        for state in STATES:
            d = self.dir(state)
            if d.exists():
                for entry in d.iterdir():
                    if entry.is_file():
                        total += entry.stat().st_size
        return total

    def has_room_for(self, estimated_bytes: int) -> bool:
        """Part 14 "cap upload and spool size" - a bounded disk-usage guard checked before capturing a new frame, not just cleaned up after the fact."""
        return self.spool_size_bytes() + estimated_bytes <= self.max_spool_bytes

    def record_captured(
        self,
        job_id: str,
        capture_id: str,
        assignment_id: str,
        capture_source_id: str,
        local_file_path: str,
        captured_at: str,
    ) -> None:
        sha256 = _sha256_file(local_file_path)
        byte_size = os.path.getsize(local_file_path)
        assert self._db is not None
        self._db.execute(
            """
            INSERT INTO spool_records
              (jobId, captureId, assignmentId, captureSourceId, localFilePath, capturedAt, sha256, byteSize, attemptCount, nextRetryAt, lastError, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 'pending')
            """,
            (job_id, capture_id, assignment_id, capture_source_id, local_file_path, captured_at, sha256, byte_size),
        )
        self._db.commit()

    def due_uploads(self) -> List[SpoolRecord]:
        """Pending records, plus failed records whose backoff window has elapsed."""
        assert self._db is not None
        now = _now_iso()
        rows = self._db.execute(
            """
            SELECT jobId, captureId, assignmentId, captureSourceId, localFilePath, capturedAt, sha256, byteSize, attemptCount, nextRetryAt, lastError, state
            FROM spool_records
            WHERE state = 'pending' OR (state = 'failed' AND (nextRetryAt IS NULL OR nextRetryAt <= ?))
            ORDER BY capturedAt ASC
            """,
            (now,),
        ).fetchall()
        return [SpoolRecord(*row) for row in rows]

    def move_file_for_state(self, record: SpoolRecord, new_state: str) -> SpoolRecord:
        old_path = Path(record.local_file_path)
        new_path = self.dir(new_state) / old_path.name
        if old_path.exists():
            shutil.move(str(old_path), str(new_path))
        assert self._db is not None
        self._db.execute("UPDATE spool_records SET state = ?, localFilePath = ? WHERE jobId = ?", (new_state, str(new_path), record.job_id))
        self._db.commit()
        record.state = new_state
        record.local_file_path = str(new_path)
        return record

    def mark_acknowledged(self, job_id: str) -> None:
        assert self._db is not None
        self._db.execute("UPDATE spool_records SET state = 'acknowledged', lastError = NULL WHERE jobId = ?", (job_id,))
        self._db.commit()

    def mark_failed(self, job_id: str, error_message: str) -> None:
        assert self._db is not None
        row = self._db.execute("SELECT attemptCount FROM spool_records WHERE jobId = ?", (job_id,)).fetchone()
        attempt_count = (row[0] if row else 0) + 1
        backoff = min(BASE_BACKOFF_SECONDS * (2 ** min(attempt_count, MAX_ATTEMPTS_BEFORE_MAX_BACKOFF)), MAX_BACKOFF_SECONDS)
        next_retry_at = _iso_from_epoch(time.time() + backoff)
        self._db.execute(
            "UPDATE spool_records SET state = 'failed', attemptCount = ?, nextRetryAt = ?, lastError = ? WHERE jobId = ?",
            (attempt_count, next_retry_at, error_message[:2000], job_id),
        )
        self._db.commit()

    def cleanup_acknowledged(self, retain_seconds: int) -> int:
        """Deletes acknowledged files/rows older than the retention window - never before acknowledgment, matching Part 9 "delete only after acknowledgment and retention period"."""
        assert self._db is not None
        cutoff = _iso_from_epoch(time.time() - retain_seconds)
        rows = self._db.execute(
            "SELECT jobId, localFilePath FROM spool_records WHERE state = 'acknowledged' AND capturedAt <= ?",
            (cutoff,),
        ).fetchall()
        removed = 0
        for job_id, local_file_path in rows:
            path = Path(local_file_path)
            if path.exists():
                path.unlink(missing_ok=True)
            self._db.execute("DELETE FROM spool_records WHERE jobId = ?", (job_id,))
            removed += 1
        self._db.commit()
        return removed


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _now_iso() -> str:
    return _iso_from_epoch(time.time())


def _iso_from_epoch(epoch_seconds: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_seconds))
