"""Approved continuation reuses prior results and rejects changed execution."""

import pytest

from airlock_agent.engine.loop import ModelResult
from airlock_agent.manifest import Manifest
from airlock_agent.runner import EngineRunner
from airlock_agent.state import MemoryStore


def setup_run(script):
    store = MemoryStore()
    runner = EngineRunner(Manifest.from_dict({"harness": "stub", "controls": {
        "approvals": [{"tool": "send"}]} }), store)
    effects, models = [], []
    runner.tools = {"bump": lambda: effects.append("bump"),
                    "send": lambda **args: effects.append(args)}

    def model(messages):
        models.append(messages)
        return ModelResult(content="recorded output", prompt_tokens=2, completion_tokens=3)

    runner.m.build_model_callers = lambda **kwargs: {"default": model}
    runner.run([{"role": "user", "content": script}], run_id="original")
    return runner, store, effects, models


def decide(store, decision="approve", args=None):
    held = store.get("default/_held/original")
    store.set("default/" + held["gate_key"], {
        "decision": decision, "args": args, "approval_id": held["approval_id"],
        "tool": held["tool"], "original_args": held["args"],
    })
    return held["approval_id"]


def test_continuation_reuses_models_and_tools_before_approved_boundary():
    runner, store, effects, models = setup_run(
        'say: choose\ntool: bump {}\ntool: send {"text":"reviewed"}\nfinal: done')
    assert effects == ["bump"] and len(models) == 1
    review = decide(store)
    # A live rule change cannot bypass the recorded approval requirement.
    runner.controls["approvals"] = []
    result = runner.continue_run("original", new_run_id="next", tenant="default",
                                 approval_run_id="original", review_id=review)
    assert result.content == "done"
    assert effects == ["bump", {"text": "reviewed"}]
    assert len(models) == 1
    with pytest.raises(ValueError, match="approval changed"):
        runner.continue_run("original", new_run_id="duplicate", tenant="default",
                            approval_run_id="original", review_id=review)
    assert len(effects) == 2


def test_empty_edit_and_second_approval_replay_original_proposals():
    runner, store, effects, _ = setup_run(
        'tool: bump {}\ntool: send {"text":"original"}\ntool: send {"text":"again"}\nfinal: done')
    review = decide(store, "edit", {})
    first = runner.continue_run("original", new_run_id="second", tenant="default",
                                approval_run_id="original", review_id=review)
    assert effects == ["bump", {}]
    assert first.steps[-1]["stop_reason"].startswith("AWAIT_APPROVAL")
    review = decide(store)
    final = runner.continue_run("second", new_run_id="third", tenant="default",
                                approval_run_id="original", review_id=review)
    assert final.content == "done"
    assert effects == ["bump", {}, {"text": "again"}]


@pytest.mark.parametrize("change", ["tool", "arguments", "model"])
def test_changed_planner_stops_before_any_new_effect(change, monkeypatch):
    runner, store, effects, models = setup_run(
        'say: choose\ntool: bump {}\ntool: send {"text":"reviewed"}\nfinal: done')
    review = decide(store)
    from airlock_agent.harnesses.stub import StubBinding

    changed = {
        "tool": 'tool: send {}\nfinal: done',
        "arguments": 'say: choose\ntool: bump {"x":1}\nfinal: done',
        "model": 'say: different\nfinal: done',
    }[change]
    monkeypatch.setattr("airlock_agent.runner.build_binding", lambda *args, **kwargs:
                        StubBinding([{"role": "user", "content": changed}], runner.tools))
    with pytest.raises(ValueError, match="continuation"):
        runner.continue_run("original", new_run_id="changed", tenant="default",
                            approval_run_id="original", review_id=review)
    assert effects == ["bump"] and len(models) == 1
