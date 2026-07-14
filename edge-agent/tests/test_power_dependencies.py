import types

from plantlab_edge_agent.power import dependencies
from plantlab_edge_agent.power.dependencies import KASA_COMMIT, KASA_REPOSITORY_URL, classify_direct_url, inspect_kasa_pin


def test_classify_exact_git_direct_url():
    source, repository, commit = classify_direct_url(
        {
            "url": KASA_REPOSITORY_URL,
            "vcs_info": {"vcs": "git", "commit_id": KASA_COMMIT},
        }
    )

    assert source == "git"
    assert repository == KASA_REPOSITORY_URL
    assert commit == KASA_COMMIT


def test_classify_pypi_install_as_wrong_source_shape():
    source, repository, commit = classify_direct_url(None)

    assert source == "pypi"
    assert repository is None
    assert commit is None


def test_classify_wrong_commit():
    source, repository, commit = classify_direct_url(
        {
            "url": KASA_REPOSITORY_URL,
            "vcs_info": {"vcs": "git", "commit_id": "wrong"},
        }
    )

    assert source == "git"
    assert repository == KASA_REPOSITORY_URL
    assert commit == "wrong"


class FakeDistribution:
    version = "0.10.2"
    _path = "/venv/lib/python3.13/site-packages/python_kasa-0.10.2.dist-info"

    def __init__(self, direct_url):
        self.direct_url = direct_url

    def read_text(self, name):
        assert name == "direct_url.json"
        return self.direct_url


def test_inspect_kasa_pin_accepts_exact_git_commit(monkeypatch):
    monkeypatch.setattr(
        dependencies.metadata,
        "distribution",
        lambda _name: FakeDistribution(f'{{"url":"{KASA_REPOSITORY_URL}","vcs_info":{{"vcs":"git","commit_id":"{KASA_COMMIT}"}}}}'),
    )
    monkeypatch.setattr(dependencies.importlib, "import_module", lambda _name: types.SimpleNamespace(Device=object, DeviceConfig=object, Credentials=object, __file__="/venv/kasa/__init__.py"))

    status = inspect_kasa_pin()

    assert status.status == "ready"
    assert status.repository == KASA_REPOSITORY_URL
    assert status.commit == KASA_COMMIT


def test_inspect_kasa_pin_rejects_pypi_and_wrong_commit(monkeypatch):
    monkeypatch.setattr(dependencies.importlib, "import_module", lambda _name: types.SimpleNamespace(Device=object, DeviceConfig=object, Credentials=object))
    monkeypatch.setattr(dependencies.metadata, "distribution", lambda _name: FakeDistribution(""))
    assert inspect_kasa_pin().status == "wrong-source"

    monkeypatch.setattr(
        dependencies.metadata,
        "distribution",
        lambda _name: FakeDistribution(f'{{"url":"{KASA_REPOSITORY_URL}","vcs_info":{{"vcs":"git","commit_id":"wrong"}}}}'),
    )
    assert inspect_kasa_pin().status == "wrong-commit"


def test_inspect_kasa_pin_rejects_wrong_repository_malformed_metadata_and_import_failure(monkeypatch):
    monkeypatch.setattr(dependencies.importlib, "import_module", lambda _name: types.SimpleNamespace(Device=object, DeviceConfig=object, Credentials=object))
    monkeypatch.setattr(
        dependencies.metadata,
        "distribution",
        lambda _name: FakeDistribution(f'{{"url":"https://example.invalid/python-kasa.git","vcs_info":{{"vcs":"git","commit_id":"{KASA_COMMIT}"}}}}'),
    )
    assert inspect_kasa_pin().status == "wrong-source"

    monkeypatch.setattr(dependencies.metadata, "distribution", lambda _name: FakeDistribution("{bad json"))
    assert inspect_kasa_pin().status == "wrong-source"

    monkeypatch.setattr(
        dependencies.metadata,
        "distribution",
        lambda _name: FakeDistribution(f'{{"url":"{KASA_REPOSITORY_URL}","vcs_info":{{"vcs":"git","commit_id":"{KASA_COMMIT}"}}}}'),
    )

    def broken_import(_name):
        raise RuntimeError("missing dependency")

    monkeypatch.setattr(dependencies.importlib, "import_module", broken_import)
    assert inspect_kasa_pin().status == "broken"
