from __future__ import annotations

import importlib
import importlib.metadata as metadata
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

KASA_REPOSITORY_URL = "https://github.com/python-kasa/python-kasa.git"
KASA_COMMIT = "8b1f6b8c40588584f5d89df37e4610e2ece9a8cb"
KASA_SPEC = f"python-kasa @ git+{KASA_REPOSITORY_URL}@{KASA_COMMIT}"

KASA_PIN_READY = "ready"
KASA_PIN_MISSING = "missing"
KASA_PIN_WRONG_SOURCE = "wrong-source"
KASA_PIN_WRONG_COMMIT = "wrong-commit"
KASA_PIN_BROKEN = "broken"
KASA_PIN_UNKNOWN = "unknown"


@dataclass(frozen=True)
class KasaPinStatus:
    status: str
    import_ready: bool
    import_path: str | None
    version: str | None
    source_type: str
    repository: str | None
    commit: str | None
    direct_url_path: str | None
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def edge_python_info() -> dict[str, Any]:
    return {
        "executable": sys.executable,
        "prefix": sys.prefix,
        "basePrefix": sys.base_prefix,
        "venvPath": sys.prefix if sys.prefix != sys.base_prefix else None,
        "version": sys.version.split()[0],
        "versionInfo": list(sys.version_info[:3]),
        "platform": sys.platform,
    }


def inspect_imports() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for module_name in ("pigpio", "aiohttp", "cffi", "cryptography", "kasa"):
        result.append(_inspect_import(module_name))
    return result


def _inspect_import(module_name: str) -> dict[str, Any]:
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:
        return {"module": module_name, "ok": False, "error": _safe_exception(exc)}
    version = getattr(module, "__version__", None)
    if version is None:
        try:
            distribution_name = "python-kasa" if module_name == "kasa" else module_name
            version = metadata.version(distribution_name)
        except Exception:
            version = None
    return {
        "module": module_name,
        "ok": True,
        "path": getattr(module, "__file__", None),
        "version": str(version) if version is not None else None,
    }


def inspect_kasa_pin() -> KasaPinStatus:
    try:
        dist = metadata.distribution("python-kasa")
    except metadata.PackageNotFoundError:
        return KasaPinStatus(KASA_PIN_MISSING, False, None, None, "missing", None, None, None, "python-kasa is not installed.")
    except Exception as exc:
        return KasaPinStatus(KASA_PIN_UNKNOWN, False, None, None, "unknown", None, None, None, f"Could not inspect python-kasa metadata: {_safe_exception(exc)}")

    version = dist.version
    direct_url_path = _direct_url_path(dist)
    direct_url_text = dist.read_text("direct_url.json")
    direct_url = _parse_direct_url(direct_url_text)
    source_type, repository, commit = classify_direct_url(direct_url)

    import_ready = False
    import_path: str | None = None
    import_detail: str | None = None
    try:
        kasa = importlib.import_module("kasa")
        import_path = getattr(kasa, "__file__", None)
        for attr in ("Device", "DeviceConfig", "Credentials"):
            if not hasattr(kasa, attr):
                raise AttributeError(attr)
        import_ready = True
    except Exception as exc:
        import_detail = f"python-kasa import/API check failed: {_safe_exception(exc)}"

    if not direct_url:
        return KasaPinStatus(KASA_PIN_WRONG_SOURCE, import_ready, import_path, version, "pypi", repository, commit, direct_url_path, "python-kasa was not installed from a recorded Git URL.")
    if source_type != "git" or not repository:
        return KasaPinStatus(KASA_PIN_WRONG_SOURCE, import_ready, import_path, version, source_type, repository, commit, direct_url_path, "python-kasa source is not the required Git repository.")
    if _normalize_git_url(repository) != _normalize_git_url(KASA_REPOSITORY_URL):
        return KasaPinStatus(KASA_PIN_WRONG_SOURCE, import_ready, import_path, version, source_type, repository, commit, direct_url_path, f"python-kasa repository is {repository}, expected {KASA_REPOSITORY_URL}.")
    if commit != KASA_COMMIT:
        return KasaPinStatus(KASA_PIN_WRONG_COMMIT, import_ready, import_path, version, source_type, repository, commit, direct_url_path, f"python-kasa commit is {commit or '(missing)'}, expected {KASA_COMMIT}.")
    if not import_ready:
        return KasaPinStatus(KASA_PIN_BROKEN, False, import_path, version, source_type, repository, commit, direct_url_path, import_detail or "python-kasa import check failed.")
    return KasaPinStatus(KASA_PIN_READY, True, import_path, version, source_type, repository, commit, direct_url_path, "python-kasa exact Git pin is installed and importable.")


def classify_direct_url(direct_url: dict[str, Any] | None) -> tuple[str, str | None, str | None]:
    if not direct_url:
        return "pypi", None, None
    url = direct_url.get("url")
    vcs_info = direct_url.get("vcs_info")
    if isinstance(vcs_info, dict):
        vcs = str(vcs_info.get("vcs") or "").lower()
        commit = vcs_info.get("commit_id")
        return (vcs or "vcs", str(url) if isinstance(url, str) else None, str(commit) if isinstance(commit, str) else None)
    if isinstance(url, str):
        return "url", url, None
    return "unknown", None, None


def _parse_direct_url(text: str | None) -> dict[str, Any] | None:
    if not text or not text.strip():
        return None
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _direct_url_path(dist: metadata.Distribution) -> str | None:
    dist_path = getattr(dist, "_path", None)
    if dist_path is not None:
        try:
            return str(Path(dist_path) / "direct_url.json")
        except Exception:
            pass
    located = getattr(dist, "locate_file", None)
    if located is None:
        return None
    try:
        path = Path(located("direct_url.json"))
        return str(path)
    except Exception:
        return None


def _normalize_git_url(url: str) -> str:
    normalized = url.strip().lower()
    if normalized.endswith("/"):
        normalized = normalized[:-1]
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    return normalized


def _safe_exception(exc: BaseException) -> str:
    text = str(exc).strip()
    if not text:
        text = type(exc).__name__
    return text[:300]
