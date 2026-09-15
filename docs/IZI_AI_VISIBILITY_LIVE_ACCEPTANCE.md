# IZI AI Visibility — Live Acceptance Gate

This gate validates the part CI cannot prove: that the current consumer UIs still accept prompts and expose the rendered answer and citation surfaces expected by the provider adapters.

## Scope

Run against authenticated consumer sessions for:

- ChatGPT
- Claude
- Gemini
- Perplexity

No model API may be used for prompt execution or analysis.

The Gloria visibility path is intentionally Dockerless. It does not require PostgreSQL, ClickHouse, Redis, Docker Desktop, WSL, or an upstream OneGlanse workspace. Those services remain part of the original OneGlanse SaaS/local stack, but are not required for the Gloria consumer-UI measurement workflow.

## Frozen test prompts

The executable frozen set is `config/visibility/gloria-live-acceptance-v1.json`.

1. `ACC-GENERAL-001`
   - Lens: `general`
   - Prompt: `What are the best luxury resorts in Belek for a high-end Mediterranean holiday?`
2. `ACC-SOURCES-001`
   - Lens: `comparative`
   - Prompt: `Compare several luxury resorts in Belek for golf, family facilities, dining and premium accommodation. Use web sources where available.`

The deterministic Gloria entity profile is `config/visibility/gloria-profile-v1.json`.

## Dockerless local workflow

Provider sessions are stored under `.oneglanse-storage/auth`. The visibility runner executes providers sequentially on the local machine, writes raw evidence to `.oneglanse-storage/visibility-runs`, and derives metrics without a second model call.

### 1. Check session readiness

```bash
pnpm visibility:preflight
```

Preflight is file-backed only. It does not connect to a database or queue and does not send prompts. It reports each required provider as `ready`, `login_required`, `auth_in_progress`, or `auth_error`.

### 2. Authenticate providers

To connect all four providers:

```bash
pnpm visibility:auth
```

To connect only one provider:

```bash
pnpm visibility:auth -- --providers chatgpt
```

For each provider, finish sign-in in the visible Camoufox window and close the auth window when done. The session is saved locally. No auth upload is required for this workflow.

Run preflight again after login:

```bash
pnpm visibility:preflight
```

### 3. Run live acceptance

```bash
pnpm visibility:acceptance
```

The runner expands the frozen versioned prompt set, opens the real authenticated consumer UI for each provider, captures rendered response text, extracted sources, capture status and screenshots, then produces deterministic visibility measurements.

Each run is written under:

```text
.oneglanse-storage/visibility-runs/<run>/
├── run.json
├── evidence-manifest.json
├── acceptance-report.json
└── screenshots/
```

`run.json` contains the raw rendered response, extracted sources and deterministic measurement for every observation. `evidence-manifest.json` is the compact evidence index. `acceptance-report.json` contains the provider PASS/FAIL matrix.

For arbitrary versioned prompt sets:

```bash
pnpm visibility:submit -- --prompt-set config/visibility/gloria-live-acceptance-v1.json --providers chatgpt,claude
```

## Gloria T0/T1 baseline

`config/visibility/gloria-baseline-v1.json` contains 16 unbranded discovery prompts: four intents across TR/EN/DE/RU, repeated three times per provider.

Use the same frozen prompt-set version before and after site changes and distinguish cohorts with `--run-label`:

```bash
pnpm visibility:baseline -- --run-label T0_PRE_CLOCKWORK_FIXES
pnpm visibility:baseline -- --run-label T1_POST_FIXES
```

The local run document persists `runGroupId`, `runLabel`, canonical prompt definition id/version, prompt-set version, provider, language, lens, intent and repeat index with every observation.

After both cohorts exist, run:

```bash
pnpm visibility:delta
```

The local delta command resolves the latest runs labeled `T0_PRE_CLOCKWORK_FIXES` and `T1_POST_FIXES`, validates the prompt-set version and provider/prompt/repeat execution matrix, and only then calculates percentage-point deltas for Mention Rate, Citation Rate, Top-3 Presence and Share of Voice. It writes `delta-report.json` next to the T1 run. A mismatched cohort is returned as `comparable: false` rather than being presented as a clean change.

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
| Local evidence | Raw response, sources, capture status, screenshot path and run metadata are written to the run folder |
| Run metadata | `runGroupId`, `runLabel`, prompt definition id/version, prompt-set version, language, lens, intent and repeat index survive in local evidence |
| Deterministic analysis | Mention/citation/position metrics are produced without a second model call |

## Failure-state acceptance

A failed capture must never become a valid `no_brand` observation.

Expected classifications:

- expired/login wall → `login_required`
- bot/challenge/rate-limit/editor blocked → `blocked`
- completed UI with no usable answer → `no_answer` only when absence of an answer is positively established
- extraction/runtime failure → `capture_error`

`blocked`, `login_required`, `capture_error` and `no_answer` are excluded from visibility-rate denominators. A completed response that simply does not mention Gloria becomes deterministic `no_brand` while its capture itself remains successful.

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
6. The Gloria visibility commands run without Docker/PostgreSQL/ClickHouse/Redis.

UI drift in any provider is a provider-specific FAIL, not a reason to lower the acceptance criteria.
