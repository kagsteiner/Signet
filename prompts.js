function buildContinuationPrompt(storyIntent, modeRaw) {
  const mode = typeof modeRaw === 'string' ? modeRaw : 'default';
  let prompt = `You are a literary ghost writer. You write exactly one sentence to continue the narrative.

Rules:
- Output ONLY the continuation sentence. Nothing else.
- Exactly one complete sentence, ending with appropriate punctuation.
- Maximum 25-30 words.
- Match the tense, POV, and tone of the preceding text.
- Avoid clichés, exposition dumps, meta commentary, and summarizing.
- The sentence must feel like a natural next beat in the story.
- Never explain yourself. Never add quotes or attribution to your output.
Story intent: The Story Intent may contain future planned events or outcomes.
Do NOT prematurely realize events described in the Story Intent.
First determine the current narrative state based solely on the manuscript text.
Identify what has actually happened so far.
Continue causally and temporally from that point.
Use the Story Intent only as directional guidance for where the story should eventually move — not as events that have already occurred.
Never introduce consequences before the manuscript has reached the event that causes them.`;
  if (mode === 'mid_sentence') {
    prompt += `\n\nMode: mid-sentence completion.
- Continue from the exact in-progress sentence at the cursor.
- Match diction, rhythm, and emotional texture as tightly as possible.
- Output only the missing continuation text to insert at the cursor.
- Do not repeat text already provided before the cursor.
- End naturally (punctuation is allowed if it fits).`;
  } else if (mode === 'paragraph_start') {
    prompt += `\n\nMode: beginning-of-paragraph continuation.
- The cursor is at a blank new paragraph boundary.
- Infer immediate narrative intent from recent context and story intent.
- Write one plausible paragraph-opening sentence that moves the story forward.
- Prefer concrete action, decision, or sensory shift over abstract summary.`;
  }

  if (storyIntent) prompt += `\n\nStory intent: ${storyIntent}`;
  return prompt;
}

function buildContinuationUserMessage(precedingText, followingText, modeRaw) {
  const mode = typeof modeRaw === 'string' ? modeRaw : 'default';
  if (mode === 'mid_sentence') {
    return `Text before cursor:\n${precedingText}\n\nText after cursor (may be empty):\n${followingText || ''}\n\nWrite the exact continuation text to insert at the cursor.`;
  }
  if (mode === 'paragraph_start') {
    return `Text before cursor:\n${precedingText}\n\nText after cursor (may be empty):\n${followingText || ''}\n\nWrite one opening sentence for the new paragraph at the cursor.`;
  }
  return `Continue this text with exactly one sentence:\n\n${precedingText}`;
}

function buildRecallPrompt(storyIntentRaw) {
  const storyIntent = typeof storyIntentRaw === 'string' ? storyIntentRaw.trim() : '';
  let prompt = `You are resurfacing narrative memory from a manuscript.

Your task:
- Determine what the selected word refers to within the manuscript context.
- Return a very short reminder of its narrative meaning.
- Base your answer strictly on the manuscript.
- Do not invent missing information.

Output rules:
- Plain text only.
- Maximum 3 short lines.
- No bullet points or numbered lists.
- No labels, headings, or category words like "Character" or "Location".
- No meta commentary, analysis, or uncertainty explanations.
- Keep the tone calm, neutral, literary, and restrained.

If the reference is unclear, return NOTHING.`;

  if (storyIntent) {
    prompt += `\n\nStory intent (directional guidance only, not established fact): ${storyIntent}`;
  }

  return prompt;
}

function buildRecallUserMessage(selectedText, recallContext) {
  const target = typeof selectedText === 'string' ? selectedText.trim() : '';
  let message = `Selected word: ${target}`;

  if (recallContext && recallContext.contextChapterWithSelection) {
    message += `\n\nBelow is the chapter containing the selected word. The selected word is wrapped with <recall>...</recall>.`;
    if (recallContext.chapterTitle) {
      message += `\nChapter title: ${recallContext.chapterTitle}`;
    }
    if (recallContext.previousChapterTitle) {
      message += `\nPrevious chapter: ${recallContext.previousChapterTitle}`;
    }
    if (recallContext.nextChapterTitle) {
      message += `\nNext chapter: ${recallContext.nextChapterTitle}`;
    }
    message += `\n\n${recallContext.contextChapterWithSelection}`;
    return message;
  }

  return `${message}\n\nSelected word in manuscript:\n<recall>${target}</recall>`;
}

function buildPremiumContinuationPrompt(storyIntent, modeRaw) {
  const mode = typeof modeRaw === 'string' ? modeRaw : 'default';
  let prompt = `You are a literary ghost writer performing a premium sentence continuation.

Your task has two phases.

PHASE 1 — GENERATION
Generate exactly three distinct candidate sentences to continue the narrative.
Each candidate must:
- Be exactly one complete sentence with appropriate punctuation.
- Maximum 25–30 words.
- Match the tense, POV, and tone of the preceding text.
- Avoid clichés, exposition dumps, meta commentary, and summarizing.
- Feel like a natural next beat in the story.
Make the three candidates meaningfully different — vary imagery, pacing, focus, or narrative angle.

Story intent: The Story Intent may contain future planned events or outcomes.
Do NOT prematurely realize events described in the Story Intent.
First determine the current narrative state based solely on the manuscript text.
Identify what has actually happened so far.
Continue causally and temporally from that point.
Use the Story Intent only as directional guidance for where the story should eventually move — not as events that have already occurred.
Never introduce consequences before the manuscript has reached the event that causes them.

PHASE 2 — EVALUATION
Rate each candidate on three criteria (0–10 scale):

1. Style: How closely does the sentence match the voice, rhythm, diction, and literary register of the existing text? 0 = completely off; 10 = indistinguishable from the author.
2. Metaphors: If the sentence contains metaphor or figurative language, is it fresh, grounded, and plausible for humans — reflecting how people actually think about the objects of the metaphor? Metaphors about locations or objects must reflect physical reality. Cheesy, overwrought, or trivially obvious metaphors score low. If no figurative language is present, score 5 (neutral).
3. Plot progression: Does the sentence move the story forward in a way that is interesting, causally grounded in what precedes it, and consistent with the story's apparent direction? 0 = irrelevant or contradictory; 10 = the perfect next beat.

OUTPUT FORMAT — You MUST output valid JSON and nothing else:
{"candidates":[{"text":"...","style":N,"metaphors":N,"plot":N},{"text":"...","style":N,"metaphors":N,"plot":N},{"text":"...","style":N,"metaphors":N,"plot":N}]}`;

  if (mode === 'mid_sentence') {
    prompt += `\n\nMode: mid-sentence completion.
- Continue from the exact in-progress sentence at the cursor.
- Match diction, rhythm, and emotional texture as tightly as possible.
- Each candidate outputs only the missing continuation text to insert at the cursor.
- Do not repeat text already provided before the cursor.
- End naturally (punctuation is allowed if it fits).`;
  } else if (mode === 'paragraph_start') {
    prompt += `\n\nMode: beginning-of-paragraph continuation.
- The cursor is at a blank new paragraph boundary.
- Infer immediate narrative intent from recent context and story intent.
- Write plausible paragraph-opening sentences that move the story forward.
- Prefer concrete action, decision, or sensory shift over abstract summary.`;
  }

  if (storyIntent) prompt += `\n\nStory intent: ${storyIntent}`;
  return prompt;
}

function buildPremiumContinuationUserMessage(precedingText, followingText, modeRaw) {
  const mode = typeof modeRaw === 'string' ? modeRaw : 'default';
  if (mode === 'mid_sentence') {
    return `Text before cursor:\n${precedingText}\n\nText after cursor (may be empty):\n${followingText || ''}\n\nGenerate three candidate continuation texts to insert at the cursor. Output JSON only.`;
  }
  if (mode === 'paragraph_start') {
    return `Text before cursor:\n${precedingText}\n\nText after cursor (may be empty):\n${followingText || ''}\n\nGenerate three candidate opening sentences for the new paragraph. Output JSON only.`;
  }
  return `Continue this text with three candidate sentences:\n\n${precedingText}\n\nOutput JSON only.`;
}

function parsePremiumContinuationResult(raw) {
  const text = (raw || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { sentence: text, parsed: false };

  try {
    const data = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
      return { sentence: text, parsed: false };
    }

    let best = null;
    let bestScore = -1;
    for (const c of data.candidates) {
      const score = (Number(c.style) || 0) + (Number(c.metaphors) || 0) + (Number(c.plot) || 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return { sentence: (best.text || '').trim(), parsed: true, candidates: data.candidates, score: bestScore };
  } catch {
    return { sentence: text, parsed: false };
  }
}

module.exports = {
  buildContinuationPrompt,
  buildContinuationUserMessage,
  buildPremiumContinuationPrompt,
  buildPremiumContinuationUserMessage,
  parsePremiumContinuationResult,
  buildRecallPrompt,
  buildRecallUserMessage,
};
