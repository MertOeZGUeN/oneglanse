# IZI / Gloria AI Visibility Fork

This branch keeps OneGlanse's consumer-UI capture layer and adapts analysis for Gloria Hotels & Resorts.

Current fork rules:

- No second-stage OpenAI or Anthropic API call is required for visibility measurement.
- ChatGPT, Claude, Gemini and Perplexity runs reset to a clean conversation between prompts.
- Measurement is deterministic: brand mention, tracked-property mention, tracked-competitor mention, position, owned-domain citation, citation URLs, source distribution and aggregate rates.
- The upstream composite GEO score is disabled rather than replaced with an opaque score.
- Prompt sets have an explicit versioned contract and remain user-editable.
- Gloria brand, property and competitor aliases live in a dedicated profile.

Next validation gate: repository typecheck, followed by live provider acceptance checks for prompt submission, rendered-response extraction, source extraction and clean-chat reset.
