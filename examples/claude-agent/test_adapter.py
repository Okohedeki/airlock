"""Unit-tests the adapter's text/usage extraction with stub messages — no SDK."""

from adapter import ClaudeAdapter, extract_text, extract_units


class StubResultMessage:
    def __init__(self, result, usage):
        self.result = result
        self.usage = usage


class StubBlock:
    def __init__(self, text):
        self.text = text


class StubAssistant:
    def __init__(self, *texts):
        self.content = [StubBlock(t) for t in texts]


def test_extract_text_prefers_result_message():
    msgs = [StubAssistant("thinking"), StubResultMessage("final", {"total_tokens": 50})]
    assert extract_text(msgs) == "final"


def test_extract_text_falls_back_to_assistant_blocks():
    assert extract_text([StubAssistant("a", "b")]) == "a\nb"


def test_extract_units_total_then_sum():
    assert extract_units([StubResultMessage("x", {"total_tokens": 99})]) == 99
    assert extract_units([StubResultMessage("x", {"input_tokens": 10, "output_tokens": 5})]) == 15
    assert extract_units([StubAssistant("no usage")]) == 0


def test_run_with_injected_collect():
    msgs = [StubResultMessage("done", {"total_tokens": 7})]
    out = ClaudeAdapter(collect=lambda task: msgs).run([{"role": "user", "content": "hi"}])
    assert out.content == "done"
    assert out.units == 7
