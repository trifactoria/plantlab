import types

import pytest

from plantlab_edge_agent.power.base import PowerDriverError
from plantlab_edge_agent.power import kasa as kasa_module
from plantlab_edge_agent.power.kasa import KasaPowerDriver


class FakeChild:
    def __init__(self, alias, is_on=False):
        self.alias = alias
        self.is_on = is_on

    async def turn_on(self):
        self.is_on = True

    async def turn_off(self):
        self.is_on = False


class FakeDevice:
    def __init__(self):
        self.model = "KP303(US)"
        self.children = [FakeChild("greenhouse-fans", False), FakeChild("greenhouse-water", False)]
        self.protocol = types.SimpleNamespace(transport=types.SimpleNamespace(encryption_type="KLAP", login_version=2))

    async def update(self):
        return None

    async def disconnect(self):
        return None


def fake_kasa_module(device):
    class Credentials:
        def __init__(self, username, password):
            self.username = username
            self.password = password

    class DeviceConfig:
        def __init__(self, host, credentials):
            self.host = host
            self.credentials = credentials

    class Device:
        @staticmethod
        async def connect(config):
            if config.credentials.username == "bad":
                raise RuntimeError("authentication failed")
            return device

    return types.SimpleNamespace(Credentials=Credentials, DeviceConfig=DeviceConfig, Device=Device)


def test_kasa_driver_connect_lists_and_switches(monkeypatch):
    device = FakeDevice()
    monkeypatch.setattr(kasa_module.importlib, "import_module", lambda _name: fake_kasa_module(device))
    driver = KasaPowerDriver("192.168.1.72", "user", "secret", {"fans": "greenhouse-fans", "water": "greenhouse-water"})

    driver.connect()
    assert driver.detected_model == "KP303(US)"
    assert driver.detected_encryption == "KLAP"
    assert driver.list_outlets() == {"fans": False, "water": False}
    driver.turn_on("fans")
    assert driver.get_state("fans") is True
    driver.turn_off("fans")
    assert driver.get_state("fans") is False
    driver.close()


def test_kasa_driver_missing_alias_and_auth_failure(monkeypatch):
    device = FakeDevice()
    monkeypatch.setattr(kasa_module.importlib, "import_module", lambda _name: fake_kasa_module(device))
    missing = KasaPowerDriver("192.168.1.72", "user", "secret", {"lights": "missing"})
    with pytest.raises(PowerDriverError) as missing_exc:
        missing.connect()
    assert missing_exc.value.code == "power-outlet-missing"

    auth = KasaPowerDriver("192.168.1.72", "bad", "secret", {"fans": "greenhouse-fans"})
    with pytest.raises(PowerDriverError) as auth_exc:
        auth.connect()
    assert auth_exc.value.code == "power-authentication-failed"


def test_kasa_driver_unavailable(monkeypatch):
    def fail_import(_name):
        raise ModuleNotFoundError("kasa")

    monkeypatch.setattr(kasa_module.importlib, "import_module", fail_import)
    driver = KasaPowerDriver("192.168.1.72", "user", "secret", {"fans": "greenhouse-fans"})
    with pytest.raises(PowerDriverError) as exc:
        driver.connect()
    assert exc.value.code == "power-driver-unavailable"
