"""Unit-tests the adapter's mapping with a stub Runner/result — no SDK, no model."""

from adapter import OpenAIAgentsAdapter, final_output, total_units


class StubUsage:
    def __init__(self, total):
        self.total_tokens = total


class StubCtx:
    def __init__(self, total):
        self.usage = StubUsage(total)


class StubResult:
    def __init__(self, output, total_tokens):
        self.final_output = output
        self.context_wrapper = StubCtx(total_tokens)
        self.raw_responses = []


class StubRunner:
    def __init__(self, result):
        self._result = result

    def run_sync(self, agent, task):
        self.task = task
        return self._result


def test_final_output_and_units():
    r = StubResult("the answer", 321)
    assert final_output(r) == "the answer"
    assert total_units(r) == 321


def test_run_with_stub_runner_passes_task():
    runner = StubRunner(StubResult("done", 12))
    out = OpenAIAgentsAdapter(agent=object(), runner=runner).run(
        [{"role": "user", "content": "multiply 6 and 7"}]
    )
    assert out.content == "done"
    assert out.units == 12
    assert "multiply 6 and 7" in runner.task
