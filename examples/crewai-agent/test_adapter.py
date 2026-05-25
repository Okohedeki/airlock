"""Unit-tests the adapter's mapping with a stub crew — no crewai, no model.
(Live verification needs `pip install -r requirements.txt` + a model.)"""

from adapter import CrewAIAdapter, final_content, total_units


class StubUsage:
    def __init__(self, total):
        self.total_tokens = total


class StubResult:
    def __init__(self, raw, total_tokens):
        self.raw = raw
        self.token_usage = StubUsage(total_tokens)


class StubCrew:
    def __init__(self, result):
        self._result = result

    def kickoff(self, inputs):
        self.inputs = inputs
        return self._result


def test_final_content_prefers_raw():
    assert final_content(StubResult("the answer", 7)) == "the answer"


def test_total_units_reads_token_usage():
    assert total_units(StubResult("x", 123)) == 123
    assert total_units(object()) == 0


def test_run_passes_task_and_maps_result():
    crew = StubCrew(StubResult("done", 55))
    out = CrewAIAdapter(crew=crew).run([{"role": "user", "content": "analyze TSLA"}])
    assert out.content == "done"
    assert out.units == 55
    assert "analyze TSLA" in crew.inputs["input"]
