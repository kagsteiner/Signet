const chapters = require('../public/chapters');

function getBasePath(req, env = process.env) {
  const fromEnv = (env.BASE_PATH || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv.startsWith('/') ? fromEnv : `/${fromEnv}`;
  const fromRewrite = (req && req.basePathPrefix) || '';
  if (fromRewrite) return fromRewrite;
  const fromHeader = (req && typeof req.get === 'function' ? req.get('X-Script-Name') : '') || '';
  return fromHeader.replace(/\/$/, '');
}

function hasOuterMatchingQuotes(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const pairs = new Map([
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return pairs.has(first) && pairs.get(first) === last;
}

function stripOneOuterQuotePair(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const pairs = new Map([
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (pairs.has(first) && pairs.get(first) === last) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeRewriteResult(rawResult, selectedHasOuterQuotes) {
  let result = typeof rawResult === 'string' ? rawResult.trim() : '';
  if (!result) return result;
  if (!selectedHasOuterQuotes) {
    // Some models still wrap output in quotes even when instructed not to.
    result = stripOneOuterQuotePair(result);
  }
  return result;
}

function buildRewriteContext(fullText, startRaw, endRaw, selectedText) {
  if (typeof fullText !== 'string') return null;
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const safeStart = Math.max(0, Math.min(start, end, fullText.length));
  const safeEnd = Math.max(0, Math.min(Math.max(start, end), fullText.length));
  if (safeStart === safeEnd) return null;
  if (fullText.slice(safeStart, safeEnd) !== selectedText) return null;

  const chapterList = chapters.parseChapters(fullText);
  const containingChapter = chapters.getChapterAtOffset(chapterList, safeStart);
  if (!containingChapter) return null;

  const contextStart = containingChapter.startOffset;
  const contextEnd = containingChapter.endOffset;
  if (safeStart < contextStart || safeEnd > contextEnd) return null;

  const contextText = fullText.slice(contextStart, contextEnd);
  const relStart = safeStart - contextStart;
  const relEnd = safeEnd - contextStart;
  const marked =
    contextText.slice(0, relStart) +
    '<replace>' +
    contextText.slice(relStart, relEnd) +
    '</replace>' +
    contextText.slice(relEnd);

  return {
    contextChapterWithSelection: marked,
    chapterTitle: containingChapter.title && containingChapter.title.text
      ? containingChapter.title.text
      : null,
    selectedText,
  };
}

function buildRewriteMessages(selectedText, instruction, rewriteContext, storyIntentRaw) {
  const storyIntent = typeof storyIntentRaw === 'string' ? storyIntentRaw.trim() : '';
  const systemPrompt = `You are a literary editor.
Your task:
1) Identify the exact text between <replace> and </replace>.
2) Rewrite ONLY that selected text based on the instruction. Follow the instruction exactly.
3) Keep it consistent with the chapter context and story intent (if provided).

Output rules:
- Return ONLY the rewritten replacement text for the selected span.
- Do NOT return full paragraphs, markers, labels, or explanations.
- Do NOT add surrounding quotation marks unless the original selected text is itself surrounded by matching quotation marks.
- Do not include backticks.`;

  let userMessage = `Instruction: ${instruction}`;
  if (storyIntent) {
    userMessage += `\n\nStory intent (directional guidance):\n${storyIntent}`;
  }
  if (rewriteContext && rewriteContext.contextChapterWithSelection) {
    userMessage += `\n\nBelow is the full chapter containing the selected text.`;
    if (rewriteContext.chapterTitle) {
      userMessage += `\nChapter title: ${rewriteContext.chapterTitle}`;
    }
    userMessage += `\nThe selected span is wrapped with <replace>...</replace>.\n\n${rewriteContext.contextChapterWithSelection}`;
  } else {
    userMessage += `\n\nSelected span:\n<replace>${selectedText}</replace>`;
  }
  return { systemPrompt, userMessage };
}

module.exports = {
  getBasePath,
  hasOuterMatchingQuotes,
  stripOneOuterQuotePair,
  normalizeRewriteResult,
  buildRewriteContext,
  buildRewriteMessages,
};
