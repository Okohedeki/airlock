"""Extract tools (+ optional system prompt) from each framework's agent object.

Airlock owns the loop: a harness *contributes* its tools and prompt, and
airlock drives them through its own engine (the OpenAI-style planner), so every
framework gets the full control set uniformly. The only per-framework work is reading
the tool set out of that framework's agent object — done here, defensively, with
graceful fallback across framework versions.

Each extractor returns (tools: dict[name -> callable], system_prompt: str | None).
"""

from __future__ import annotations

import json
from typing import Any, Callable


def _name_of(tool: Any, fallback: str) -> str:
    return str(getattr(tool, "name", None) or getattr(tool, "__name__", None) or fallback)


def _params_from(tool: Any) -> dict[str, Any] | None:
    """Derive an OpenAI `parameters` JSON-schema from a framework tool's metadata,
    trying the shapes each framework exposes. Returns None if nothing usable."""
    # OpenAI Agents SDK: ready-made JSON schema.
    pjs = getattr(tool, "params_json_schema", None)
    if isinstance(pjs, dict) and pjs.get("type") == "object":
        return pjs
    # Pydantic args_schema (LangChain / CrewAI).
    args_schema = getattr(tool, "args_schema", None)
    if args_schema is not None:
        try:
            js = args_schema.model_json_schema()  # pydantic v2
            return {"type": "object", "properties": js.get("properties", {}),
                    "required": js.get("required", [])}
        except Exception:
            pass
    # smolagents: `.inputs` = {name: {type, description}}.
    inputs = getattr(tool, "inputs", None)
    if isinstance(inputs, dict):
        props = {n: {"type": (i.get("type") or "string"), "description": i.get("description", "")}
                 for n, i in inputs.items()}
        return {"type": "object", "properties": props, "required": list(inputs.keys())}
    # LangChain `.args` = {name: {type/title}}.
    args = getattr(tool, "args", None)
    if isinstance(args, dict):
        props = {n: {"type": (a.get("type") or "string")} for n, a in args.items()}
        return {"type": "object", "properties": props, "required": list(args.keys())}
    # Claude SDK `.input_schema`: a JSON schema, or a {param: python-type} mapping.
    ischema = getattr(tool, "input_schema", None)
    if isinstance(ischema, dict):
        if ischema.get("type") == "object":
            return ischema
        _m = {int: "integer", float: "number", bool: "boolean", str: "string"}
        props = {n: {"type": _m.get(ty, "string")} for n, ty in ischema.items()}
        return {"type": "object", "properties": props, "required": list(ischema.keys())}
    return None


def _attach_schema(wrapper: Callable, tool: Any, name: str) -> Callable:
    """Attach an OpenAI function schema (description + parameters) to a wrapper so the
    model gets the real param names/types even though the wrapper is a lambda."""
    params = _params_from(tool)
    if params is not None:
        desc = str(getattr(tool, "description", None) or name)[:300]
        wrapper._airlock_schema = {"description": desc, "parameters": params}  # type: ignore[attr-defined]
    return wrapper


# ---- LangChain / LangGraph ----------------------------------------------------
def extract_langgraph(obj: Any) -> tuple[dict[str, Callable], str | None]:
    """A list of LangChain tools, or a compiled create_react_agent graph."""
    tools_list: list[Any] = []
    if isinstance(obj, (list, tuple)):
        tools_list = list(obj)
    elif getattr(obj, "tools", None):
        tools_list = list(obj.tools)
    else:
        # Dig the ToolNode out of a compiled graph (version-tolerant: the ToolNode may
        # sit under .bound / .runnable / .node of a PregelNode).
        nodes = getattr(obj, "nodes", None)
        if isinstance(nodes, dict):
            for node in nodes.values():
                for holder in (node, getattr(node, "bound", None), getattr(node, "runnable", None),
                               getattr(node, "node", None)):
                    tbn = getattr(holder, "tools_by_name", None)
                    if isinstance(tbn, dict):
                        tools_list = list(tbn.values())
                        break
                if tools_list:
                    break

    out: dict[str, Callable] = {}
    for i, t in enumerate(tools_list):
        name = _name_of(t, f"tool{i}")
        # LangChain tools run via .invoke(dict); fall back to .func.
        if hasattr(t, "invoke"):
            out[name] = _attach_schema((lambda _t=t: (lambda **kw: _t.invoke(kw)))(), t, name)
        elif hasattr(t, "func"):
            out[name] = t.func
        elif callable(t):
            out[name] = t
    return out, None


# ---- smolagents ---------------------------------------------------------------
def extract_smolagents(obj: Any) -> tuple[dict[str, Callable], str | None]:
    """smolagents agent: `.tools` is a dict[name -> Tool]; Tools are callable."""
    out: dict[str, Callable] = {}
    tools = getattr(obj, "tools", None) or {}
    items = tools.items() if isinstance(tools, dict) else [(_name_of(t, str(i)), t) for i, t in enumerate(tools)]
    for name, t in items:
        if name in ("final_answer",):  # smolagents' built-in terminator — our loop owns finishing
            continue
        if callable(t):
            out[name] = _attach_schema((lambda _t=t: (lambda **kw: _t(**kw)))(), t, name)
        elif hasattr(t, "forward"):
            out[name] = _attach_schema(t.forward, t, name)
    return out, None


# ---- CrewAI -------------------------------------------------------------------
def extract_crewai(obj: Any) -> tuple[dict[str, Callable], str | None]:
    """CrewAI Crew: collect tools across its agents (BaseTool.run)."""
    out: dict[str, Callable] = {}
    agents = getattr(obj, "agents", None) or []
    tool_lists = [getattr(a, "tools", None) or [] for a in agents]
    if not agents and getattr(obj, "tools", None):
        tool_lists = [obj.tools]
    for tl in tool_lists:
        for i, t in enumerate(tl):
            name = _name_of(t, f"tool{i}")
            if hasattr(t, "run"):
                out[name] = _attach_schema((lambda _t=t: (lambda **kw: _t.run(**kw)))(), t, name)
            elif hasattr(t, "_run"):
                out[name] = _attach_schema((lambda _t=t: (lambda **kw: _t._run(**kw)))(), t, name)
            elif callable(t):
                out[name] = t
    return out, None


# ---- OpenAI Agents SDK --------------------------------------------------------
def extract_openai_agents(obj: Any) -> tuple[dict[str, Callable], str | None]:
    """OpenAI Agents SDK Agent: `.tools` is a list of FunctionTool. Prefer the
    original python function; else drive `on_invoke_tool` (async, json args)."""
    import asyncio

    out: dict[str, Callable] = {}
    for i, t in enumerate(getattr(obj, "tools", None) or []):
        name = _name_of(t, f"tool{i}")
        func = getattr(t, "func", None) or getattr(t, "__wrapped__", None)
        if callable(func):
            out[name] = _attach_schema(func, t, name)
        elif hasattr(t, "on_invoke_tool"):
            # The SDK invokes tools with a ToolContext (not a bare context).
            def _call(_t=t, _name=name, **kw):
                from agents.tool_context import ToolContext

                args = json.dumps(kw)
                ctx = ToolContext(context=None, tool_name=_name, tool_call_id="airlock", tool_arguments=args)
                return asyncio.run(_t.on_invoke_tool(ctx, args))
            out[name] = _attach_schema((lambda _c=_call: (lambda **kw: _c(**kw)))(), t, name)
    prompt = getattr(obj, "instructions", None)
    return out, (str(prompt) if isinstance(prompt, str) else None)


# ---- Claude Agent SDK ---------------------------------------------------------
def _unwrap_claude(result: Any) -> Any:
    """Claude SDK tool handlers return {"content": [{"type":"text","text": ...}]}."""
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        texts = [c.get("text") for c in result["content"] if isinstance(c, dict) and c.get("text")]
        return "\n".join(texts) if texts else result
    return result


def extract_claude(obj: Any) -> tuple[dict[str, Callable], str | None]:
    """Claude SDK @tool handlers (SdkMcpTool: .name, .handler async(args)->{content},
    .input_schema). The entrypoint may be a single tool, a list of tools, or options
    with mcp_servers. Airlock drives with its own model, so no Anthropic key is needed."""
    import asyncio

    candidates: list[Any] = []
    if isinstance(obj, (list, tuple)):
        candidates = list(obj)
    elif hasattr(obj, "handler") and hasattr(obj, "name"):
        candidates = [obj]
    else:
        servers = getattr(obj, "mcp_servers", None)
        if isinstance(servers, dict):
            for s in servers.values():
                tl = getattr(s, "tools", None) or (s.get("tools") if isinstance(s, dict) else None) or []
                candidates.extend(tl)
        elif getattr(obj, "tools", None):
            candidates = list(obj.tools)

    out: dict[str, Callable] = {}
    for i, t in enumerate(candidates):
        name = _name_of(t, f"tool{i}")
        handler = getattr(t, "handler", None) or (t if callable(t) else None)
        if handler is None:
            continue
        if asyncio.iscoroutinefunction(handler):
            def _call(_h=handler, **kw):
                return _unwrap_claude(asyncio.run(_h(kw)))
        else:
            def _call(_h=handler, **kw):  # noqa: F811
                return _unwrap_claude(_h(kw))
        out[name] = _attach_schema((lambda _c=_call: (lambda **kw: _c(**kw)))(), t, name)
    prompt = getattr(obj, "system_prompt", None)
    return out, (str(prompt) if isinstance(prompt, str) else None)


EXTRACTORS: dict[str, Callable[[Any], tuple[dict[str, Callable], str | None]]] = {
    "langgraph": extract_langgraph,
    "smolagents": extract_smolagents,
    "crewai": extract_crewai,
    "openai-agents": extract_openai_agents,
    "claude": extract_claude,
}
