"""Loader + config-reader tests."""

import sys
import types

from airlock_agent import load_entrypoint, read_agent_config, resolve_entrypoint


def test_load_entrypoint_resolves_module_attr():
    import json

    assert load_entrypoint("json:dumps") is json.dumps


def test_custom_entrypoint_not_called():
    # custom: the callable is the per-request run fn — must NOT be invoked at load.
    fn = resolve_entrypoint("json:dumps", "custom")
    assert fn is __import__("json").dumps


def test_factory_built_once_for_non_custom():
    mod = types.ModuleType("fake_harness_mod")
    built = {"count": 0}

    def build_agent():
        built["count"] += 1
        return {"agent": True, "n": built["count"]}

    mod.build_agent = build_agent
    sys.modules["fake_harness_mod"] = mod
    try:
        obj = resolve_entrypoint("fake_harness_mod:build_agent", "langgraph")
        assert obj == {"agent": True, "n": 1}
        assert built["count"] == 1  # called exactly once
    finally:
        del sys.modules["fake_harness_mod"]


def test_non_factory_object_used_as_is():
    mod = types.ModuleType("fake_obj_mod")
    mod.graph = {"already": "built"}
    sys.modules["fake_obj_mod"] = mod
    try:
        assert resolve_entrypoint("fake_obj_mod:graph", "langgraph") == {"already": "built"}
    finally:
        del sys.modules["fake_obj_mod"]


def test_read_agent_config_absent(tmp_path):
    assert read_agent_config(str(tmp_path)) == {}


def test_read_agent_config_present(tmp_path):
    d = tmp_path / ".airlock"
    d.mkdir()
    (d / "config.toml").write_text(
        '[project]\nname="x"\ntarget="fly"\nschemaVersion=1\n'
        '[agent]\nharness="langgraph"\nentrypoint="my_app:graph"\n'
    )
    cfg = read_agent_config(str(tmp_path))
    assert cfg == {"harness": "langgraph", "entrypoint": "my_app:graph"}
