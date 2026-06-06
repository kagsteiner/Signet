# Signet — Recall Feature Specification

## Purpose

The Recall feature allows the writer to momentarily surface a concise memory about a word (e.g. character, place, concept) from within the manuscript.

It is not a tool.
It is not analysis.
It is not exploration.

It is a **brief resurfacing of narrative memory**.

The experience must feel like:
> “The manuscript remembers.”

---

## Core Principles

- The manuscript surface remains sacred.
- No visible AI system or session.
- No panels, no sidebars, no history.
- No lists, no structured outputs.
- No classification (no “character”, “location”, etc.).
- No interaction beyond invocation.
- Output must be brief, calm, and literary in tone.
- The feature must feel **ephemeral and non-intrusive**.

---

## Trigger / Interaction

### Desktop
- Double-click on a single word

### Mobile
- Long-press on a single word

### Behavior
- Trigger is intentional (no hover, no automatic activation)
- No UI affordance is permanently visible
- No explicit onboarding required (optional one-time subtle hint allowed)

---

## Visual Behavior

### Invocation
- Immediate, subtle acknowledgment:
  - Slight typographic hold or faint visual pulse near the word
  - No spinner
  - No loading indicator
  - No text like “Loading…”

### Success
- A small, floating text block appears near the selected word
- Max 3 lines
- No border, no box-heavy styling
- No labels, no headings
- Disappears automatically on:
  - further typing
  - clicking elsewhere
  - short timeout

### Failure / Timeout
- If no result is ready within strict latency threshold:
  - nothing appears
  - acknowledgment fades
- No error message
- No delayed appearance

> A late result must never appear.

---

## Latency Requirements

- Target: near-instant (sub-second ideal, ~1s acceptable)
- Hard timeout: ~1.5–2 seconds
- If exceeded → abort rendering

Rationale:
- A delayed response breaks immersion more than no response

---

## AI Behavior

### Model Requirements
- Small, fast LLM (let's go for gpt-5.4-mini)
- Optimized for:
  - summarization
  - compression
  - consistency
- Not optimized for:
  - creativity
  - expansion
  - stylistic flourish

---

## Prompting Guidelines

### Input
- Full manuscript (or relevant truncated context)
- Selected word
- Optional: Story Intent

### Instruction (conceptual)
- Determine what the selected word refers to within the manuscript
- Return a **very short reminder of its narrative meaning**
- Base strictly on the manuscript
- Do not invent missing information

### Output Constraints
- Maximum: 1–3 lines
- Plain text only
- No lists
- No bullet points
- No labels (e.g. not “Character:” or “Location:”)
- No meta commentary
- No uncertainty explanations

### Tone
- Neutral, literary, calm
- Reads like a marginal note or remembered fragment

---

## Output Examples

### Good
> John, the merchant from the harbor, who lost his brother early in the story.

> The northern forest where they first met, later abandoned after the fire.

### Bad
- “Character: John is a merchant…”
- “This refers to a person in the story…”
- Bullet lists or multiple options
- Overly long or analytical text
- Speculation beyond the manuscript

---

## Failure Handling

The model must not hallucinate.

If the reference is unclear:
- Prefer returning nothing (system suppresses output)
- Or return minimal internal signal → UI shows nothing

User must never see:
- guesses
- fabricated details
- hedging explanations

---

## Architectural Notes

- Recall is a **separate subsystem** from:
  - Gem (creative continuation)
  - Transformer (text rewriting)

- Different model profile than Gem:
  - Gem → high-quality, slower, creative
  - Recall → fast, constrained, extractive

---

## Non-Goals (Explicitly Forbidden)

- No classification logic exposed to user (name vs place etc.)
- No synonym suggestions
- No multi-option outputs
- No persistent UI elements
- No history or recall panel
- No highlighting of entities in text
- No auto-triggering

---

## Design Philosophy Summary

Recall is not a feature the user operates.

It is a **momentary resurfacing of narrative context**.

It should feel:
- immediate
- quiet
- reliable
- and then gone

If it becomes visible as a system,
it has failed.
