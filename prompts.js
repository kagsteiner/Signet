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

module.exports = { buildContinuationPrompt, buildContinuationUserMessage };
