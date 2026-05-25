"""Unit-tests the adapter's pure mapping logic with a stub agent — no langgraph,
no model. (Live verification needs `pip install -r requirements.txt` + a model.)"""

from adapter import LangGraphAdapter, final_content, sum_units, to_lc_messages


class StubMsg:
    def __init__(self, content, usage=None):
        self.content = content
        if usage is not None:
            self.usage_metadata = usage


class StubAgent:
    def __init__(self, result):
        self._result = result

    def invoke(self, state):
        self._state = state
        return self._result


def test_to_lc_messages_keeps_full_history():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]
    assert to_lc_messages(msgs) == [("system", "s"), ("user", "hi")]


def test_final_content_and_units_summed_across_messages():
    result = {
        "messages": [
            StubMsg("step", {"total_tokens": 10}),
            StubMsg("final answer", {"total_tokens": 90}),
        ]
    }
    assert final_content(result) == "final answer"
    assert sum_units(result) == 100


def test_run_with_stub_agent():
    result = {"messages": [StubMsg("done", {"total_tokens": 42})]}
    out = LangGraphAdapter(agent=StubAgent(result)).run([{"role": "user", "content": "hi"}])
    assert out.content == "done"
    assert out.units == 42
