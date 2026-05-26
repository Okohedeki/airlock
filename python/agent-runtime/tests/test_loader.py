"""resolve_builder: factory rebuilds per call, instance/custom return the shared object."""

from airlock_agent import resolve_builder


def test_factory_entrypoint_rebuilds_each_call():
    b = resolve_builder("agentfix:build_thing", "smolagents")
    assert b.is_factory is True
    first = b.build()
    second = b.build()
    assert first is not second  # fresh object per call → isolation
    assert first["id"] != second["id"]


def test_instance_entrypoint_returns_same_object():
    b = resolve_builder("agentfix:instance", "smolagents")
    assert b.is_factory is False
    assert b.build() is b.build()


def test_custom_entrypoint_returns_callable():
    b = resolve_builder("agentfix:run", "custom")
    assert b.is_factory is False  # the run() callable, not a factory to re-call
    fn = b.build()
    assert callable(fn)
    assert fn([{"role": "user", "content": "x"}]) == "got 1"
