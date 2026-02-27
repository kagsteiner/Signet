(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.SignetChapters = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIVIDER_STYLES = ['*', '---', '-*-'];
  const DIVIDER_SET = new Set(DIVIDER_STYLES);

  function isDividerLine(line) {
    return DIVIDER_SET.has((line || '').trim());
  }

  function splitLinesWithOffsets(text) {
    const source = typeof text === 'string' ? text : '';
    const lines = [];

    if (source.length === 0) {
      lines.push({
        text: '',
        trimmed: '',
        startOffset: 0,
        endOffset: 0,
        fullEndOffset: 0,
      });
      return lines;
    }

    let offset = 0;
    while (offset <= source.length) {
      const start = offset;
      while (offset < source.length && source[offset] !== '\n' && source[offset] !== '\r') {
        offset += 1;
      }
      const end = offset;

      let newlineLength = 0;
      if (offset < source.length) {
        if (source[offset] === '\r' && source[offset + 1] === '\n') {
          newlineLength = 2;
        } else {
          newlineLength = 1;
        }
      }

      const fullEndOffset = end + newlineLength;
      lines.push({
        text: source.slice(start, end),
        trimmed: source.slice(start, end).trim(),
        startOffset: start,
        endOffset: end,
        fullEndOffset,
      });

      if (newlineLength === 0) break;
      offset = fullEndOffset;
    }

    return lines;
  }

  function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function buildChapterId(index, dividerStyle, titleText, chapterText) {
    const normalizedWindow = chapterText.replace(/\s+/g, ' ').trim().slice(0, 160);
    const signature = `${dividerStyle || 'start'}|${titleText || ''}|${normalizedWindow}`;
    return `ch_${index + 1}_${hashString(signature)}`;
  }

  function parseChapters(manuscriptText) {
    const text = typeof manuscriptText === 'string' ? manuscriptText : '';
    const lines = splitLinesWithOffsets(text);
    const chapters = [];

    let chapterStart = 0;
    let pendingDividerStyle = null;
    let i = 0;

    while (i < lines.length) {
      if (!isDividerLine(lines[i].text)) {
        i += 1;
        continue;
      }

      const dividerStartOffset = lines[i].startOffset;
      chapters.push({
        startOffset: chapterStart,
        endOffset: dividerStartOffset,
        dividerStyle: pendingDividerStyle || undefined,
      });

      let dividerStyle = lines[i].trimmed;
      while (i < lines.length && isDividerLine(lines[i].text)) {
        dividerStyle = lines[i].trimmed;
        i += 1;
      }

      while (i < lines.length && lines[i].trimmed === '') {
        i += 1;
      }

      chapterStart = i < lines.length ? lines[i].startOffset : text.length;
      pendingDividerStyle = dividerStyle;
    }

    chapters.push({
      startOffset: chapterStart,
      endOffset: text.length,
      dividerStyle: pendingDividerStyle || undefined,
    });

    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
      const chapter = chapters[chapterIndex];
      let title;

      if (chapter.dividerStyle) {
        for (const line of lines) {
          if (line.startOffset < chapter.startOffset) continue;
          if (line.startOffset >= chapter.endOffset) break;
          if (line.trimmed === '') continue;
          title = {
            text: line.trimmed,
            startOffset: line.startOffset,
            endOffset: line.endOffset,
          };
          break;
        }
      }

      const chapterText = text.slice(chapter.startOffset, chapter.endOffset);
      const titleText = title ? title.text : '';
      chapter.id = buildChapterId(chapterIndex, chapter.dividerStyle, titleText, chapterText);
      if (title) chapter.title = title;
    }

    return chapters;
  }

  function getChapterAtOffset(chapters, offset) {
    if (!Array.isArray(chapters) || chapters.length === 0) return null;
    const target = Math.max(0, offset | 0);

    let low = 0;
    let high = chapters.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const chapter = chapters[mid];
      if (target < chapter.startOffset) {
        high = mid - 1;
      } else if (target >= chapter.endOffset) {
        low = mid + 1;
      } else {
        return chapter;
      }
    }

    const last = chapters[chapters.length - 1];
    if (target >= last.endOffset) return last;
    return chapters[0];
  }

  function getChapterContext(chapters, offset) {
    const current = getChapterAtOffset(chapters, offset);
    if (!current) return { current: null, before: [], after: [] };

    const idx = chapters.findIndex((chapter) => chapter.id === current.id);
    if (idx < 0) return { current, before: [], after: [] };
    return {
      current,
      before: chapters.slice(0, idx),
      after: chapters.slice(idx + 1),
    };
  }

  return {
    DIVIDER_STYLES,
    isDividerLine,
    splitLinesWithOffsets,
    parseChapters,
    getChapterAtOffset,
    getChapterContext,
  };
});
