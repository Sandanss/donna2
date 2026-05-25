---
name: mock-call-test-creator
description: Create Donna mock-call simulation tests for new voice features. Use when adding or reviewing Pipecat voice behavior, prompts, flow nodes, call types, tools, Quick Observer or Director behavior, post-call behavior, consent/discovery/onboarding flows, reminders, memory, or any feature that should be proven through LLM-vs-LLM simulated calls.
---

# Donna Mock Call Test Creator

Use this skill whenever a new voice feature needs test coverage beyond unit tests.
The deliverable is a real Donna mock-call scenario set under `pipecat/tests/simulation/`
with at least five distinct caller examples that exercise the new functionality.

## Start Here

1. Read `DIRECTORY.md`.
2. Read `docs/guides/MOCK_CALL_TESTING.md`.
3. Locate the changed voice surface:
   - prompts and phase behavior: `pipecat/prompts.py`
   - flow nodes and call-type entrypoints: `pipecat/flows/nodes.py`
   - LLM tool schemas and handlers: `pipecat/flows/tools.py`
   - Quick Observer: `pipecat/processors/patterns.py`, `pipecat/processors/quick_observer.py`
   - Director: `pipecat/processors/conversation_director.py`, `pipecat/services/director_llm.py`
   - post-call behavior: `pipecat/services/post_call.py`
4. Inspect existing patterns in:
   - `pipecat/tests/simulation/scenarios.py`
   - `pipecat/tests/test_sim_scenarios.py`
   - `pipecat/tests/test_live_simulation.py`
   - `pipecat/scripts/run_simulated_demo.py`

## Minimum Coverage

Create at least five distinct caller examples for each new voice feature.
More are expected when the behavior has more branches.

The five examples must differ by behavior or branch, not only by phrasing:

- happy path: the senior cooperates and the feature should succeed
- negative path: refusal, decline, cancellation, unsupported request, or no-op
- ambiguous path: fuzzy answer, partial answer, clarification, retry, or correction
- interruption path: off-topic pivot, senior asks another question, talks over the feature, or says goodbye early
- side-effect path: tool call, DB write, post-call extraction, memory injection, reminder update, consent rollup, or notification behavior

For multi-step flows, include examples that verify sequence and idempotency:
first answer wins, duplicate tool calls are suppressed, and later turns do not undo
the committed outcome unless the product explicitly supports that.

## Scenario Implementation

Add the scenarios as pure data. Prefer one scenario factory per behavior branch,
or a small factory helper that returns named `LiveSimScenario` cases.

Each scenario should set:

- `name`: stable machine-friendly identifier
- `description`: the behavior being tested
- `senior`: synthetic `TestSenior` only
- `persona`: synthetic caller identity and speech style
- `goals`: ordered `CallerGoal` entries with concrete `trigger_phrase` values
- `call_type`: the actual runtime call type
- `max_turns`: enough room for the branch, with a safety cap
- `expect_tool_calls`: every tool that should fire
- `expect_memories_injected`: true only when Director memory injection is expected
- `expect_post_call_analysis`: false for flows that intentionally skip analysis
- reminder fields when the scenario is a reminder call

Keep examples realistic for older adults, but never use real PHI. Do not place
real names, phone numbers, medical details, transcripts, or caregiver data in
fixtures, logs, screenshots, or test descriptions.

## Wiring Checklist

When adding a scenario family:

1. Add factories in `pipecat/tests/simulation/scenarios.py`.
2. Export them from `pipecat/tests/simulation/__init__.py`.
3. Add them to `SCENARIOS` in `pipecat/scripts/run_simulated_demo.py`.
4. Add pure scenario tests in `pipecat/tests/test_sim_scenarios.py`.
5. Add or extend `pipecat/tests/test_live_simulation.py` only for LLM/DB behavior that pure tests cannot prove.

Pure scenario tests should assert:

- at least five distinct examples exist for the feature
- names are unique and prefixed consistently
- each scenario has goals and trigger phrases
- call types match the feature
- expected tool calls match the feature
- branch coverage includes happy, negative, ambiguous, interruption, and side-effect cases
- post-call and memory expectation flags are intentional

## Tool Registration Safety

If the feature adds or changes LLM tools:

- Register call-type tool factories in `pipecat/flows/tools.py::_CALL_TYPE_TOOL_FACTORIES`.
- Use `select_flows_tools(session_state)` for both real calls and simulation.
- Add dispatch tests in `pipecat/tests/test_tools.py` for the call type's tool set.
- Ensure every tool expected by `expect_tool_calls` is tracked in `session_state["_tools_used"]`.
- For custom call-type tools, verify their handlers have the same tracking behavior as `make_tool_handlers`.
- Check that `bot.py` and `pipecat/tests/simulation/pipeline.py` expose the same tools for the same `call_type`.

This is required because a scenario can appear conversationally successful while
failing to register the tool call that proves the feature's side effect.

## Validation

Run the smallest useful checks first:

```bash
cd pipecat && uv run python -m pytest tests/test_sim_scenarios.py -q
```

If tools changed:

```bash
cd pipecat && uv run python -m pytest tests/test_tools.py -q
```

If live simulation behavior changed and required secrets are available:

```bash
cd pipecat && uv run python -m pytest tests/test_live_simulation.py -m llm_simulation -q
```

Do not require real Telnyx for these tests. Use real Telnyx only for carrier,
caller-ID, wire-audio, and production environment validation.

## Output

When finished, report:

- the five or more examples added and which branch each covers
- files changed
- validation commands run and their results
- any behavior that still needs a real Telnyx call or live environment evidence
