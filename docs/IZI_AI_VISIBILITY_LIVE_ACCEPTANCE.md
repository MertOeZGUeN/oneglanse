# IZI AI Visibility — Live Acceptance Gate

This gate validates the part CI cannot prove: that the current consumer UIs still accept prompts and expose the rendered answer and citation surfaces expected by the provider adapters.

## Scope

Run against authenticated consumer sessions for:

- ChatGPT
- Claude
- Gemini
- Perplexity

No model API may be used for prompt execution or analysis.

## Frozen test prompts

The executable frozen set is `config/visibility/gloria-live-acceptance-v1.json`.

1. `ACC-GENERAL-001`
   - Lens: `general`
   - Prompt: `What are the best luxury resorts in Belek for a high-end Mediterranean holiday?`
2. `ACC-SOURCES-001`
   - Lens: `comparative`
   - Prompt: `Compare several luxury resorts in Belek for golf, family facilities, dining and premium accommodation. Use web sources where available.`

## Running the gate locally

1. Start the local OneGlanse stack and authenticate the four consumer providers through the existing local auth flow.
2. Set `IZI_VISIBILITY_WORKSPACE_ID` and `IZI_VISIBILITY_USER_ID`, or pass `--workspace` and `--user` explicitly.
3. Run:

```bash
pnpm visibility:acceptance
```

The command builds the service dependencies, queues the frozen prompt set against ChatGPT, Claude, Gemini and Perplexity, waits for storage/analysis to settle, then prints an `izi.ai-visibility.live-acceptance.v1` JSON report. A non-passing provider makes the command exit non-zero.

For arbitrary versioned prompt sets:

```bash
pnpm visibility:submit -- --workspace <workspace-id> --user <user-id> --prompt-set config/visibility/gloria-v1.example.json --providers chatgpt,claude,gemini,perplexity --wait
```

## Gloria T0/T1 baseline

`config/visibility/gloria-baseline-v1.json` contains 16 unbranded discovery prompts: four intents across TR/EN/DE/RU, repeated three times per provider.

Use the same frozen prompt-set version before and after site changes and distinguish cohorts with `--run-label`:

```bash
pnpm visibility:baseline -- --run-label T0_PRE_CLOCKWORK_FIXES
pnpm visibility:baseline -- --run-label T1_POST_FIXES
```

`runLabel` and the canonical prompt definition id are persisted with every observation so the IZI SEO/GEO module can calculate a like-for-like delta without relying only on timestamps.

After both cohorts exist, run:

```bash
pnpm visibility:delta
```

The delta command defaults to `T0_PRE_CLOCKWORK_FIXES` versus `T1_POST_FIXES`. It returns overall and provider/language/lens/intent/prompt breakdowns for Mention Rate, Citation Rate, Top-3 Presence and Share of Voice in percentage-point deltas. It marks the comparison `comparable: false` if the prompt-set version or provider/prompt/repeat execution matrix differs between T0 and T1 rather than presenting a misleading change.

## Provider acceptance matrix

For each provider and each prompt, all applicable checks must pass:

| Check | PASS condition |
| --- | --- |
| Session | Authenticated consumer session opens without login wall |
| Submit | Prompt is entered and submitted in the real consumer UI |
| Clean chat | The prompt starts in a new/clean conversation |
| Completion | UI reaches completed answer state |
| Rendered response | Non-empty rendered answer is extracted from the UI |
| Sources | `ACC-SOURCES-001` produces at least one extracted visible citation/source |
| Screenshot | A PNG evidence file is written for every observation |
| Storage | Response, sources, capture status, screenshot path and visibility metadata are persisted |
| Run metadata | `runGroupId`, `runLabel`, prompt definition id/version, prompt-set version, language, lens, intent and repeat index survive round-trip storage |
| Deterministic analysis | Mention/citation/position metrics are produced without a second model call |

## Failure-state acceptance

A failed capture must never become a valid `no_brand` observation.

Expected classifications:

- expired/login wall → `login_required`
- bot/challenge/rate-limit/editor blocked → `blocked`
- completed UI with no usable answer → `no_answer` only when absence of an answer is positively established
- extraction/runtime failure → `capture_error`

`blocked`, `login_required`, `capture_error` and `no_answer` are excluded from visibility-rate denominators.

## Evidence required per observation

Keep the following together under the same run group:

- provider
- prompt execution id
- exact prompt text
- run label
- prompt-set id/version
- canonical prompt definition id/version
- language/lens/intent
- repeat index/total
- UTC capture timestamp
- rendered response text
- extracted source URLs/domains
- capture status
- screenshot path
- deterministic measurement JSON

## Release gate

The fork is eligible for integration into the Gloria SEO/GEO module only when:

1. CI typecheck passes.
2. Static IZI acceptance passes.
3. ChatGPT, Claude, Gemini and Perplexity each pass both frozen prompts in a real authenticated consumer session.
4. No provider failure is counted as brand absence.
5. No model API is required for analysis.

UI drift in any provider is a provider-specific FAIL, not a reason to lower the acceptance criteria.
