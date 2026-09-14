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

Use a fresh run group for each acceptance attempt.

1. `ACC-GENERAL-001`
   - Lens: `general`
   - Prompt: `What are the best luxury resorts in Belek for a high-end Mediterranean holiday?`
2. `ACC-SOURCES-001`
   - Lens: `comparative`
   - Prompt: `Compare several luxury resorts in Belek for golf, family facilities, dining and premium accommodation. Use web sources where available.`

## Provider acceptance matrix

For each provider and each prompt, all applicable checks must pass:

| Check | PASS condition |
| --- | --- |
| Session | Authenticated consumer session opens without login wall |
| Submit | Prompt is entered and submitted in the real consumer UI |
| Clean chat | The prompt starts in a new/clean conversation |
| Completion | UI reaches completed answer state |
| Rendered response | Non-empty rendered answer is extracted from the UI |
| Sources | Visible citation/source surface is extracted when the provider exposes one |
| Screenshot | A PNG evidence file is written for the observation |
| Storage | Response, sources, capture status, screenshot path and visibility metadata are persisted |
| Run metadata | `runGroupId`, prompt-set version, language, lens, intent and repeat index survive round-trip storage |
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
- prompt-set id/version
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
