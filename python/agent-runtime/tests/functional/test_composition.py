"""Composition (epic 07 + 12): per-skill enable/disable + variants/profiles overlay.
Answers: skills on/off, multiple agents in one yaml, internal-vs-external profiles.
"""

from __future__ import annotations

from airlock_agent.manifest import Manifest


def _cfg():
    return {
        "worker": {"name": "comp"}, "harness": "stub",
        "tools": {"echo": "tools:echo", "add": "tools:add"},
        "skills": {"say": "echo", "compute": {"tool": "add", "enabled": False}},
        "variants": {
            "external": {"auth": {"scheme": "api_key", "required": True,
                                  "keys": {"k1": "acme"}}, "expose": "public"},
            "fast": {"models": {"default": {}}, "capabilities": ["chat"]},
        },
    }


# --- manifest-level -------------------------------------------------------------
def test_skills_normalize_and_enabled():
    m = Manifest.from_dict(_cfg())
    sk = m.skills()
    assert sk["say"] == {"tool": "echo", "enabled": True}
    assert sk["compute"] == {"tool": "add", "enabled": False}


def test_with_variant_deep_merges_over_base():
    m = Manifest.from_dict(_cfg())
    assert m.auth() == {}  # base has none
    ext = m.with_variant("external")
    assert ext.auth()["required"] is True and ext.expose() == "public"
    assert ext.harness() == "stub"  # inherited from base
    assert "variants" not in ext.raw()  # the key is dropped in the overlay result
    assert m.variant_names() == ["external", "fast"]


def test_unknown_variant_raises():
    import pytest

    with pytest.raises(ValueError):
        Manifest.from_dict(_cfg()).with_variant("ghost")


# --- surface-level (skills on/off + variant routing) ----------------------------
def test_disabled_skill_tool_dropped_from_loop(client_factory):
    c = client_factory(_cfg())
    # /skills dispatch: enabled → 200, disabled → 403, unknown → 404
    assert c.post("/skills/say", json={"input": "hi"}).status_code == 200
    assert c.post("/skills/compute", json={"input": "x"}).status_code == 403
    assert c.post("/skills/nope", json={"input": "x"}).status_code == 404


def test_variant_routing_and_per_variant_auth(client_factory):
    c = client_factory(_cfg())
    # base: no auth
    assert c.post("/v1/chat/completions",
                  json={"messages": [{"role": "user", "content": "final: ok"}]}).status_code == 200
    # external variant enforces auth (overlay)
    assert c.post("/v1/chat/completions", headers={"X-Airlock-Variant": "external"},
                  json={"messages": [{"role": "user", "content": "final: x"}]}).status_code == 401
    assert c.post("/v1/chat/completions",
                  headers={"X-Airlock-Variant": "external", "Authorization": "Bearer k1"},
                  json={"messages": [{"role": "user", "content": "final: x"}]}).status_code == 200
    # unknown variant → 400
    assert c.post("/v1/chat/completions", headers={"X-Airlock-Variant": "ghost"},
                  json={"messages": [{"role": "user", "content": "final: x"}]}).status_code == 400
