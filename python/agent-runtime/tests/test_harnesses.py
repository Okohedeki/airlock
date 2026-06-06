"""Driver tests with stub agent objects — no harness frameworks installed."""

from airlock_agent import AgentRunResult, get_driver, is_reentrant
from airlock_agent.harnesses import crewai, custom, langgraph, smolagents

MSGS = [{"role": "user", "content": "multiply 23 and 19"}]


def test_registry_has_all_harnesses():
    for h in ("smolagents", "langgraph", "crewai", "openai-agents", "claude", "custom"):
        assert callable(get_driver(h))


def test_reentrancy_matrix():
    # All framework harnesses are now OWN (airlock extracts their tools and drives
    # its own per-request loop), so all are reentrant. custom may hold a shared
    # Planner, so it stays non-reentrant by default.
    for h in ("langgraph", "openai-agents", "claude", "smolagents", "crewai"):
        assert is_reentrant(h)
    assert not is_reentrant("custom")
    assert not is_reentrant("unknown-harness")


# ---- smolagents: usage from THIS run's RunResult.token_usage (not a shared delta) ----
class StubTokenUsage:
    def __init__(self, total):
        self.total_tokens = total


class StubRunResult:
    def __init__(self, output, total, nsteps):
        self.output = output
        self.token_usage = StubTokenUsage(total) if total is not None else None
        self.steps = [object()] * nsteps


class StubSmolFull:
    """smolagents >= 1.10: run(..., return_full_result=True) → RunResult."""

    def run(self, task, reset=True, return_full_result=False):
        assert return_full_result is True  # driver must opt in
        assert reset is True
        return StubRunResult("437", total=90, nsteps=3)


def test_smolagents_uses_run_result_token_usage():
    out = smolagents.drive(StubSmolFull(), MSGS)
    assert out.content == "437"
    assert out.units == 90
    assert out.unit_label == "tokens"


class StubSmolNoUsage:
    def run(self, task, reset=True, return_full_result=False):
        return StubRunResult("ok", total=None, nsteps=4)  # local model: no token usage


def test_smolagents_falls_back_to_steps_when_no_token_usage():
    out = smolagents.drive(StubSmolNoUsage(), MSGS)
    assert out.content == "ok"
    assert out.units == 4
    assert out.unit_label == "steps"


class StubSmolOld:
    """Older smolagents: no return_full_result kwarg → TypeError, then step count."""

    def __init__(self):
        self.memory = type("M", (), {"steps": [object(), object()]})()

    def run(self, task, reset=True):
        return "437"


def test_smolagents_old_api_falls_back_to_steps():
    out = smolagents.drive(StubSmolOld(), MSGS)
    assert out.content == "437"
    assert out.units == 2
    assert out.unit_label == "steps"


# ---- langgraph ----
class LCMsg:
    def __init__(self, content, total=None):
        self.content = content
        if total is not None:
            self.usage_metadata = {"total_tokens": total}


class StubGraph:
    def invoke(self, state):
        return {"messages": [LCMsg("step", 10), LCMsg("done", 20)]}


def test_langgraph_final_and_summed_units():
    out = langgraph.drive(StubGraph(), MSGS)
    assert out.content == "done"
    assert out.units == 30


# ---- crewai ----
class StubUsage:
    def __init__(self, total):
        self.total_tokens = total


class StubKickoff:
    def __init__(self):
        self.raw = "the answer"
        self.token_usage = StubUsage(77)


class StubCrew:
    def kickoff(self, inputs):
        self.inputs = inputs
        return StubKickoff()


def test_crewai_raw_and_units():
    crew = StubCrew()
    out = crewai.drive(crew, MSGS)
    assert out.content == "the answer"
    assert out.units == 77
    assert "multiply 23 and 19" in crew.inputs["input"]


# ---- custom ----
def test_custom_run_messages():
    out = custom.drive(lambda messages: f"got {len(messages)} msgs", MSGS)
    assert out.content == "got 1 msgs"


def test_custom_returns_agentrunresult_directly():
    out = custom.drive(lambda messages: AgentRunResult("x", units=5), MSGS)
    assert out.units == 5
