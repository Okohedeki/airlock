"""Driver tests with stub agent objects — no harness frameworks installed."""

from airlock_agent import AgentRunResult, get_driver
from airlock_agent.harnesses import crewai, custom, langgraph, smolagents

MSGS = [{"role": "user", "content": "multiply 23 and 19"}]


def test_registry_has_all_harnesses():
    for h in ("smolagents", "langgraph", "crewai", "openai-agents", "claude", "custom"):
        assert callable(get_driver(h))


# ---- smolagents: usage is a per-call token delta (build-once monitor accumulates) ----
class StubMonitor:
    def __init__(self, inp, out):
        self.total_input_token_count = inp
        self.total_output_token_count = out


class StubSmol:
    def __init__(self):
        self.monitor = StubMonitor(100, 50)  # pre-existing cumulative total = 150

    def run(self, task, reset=True):
        self.task = task
        self.monitor = StubMonitor(160, 80)  # after this call: 240 → delta 90
        return "437"


def test_smolagents_counts_token_delta():
    out = smolagents.drive(StubSmol(), MSGS)
    assert out.content == "437"
    assert out.units == 90  # 240 - 150
    assert out.unit_label == "tokens"


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
