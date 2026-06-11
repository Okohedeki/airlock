"""The Airlock Loop Engine — airlock owns the agent loop (epic 01).

The engine runs `assemble → model-call → parse action → tool-dispatch → StepEvent
→ consult ControlSignal → repeat` so the Operator can control every step. This is
the keystone every control-the-loop feature (02/03/04/05/06/13) builds on.

Control is **feature-derived, not uniform** (frozen contract C1): a binding declares
`control_mode` — `OWN` (airlock drives the model calls → full control) or `WRAP`
(airlock intercepts tool dispatch only → tool-centric control). See `adapter.Binding`.
"""

from .events import ControlSignal, StepEvent, StepStatus, StepType
from .planner import Action, Finish, ModelCall, Planner, ToolCall
from .loop import RunContext, run_loop

__all__ = [
    "ControlSignal",
    "StepEvent",
    "StepStatus",
    "StepType",
    "Action",
    "Finish",
    "ModelCall",
    "Planner",
    "ToolCall",
    "RunContext",
    "run_loop",
]
