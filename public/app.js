(function () {
  'use strict';

  const Chapters = window.SignetChapters || {};
  const APP_BASE_PATH = window.location.pathname.replace(/\/app\/?$/, '');

  // --- State ---
  let currentStory = null;
  let currentChapters = [];
  let currentChapterContext = { current: null, before: [], after: [] };
  let stories = [];
  let saveTimer = null;
  let intentSaveTimer = null;
  let metadataSaveTimer = null;
  let isSaving = false;
  let gemHintShown = localStorage.getItem('gemHintShown') === '1';
  let storyPanelHideTimer = null;
  const HISTORY_LIMIT = 100;
  let undoStack = [];
  let redoStack = [];
  let pendingBeforeInputSnapshot = null;
  let isApplyingHistory = false;
  let lastKnownEditorText = '';
  let gemIdleTimer = null;
  let gemLastTypingTimestamp = 0;
  let remoteRefreshTimer = null;
  let remoteRefreshInFlight = false;
  const isMacPlatform = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');
  const userAgent = navigator.userAgent || '';
  const isIOSDevice = /iPad|iPhone|iPod/.test(userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  const isAndroidDevice = /Android/.test(userAgent);
  const shouldUseMobileRewritePositioning = isIOSDevice || isAndroidDevice;
  const CURSOR_BOTTOM_PADDING_LINES = 3;
  const GEM_IDLE_APPEAR_DELAY_MS = 1000;
  const GEM_END_OFFSET_PX = 8;
  const RECALL_TIMEOUT_MS = 1700;
  const RECALL_DISMISS_MS = 4200;
  const RECALL_LONG_PRESS_DELAY_MS = 480;
  const RECALL_TRIGGER_WINDOW_MS = 700;
  const RECALL_SELECTION_MIN_LENGTH = 2;

  // --- DOM refs ---
  const titleBtn = document.getElementById('story-title-btn');
  const saveIndicator = document.getElementById('save-indicator');
  const editorContainer = document.getElementById('editor-container');
  const editor = document.getElementById('editor');
  const gemContainer = document.getElementById('gem-container');
  const gem = document.getElementById('gem');
  const storyIntentEl = document.getElementById('story-intent');
  const storyTitleInput = document.getElementById('story-title-input');
  const storyAuthorInput = document.getElementById('story-author-input');
  const storyPanel = document.getElementById('story-panel');
  const storyPanelBackdrop = document.getElementById('story-panel-backdrop');
  const storyPanelChapters = document.getElementById('story-panel-chapters');
  const manageStoriesLink = document.getElementById('manage-stories-link');
  const storyOverlay = document.getElementById('story-overlay');
  const storyList = document.getElementById('story-list');
  const newStoryBtn = document.getElementById('new-story-btn');
  const exportMdBtn = document.getElementById('export-md-btn');
  const exportTxtBtn = document.getElementById('export-txt-btn');
  const rewriteOverlay = document.getElementById('rewrite-overlay');
  const rewriteSelected = document.getElementById('rewrite-selected');
  const rewriteInput = document.getElementById('rewrite-input');
  const rewritePreview = document.getElementById('rewrite-preview');
  const rewriteDiff = document.getElementById('rewrite-diff');
  const rewriteAccept = document.getElementById('rewrite-accept');
  const rewriteReject = document.getElementById('rewrite-reject');
  const gemHint = document.getElementById('gem-hint');
  const recallPulse = document.getElementById('recall-pulse');
  const recallOverlay = document.getElementById('recall-overlay');

  // --- API helpers ---
  async function api(url, opts = {}) {
    const resolvedUrl = url.startsWith('/') ? `${APP_BASE_PATH}${url}` : url;
    const res = await fetch(resolvedUrl, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
    });
    if (res.status === 401) {
      window.location.href = `${APP_BASE_PATH}/`;
      return null;
    }
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  // --- Initialization ---
  async function init() {
    const data = await api('/api/stories');
    if (!data) return;
    stories = data.stories;

    if (stories.length === 0) {
      const result = await api('/api/stories', { method: 'POST', body: JSON.stringify({}) });
      if (!result) return;
      stories = [result.story];
    }

    await loadStory(stories[0].id);
  }

  async function loadStory(storyId) {
    const data = await api(`/api/stories/${storyId}`);
    if (!data) return;
    currentStory = data.story;
    renderStory();
  }

  function hasUnsavedLocalChanges() {
    if (!currentStory) return false;
    const localText = getEditorText();
    const knownServerText = currentStory.content_markdown || '';
    return isSaving || Boolean(saveTimer) || localText !== knownServerText;
  }

  function applyStoryFromServer(storyFromServer) {
    if (!storyFromServer) return;
    const previousSelection = getSelectionSnapshot();
    const previousScrollY = window.scrollY;
    currentStory = storyFromServer;

    setStoryPanelFields(currentStory);
    storyIntentEl.value = currentStory.story_intent || '';

    const nextText = currentStory.content_markdown || '';
    const nextStart = Math.min(previousSelection.start, nextText.length);
    const nextEnd = Math.min(previousSelection.end, nextText.length);
    renderEditorText(nextText, { cursorOffset: nextEnd });
    setSelectionOffsets(nextStart, nextEnd);
    refreshStoryHeaderLabel(nextText);
    lastKnownEditorText = nextText;
    resetHistoryForText(nextText);
    updateGemVisibility();

    window.requestAnimationFrame(() => {
      window.scrollTo({ top: previousScrollY, left: 0, behavior: 'auto' });
    });
  }

  async function refreshCurrentStoryIfUpdated() {
    if (!currentStory || remoteRefreshInFlight) return;
    if (hasUnsavedLocalChanges()) return;
    remoteRefreshInFlight = true;
    try {
      const data = await api(`/api/stories/${currentStory.id}`);
      if (!data || !data.story) return;
      const nextStory = data.story;
      const localLastModified = Number(currentStory.last_modified) || 0;
      const remoteLastModified = Number(nextStory.last_modified) || 0;
      const hasChanged =
        remoteLastModified > localLastModified
        || nextStory.content_markdown !== (currentStory.content_markdown || '')
        || (nextStory.title || '') !== (currentStory.title || '')
        || (nextStory.author || '') !== (currentStory.author || '')
        || (nextStory.story_intent || '') !== (currentStory.story_intent || '');
      if (!hasChanged) return;

      applyStoryFromServer(nextStory);
      saveIndicator.textContent = 'Updated';
      setTimeout(() => {
        if (saveIndicator.textContent === 'Updated') saveIndicator.textContent = '';
      }, 2000);
    } catch {
      // silent refresh failure
    } finally {
      remoteRefreshInFlight = false;
    }
  }

  function scheduleRemoteRefresh() {
    if (remoteRefreshTimer) clearTimeout(remoteRefreshTimer);
    remoteRefreshTimer = setTimeout(() => {
      remoteRefreshTimer = null;
      refreshCurrentStoryIfUpdated();
    }, 250);
  }

  function renderStory() {
    setStoryPanelFields(currentStory);
    refreshStoryHeaderLabel(currentStory.content_markdown || '');
    storyIntentEl.value = currentStory.story_intent || '';
    const storyText = currentStory.content_markdown || '';
    setEditorContent(storyText);
    resetHistoryForText(storyText);
    requestAnimationFrame(() => {
      focusEditorAtEnd();
    });
    updateGemVisibility();
  }

  // --- Editor text + chapter rendering ---
  function setEditorContent(text) {
    renderEditorText(text || '', {});
  }

  function getLineElements() {
    return Array.from(editor.querySelectorAll('.editor-line'));
  }

  function normalizePlainText(value) {
    return typeof value === 'string' ? value.replace(/\u00A0/g, ' ') : '';
  }

  function getLineRawText(line) {
    if (!line) return '';
    return normalizePlainText(line.textContent || '');
  }

  function getEditorText() {
    const lines = getLineElements();
    if (lines.length === 0) return normalizePlainText(editor.textContent || '');
    return lines.map((line) => getLineRawText(line)).join('\n');
  }

  function ornamentForDivider(style) {
    if (style === '*') return '✶';
    if (style === '-*-') return '— ✶ —';
    return '— • —';
  }

  function renderEditorText(text, opts = {}) {
    const parsedText = typeof text === 'string' ? text : '';
    const lines = Chapters.splitLinesWithOffsets
      ? Chapters.splitLinesWithOffsets(parsedText)
      : [{ text: parsedText, trimmed: parsedText.trim(), startOffset: 0, endOffset: parsedText.length, fullEndOffset: parsedText.length }];

    currentChapters = Chapters.parseChapters ? Chapters.parseChapters(parsedText) : [];
    const titleStarts = new Set(
      currentChapters
        .filter((chapter) => chapter.title)
        .map((chapter) => chapter.title.startOffset)
    );

    const fragment = document.createDocumentFragment();
    let previousWasDivider = false;
    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'editor-line';

      if (line.text === '') {
        lineEl.appendChild(document.createElement('br'));
      } else {
        lineEl.textContent = line.text;
      }

      if (Chapters.isDividerLine && Chapters.isDividerLine(line.text)) {
        const style = line.trimmed;
        lineEl.classList.add('chapter-divider');
        lineEl.dataset.dividerStyle = style;
        lineEl.dataset.ornament = ornamentForDivider(style);
        if (previousWasDivider) lineEl.classList.add('chapter-divider-coalesced');
        previousWasDivider = true;
      } else {
        previousWasDivider = false;
      }

      if (titleStarts.has(line.startOffset)) {
        lineEl.classList.add('chapter-title');
      }

      fragment.appendChild(lineEl);
    }

    editor.replaceChildren(fragment);

    if (typeof opts.cursorOffset === 'number') {
      setCursorOffset(opts.cursorOffset);
    }

    refreshChapterContextAtCursor();
    if (!storyPanel.classList.contains('hidden')) renderStoryPanelChapters();
  }

  function computeOffsetFromPosition(container, containerOffset) {
    const lines = getLineElements();
    if (lines.length === 0) return 0;
    const line = container.nodeType === Node.ELEMENT_NODE && container.classList && container.classList.contains('editor-line')
      ? container
      : container.parentElement ? container.parentElement.closest('.editor-line') : null;
    if (!line || !editor.contains(line)) return getEditorText().length;

    const lineIndex = lines.indexOf(line);
    if (lineIndex < 0) return 0;

    let offset = 0;
    for (let i = 0; i < lineIndex; i += 1) {
      offset += getLineRawText(lines[i]).length;
      offset += 1; // newline between rendered lines
    }

    const intraRange = document.createRange();
    intraRange.selectNodeContents(line);
    intraRange.setEnd(container, containerOffset);
    const intraOffset = intraRange.toString().length;
    offset += Math.min(intraOffset, getLineRawText(line).length);
    return Math.max(0, Math.min(offset, getEditorText().length));
  }

  function getCursorOffset() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    return computeOffsetFromPosition(range.startContainer, range.startOffset);
  }

  function getSelectionOffsets() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const start = computeOffsetFromPosition(range.startContainer, range.startOffset);
    const end = computeOffsetFromPosition(range.endContainer, range.endOffset);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  }

  function setCursorOffset(offset) {
    const lines = getLineElements();
    if (lines.length === 0) return;

    const totalLength = getEditorText().length;
    let remaining = Math.max(0, Math.min(offset, totalLength));

    const selection = window.getSelection();
    const range = document.createRange();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineText = getLineRawText(line);
      if (remaining <= lineText.length || i === lines.length - 1) {
        if (line.firstChild && line.firstChild.nodeType === Node.TEXT_NODE) {
          range.setStart(line.firstChild, Math.min(remaining, lineText.length));
        } else {
          range.setStart(line, line.childNodes.length);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= lineText.length;
      if (remaining > 0) remaining -= 1;
    }
  }

  function getSelectionSnapshot() {
    const offsets = getSelectionOffsets();
    if (offsets) return { start: offsets.start, end: offsets.end };
    const cursor = getCursorOffset();
    return { start: cursor, end: cursor };
  }

  function resolvePositionForOffset(offset) {
    const lines = getLineElements();
    if (lines.length === 0) return null;

    const totalLength = getEditorText().length;
    let remaining = Math.max(0, Math.min(offset, totalLength));

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineText = getLineRawText(line);
      if (remaining <= lineText.length || i === lines.length - 1) {
        if (line.firstChild && line.firstChild.nodeType === Node.TEXT_NODE) {
          return {
            container: line.firstChild,
            offset: Math.min(remaining, lineText.length),
          };
        }
        return { container: line, offset: line.childNodes.length };
      }
      remaining -= lineText.length;
      if (remaining > 0) remaining -= 1;
    }

    return null;
  }

  function setSelectionOffsets(start, end) {
    const startPos = resolvePositionForOffset(start);
    const endPos = resolvePositionForOffset(end);
    if (!startPos || !endPos) return;

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(startPos.container, startPos.offset);
    range.setEnd(endPos.container, endPos.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function focusEditorAtEnd() {
    if (!editor) return;
    editor.focus({ preventScroll: true });
    setCursorOffset(getEditorText().length);
    ensureCursorBottomPadding();
  }

  function focusEditorAtOffset(offset) {
    if (!editor) return;
    editor.focus({ preventScroll: true });
    setCursorOffset(offset);
    ensureCursorBottomPadding();
  }

  function getEditorLineHeightPx() {
    const style = window.getComputedStyle(editor);
    const parsedLineHeight = parseFloat(style.lineHeight);
    if (Number.isFinite(parsedLineHeight)) return parsedLineHeight;
    const parsedFontSize = parseFloat(style.fontSize);
    if (Number.isFinite(parsedFontSize)) return parsedFontSize * 1.85;
    return 32;
  }

  function ensureCursorBottomPadding() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return;

    const rect = range.getBoundingClientRect();
    if (!rect || rect.height === 0) return;

    const lineHeight = getEditorLineHeightPx();
    const minimumBottomSpace = lineHeight * CURSOR_BOTTOM_PADDING_LINES;
    const threshold = window.innerHeight - minimumBottomSpace;
    if (rect.bottom <= threshold) return;

    const delta = rect.bottom - threshold;
    window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
  }

  function makeSnapshot(text, selection) {
    return {
      text: typeof text === 'string' ? text : '',
      selectionStart: selection.start,
      selectionEnd: selection.end,
    };
  }

  function captureCurrentSnapshot(textOverride) {
    const text = typeof textOverride === 'string' ? textOverride : getEditorText();
    return makeSnapshot(text, getSelectionSnapshot());
  }

  function pushSnapshot(stack, snapshot) {
    if (!snapshot) return;
    const previous = stack[stack.length - 1];
    if (
      previous &&
      previous.text === snapshot.text &&
      previous.selectionStart === snapshot.selectionStart &&
      previous.selectionEnd === snapshot.selectionEnd
    ) {
      return;
    }
    stack.push(snapshot);
    if (stack.length > HISTORY_LIMIT) stack.shift();
  }

  function resetHistoryForText(text) {
    undoStack = [];
    redoStack = [];
    pendingBeforeInputSnapshot = null;
    lastKnownEditorText = typeof text === 'string' ? text : '';
  }

  function isSelectionInsideEditor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    return editor.contains(range.startContainer) && editor.contains(range.endContainer);
  }

  function shouldHandleEditorUndoRedo(e) {
    const target = e.target;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) &&
      !editor.contains(target) &&
      target !== editor
    ) {
      return false;
    }
    return isSelectionInsideEditor() || target === editor || editor.contains(target);
  }

  function applyHistorySnapshot(snapshot) {
    if (!snapshot) return;
    isApplyingHistory = true;
    try {
      renderEditorText(snapshot.text, { cursorOffset: snapshot.selectionEnd });
      setSelectionOffsets(snapshot.selectionStart, snapshot.selectionEnd);
      lastKnownEditorText = snapshot.text;
    } finally {
      isApplyingHistory = false;
    }
    scheduleSave();
    updateGemVisibility();
  }

  function undoEdit() {
    if (undoStack.length === 0) return;
    pushSnapshot(redoStack, captureCurrentSnapshot());
    const snapshot = undoStack.pop();
    applyHistorySnapshot(snapshot);
  }

  function redoEdit() {
    if (redoStack.length === 0) return;
    pushSnapshot(undoStack, captureCurrentSnapshot());
    const snapshot = redoStack.pop();
    applyHistorySnapshot(snapshot);
  }

  function recordBeforeProgrammaticTextChange() {
    pushSnapshot(undoStack, captureCurrentSnapshot(lastKnownEditorText));
    redoStack = [];
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function isSingleWordSelection(text) {
    const trimmed = normalizePlainText(text).trim();
    if (!trimmed || /\s/u.test(trimmed)) return false;
    return /^[\p{L}\p{N}][\p{L}\p{N}'’.-]*$/u.test(trimmed);
  }

  function getCurrentSelectionRect() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return rect;
  }

  function getRecallSelectionCandidate() {
    const offsets = getSelectionOffsets();
    if (!offsets || offsets.start === offsets.end) return null;

    const fullText = getEditorText();
    const selectedRaw = fullText.slice(offsets.start, offsets.end);
    const leadingWhitespace = (selectedRaw.match(/^\s*/) || [''])[0].length;
    const trailingWhitespace = (selectedRaw.match(/\s*$/) || [''])[0].length;
    const trimmedStart = offsets.start + leadingWhitespace;
    const trimmedEnd = offsets.end - trailingWhitespace;
    if (trimmedStart >= trimmedEnd) return null;

    const selectedText = fullText.slice(trimmedStart, trimmedEnd);
    if (selectedText.length < RECALL_SELECTION_MIN_LENGTH || !isSingleWordSelection(selectedText)) return null;

    const rect = getCurrentSelectionRect();
    if (!rect) return null;

    return {
      fullText,
      selectedText,
      start: trimmedStart,
      end: trimmedEnd,
      rect,
    };
  }

  function normalizeMetadataText(value) {
    return normalizePlainText(value).trim();
  }

  function truncateWithEllipsis(text, maxLength) {
    if (typeof text !== 'string') return '';
    const normalized = text.trim();
    if (!normalized) return '';
    if (!Number.isFinite(maxLength) || normalized.length <= maxLength) return normalized;
    const clipped = normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd();
    return `${clipped}...`;
  }

  function firstNonEmptyLine(text) {
    if (typeof text !== 'string') return '';
    const lines = text.split(/\r?\n/u);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return '';
  }

  function getStoryDisplayName(story, options = {}) {
    const title = normalizeMetadataText(story && story.title);
    if (title) return title;
    const manuscript = typeof options.manuscript === 'string'
      ? options.manuscript
      : (story && story.content_markdown) || '';
    const fallback = firstNonEmptyLine(manuscript);
    if (fallback) {
      const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 80;
      return truncateWithEllipsis(fallback, maxLength);
    }
    return options.emptyFallback || 'Story';
  }

  function getExportFileBaseName(story, manuscript) {
    const label = getStoryDisplayName(story, { manuscript, maxLength: 64, emptyFallback: 'story' });
    const sanitized = label.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim();
    return sanitized || 'story';
  }

  function setStoryPanelFields(story) {
    storyTitleInput.value = normalizeMetadataText(story && story.title);
    storyAuthorInput.value = normalizeMetadataText(story && story.author);
  }

  function refreshStoryHeaderLabel(manuscriptOverride) {
    if (!currentStory) return;
    const manuscript = typeof manuscriptOverride === 'string'
      ? manuscriptOverride
      : (currentStory.content_markdown || '');
    const displayName = getStoryDisplayName(currentStory, { manuscript, maxLength: 64, emptyFallback: 'Story' });
    titleBtn.textContent = displayName;
    document.title = `${displayName} — Signet`;
  }

  // --- Auto-save ---
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveIndicator.textContent = '';
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveContent();
    }, 1500);
  }

  async function saveContent() {
    if (!currentStory || isSaving) return;
    isSaving = true;
    saveIndicator.textContent = 'Saving…';
    const text = getEditorText();
    try {
      const result = await api(`/api/stories/${currentStory.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content_markdown: text }),
      });
      if (result) {
        currentStory = result.story;
        saveIndicator.textContent = 'Saved';
        setTimeout(() => {
          if (saveIndicator.textContent === 'Saved') saveIndicator.textContent = '';
        }, 2000);
      }
    } catch {
      saveIndicator.textContent = 'Error saving';
    }
    isSaving = false;
  }

  function scheduleIntentSave() {
    if (intentSaveTimer) clearTimeout(intentSaveTimer);
    intentSaveTimer = setTimeout(() => {
      intentSaveTimer = null;
      saveIntents();
    }, 1500);
  }

  async function saveIntents() {
    if (!currentStory) return;
    try {
      await api(`/api/stories/${currentStory.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          story_intent: storyIntentEl.value,
        }),
      });
    } catch { /* silent */ }
  }

  // --- Story metadata ---
  function scheduleMetadataSave() {
    if (metadataSaveTimer) clearTimeout(metadataSaveTimer);
    metadataSaveTimer = setTimeout(() => {
      metadataSaveTimer = null;
      saveMetadata();
    }, 900);
  }

  async function saveMetadata() {
    if (!currentStory) return;
    const title = normalizeMetadataText(storyTitleInput.value);
    const author = normalizeMetadataText(storyAuthorInput.value);
    if (title === normalizeMetadataText(currentStory.title) && author === normalizeMetadataText(currentStory.author)) {
      return;
    }
    try {
      const result = await api(`/api/stories/${currentStory.id}`, {
        method: 'PUT',
        body: JSON.stringify({ title, author }),
      });
      if (result && result.story) {
        currentStory = result.story;
        setStoryPanelFields(currentStory);
        refreshStoryHeaderLabel(currentStory.content_markdown || getEditorText());
      }
    } catch { /* silent */ }
  }

  function getChapterNavItems() {
    const text = getEditorText();
    const lines = Chapters.splitLinesWithOffsets
      ? Chapters.splitLinesWithOffsets(text)
      : [{ text, trimmed: text.trim(), startOffset: 0, endOffset: text.length }];

    return currentChapters.map((chapter, index) => {
      let label = chapter.title && chapter.title.text ? chapter.title.text.trim() : '';
      if (!label) {
        for (const line of lines) {
          if (line.startOffset < chapter.startOffset) continue;
          if (line.startOffset >= chapter.endOffset) break;
          if (line.trimmed) {
            label = line.trimmed;
            break;
          }
        }
      }
      if (!label) label = 'Chapter';

      return {
        id: chapter.id || `chapter-${index}`,
        label,
        startOffset: chapter.startOffset,
      };
    });
  }

  function getLineElementAtOffset(offset) {
    const lines = getLineElements();
    if (lines.length === 0) return null;

    const totalLength = getEditorText().length;
    let remaining = Math.max(0, Math.min(offset, totalLength));
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineLength = getLineRawText(line).length;
      if (remaining <= lineLength || i === lines.length - 1) return line;
      remaining -= lineLength;
      if (remaining > 0) remaining -= 1;
    }
    return lines[lines.length - 1];
  }

  function jumpToChapter(startOffset) {
    const line = getLineElementAtOffset(startOffset);
    if (!line) return;
    line.scrollIntoView({ behavior: 'smooth', block: 'start' });
    line.classList.add('chapter-jump-highlight');
    setTimeout(() => line.classList.remove('chapter-jump-highlight'), 550);
  }

  function positionStoryPanel() {
    const rect = titleBtn.getBoundingClientRect();
    const panelWidth = Math.min(420, window.innerWidth - 32);
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - panelWidth - 16));
    storyPanel.style.left = `${left}px`;
    storyPanel.style.top = `${rect.bottom + 10}px`;
  }

  function renderStoryPanelChapters() {
    const items = getChapterNavItems();
    if (items.length <= 2) {
      storyPanelChapters.classList.add('hidden');
      storyPanelChapters.replaceChildren();
      return;
    }

    const list = document.createElement('div');
    list.className = 'story-panel-chapter-list';

    for (const chapter of items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'story-panel-chapter-item';
      item.textContent = chapter.label;
      item.addEventListener('click', () => {
        hideStoryPanel();
        jumpToChapter(chapter.startOffset);
      });
      list.appendChild(item);
    }

    storyPanelChapters.classList.remove('hidden');
    storyPanelChapters.replaceChildren(list);
  }

  function showStoryPanel() {
    if (!storyPanel.classList.contains('hidden')) return;
    if (storyPanelHideTimer) clearTimeout(storyPanelHideTimer);
    hideStoryOverlay();
    positionStoryPanel();
    renderStoryPanelChapters();
    storyPanelBackdrop.classList.remove('hidden');
    storyPanel.classList.remove('hidden');
    requestAnimationFrame(() => {
      storyPanelBackdrop.classList.add('open');
      storyPanel.classList.add('open');
    });
  }

  function hideStoryPanel() {
    if (storyPanel.classList.contains('hidden')) return;
    storyPanel.classList.remove('open');
    storyPanelBackdrop.classList.remove('open');
    if (storyPanelHideTimer) clearTimeout(storyPanelHideTimer);
    storyPanelHideTimer = setTimeout(() => {
      storyPanel.classList.add('hidden');
      storyPanelBackdrop.classList.add('hidden');
    }, 170);
  }

  function toggleStoryPanel() {
    if (storyPanel.classList.contains('hidden')) {
      showStoryPanel();
    } else {
      hideStoryPanel();
    }
  }

  // --- Story overlay ---
  async function showStoryOverlay() {
    hideStoryPanel();
    const data = await api('/api/stories');
    if (!data) return;
    stories = data.stories;
    storyList.innerHTML = '';
    for (const s of stories) {
      const li = document.createElement('li');
      if (currentStory && s.id === currentStory.id) li.classList.add('active');
      const displayName = getStoryDisplayName(s, { maxLength: 68, emptyFallback: 'Story' });
      li.innerHTML = `
        <span class="story-name">${escapeHtml(displayName)}</span>
        <span class="story-date">${formatRelativeDate(s.last_modified)}</span>
      `;
      li.addEventListener('click', () => {
        hideStoryOverlay();
        loadStory(s.id);
      });
      storyList.appendChild(li);
    }
    storyOverlay.classList.remove('hidden');
  }

  function hideStoryOverlay() {
    storyOverlay.classList.add('hidden');
  }

  function formatRelativeDate(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    const d = new Date(timestamp);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }

  // --- Gem visibility ---
  function hideGem() {
    gem.classList.remove('visible');
    gemContainer.style.height = '0px';
  }

  function clearGemIdleTimer() {
    if (!gemIdleTimer) return;
    clearTimeout(gemIdleTimer);
    gemIdleTimer = null;
  }

  function canRenderGem() {
    if (!currentStory) return false;
    if (!editorContainer || !editor || !gemContainer || !gem) return false;
    if (!storyOverlay.classList.contains('hidden')) return false;
    if (!rewriteOverlay.classList.contains('hidden')) return false;
    return getEditorText().trim().length > 0;
  }

  function positionGemAtStoryEnd() {
    const fullText = getEditorText();
    if (!fullText.trim()) return false;

    const trimmedLength = fullText.replace(/\s+$/u, '').length;
    const endOffset = Math.max(0, trimmedLength);
    const endPosition = resolvePositionForOffset(endOffset);
    let anchorRect = null;

    if (endPosition) {
      const range = document.createRange();
      range.setStart(endPosition.container, endPosition.offset);
      range.collapse(true);
      anchorRect = range.getBoundingClientRect();
    }

    if (!anchorRect || (!anchorRect.width && !anchorRect.height)) {
      const line = getLineElementAtOffset(endOffset);
      if (line) anchorRect = line.getBoundingClientRect();
    }
    if (!anchorRect) return false;

    const containerRect = editorContainer.getBoundingClientRect();
    const gemHeight = gem.offsetHeight || 24;
    const gemWidth = gem.offsetWidth || 24;
    const anchorHeight = anchorRect.height || getEditorLineHeightPx();
    const top = (anchorRect.top - containerRect.top) + (anchorHeight / 2);
    const unclampedLeft = (anchorRect.right - containerRect.left) + GEM_END_OFFSET_PX;
    const maxLeft = Math.max(0, containerRect.width - gemWidth);
    const left = Math.max(0, Math.min(unclampedLeft, maxLeft));

    gemContainer.style.left = `${Math.round(left)}px`;
    gemContainer.style.top = `${Math.round(top)}px`;
    gemContainer.style.height = `${Math.round(gemHeight)}px`;
    return true;
  }

  function revealGemIfReady() {
    if (!canRenderGem()) {
      hideGem();
      return;
    }
    if (positionGemAtStoryEnd()) {
      gem.classList.add('visible');
      return;
    }
    hideGem();
  }

  function scheduleGemRevealAfterIdle() {
    clearGemIdleTimer();
    gemIdleTimer = setTimeout(() => {
      gemIdleTimer = null;
      revealGemIfReady();
    }, GEM_IDLE_APPEAR_DELAY_MS);
  }

  function updateGemVisibility(options = {}) {
    const typing = options.typing === true;
    if (typing) {
      gemLastTypingTimestamp = Date.now();
      hideGem();
      scheduleGemRevealAfterIdle();
      return;
    }

    if (!canRenderGem()) {
      clearGemIdleTimer();
      hideGem();
      return;
    }

    const elapsed = Date.now() - gemLastTypingTimestamp;
    if (elapsed >= GEM_IDLE_APPEAR_DELAY_MS) {
      revealGemIfReady();
      return;
    }

    hideGem();
    scheduleGemRevealAfterIdle();
  }

  function getFullEditorText() {
    return getEditorText();
  }

  function refreshChapterContextAtCursor() {
    if (!Chapters.getChapterContext) return;
    currentChapterContext = Chapters.getChapterContext(currentChapters, getCursorOffset());
  }

  // --- The Gem: continuation ---
  function detectContinuationModeAtCursor() {
    const text = getEditorText();
    const cursorOffset = getCursorOffset();
    const lineStart = text.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
    const prevLineEnd = Math.max(0, lineStart - 1);
    const prevLineStart = text.lastIndexOf('\n', Math.max(0, prevLineEnd - 1)) + 1;

    const currentLine = text.slice(lineStart, text.indexOf('\n', cursorOffset) === -1 ? text.length : text.indexOf('\n', cursorOffset));
    const previousLine = text.slice(prevLineStart, prevLineEnd);

    if (currentLine.trim() === '' && previousLine.trim() === '') {
      return 'paragraph_start';
    }

    const beforeCursor = text.slice(0, cursorOffset).trimEnd();
    if (beforeCursor && !/[.!?]["')\]]?\s*$/.test(beforeCursor)) {
      return 'mid_sentence';
    }

    return 'default';
  }

  async function triggerContinuation(options = {}) {
    if (gem.classList.contains('loading')) return;

    const source = options.source || 'gem';
    const text = getEditorText();
    const cursorOffset = getCursorOffset();
    const stableInsertOffset = source === 'shortcut'
      ? cursorOffset
      : text.replace(/\s+$/u, '').length;
    const mode = options.mode || (source === 'shortcut' ? detectContinuationModeAtCursor() : 'default');
    const beforeCursor = text.slice(0, cursorOffset);
    const afterCursor = text.slice(cursorOffset);
    const precedingText = source === 'shortcut'
      ? beforeCursor
      : getFullEditorText().replace(/\s+$/u, '');
    if (!precedingText.trim()) return;

    gem.classList.add('loading');
    gem.classList.add('active');

    if (!gemHintShown) {
      showGemHint();
      gemHintShown = true;
      localStorage.setItem('gemHintShown', '1');
    }

    try {
      const endpoint = options.premium ? '/api/continue-premium' : '/api/continue';
      const result = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          precedingText: precedingText.slice(-2000),
          followingText: afterCursor.slice(0, 400),
          mode,
          storyIntent: storyIntentEl.value || null,
        }),
      });

      if (result && result.sentence) {
        if (source === 'shortcut') {
          insertContinuationAtCursor(result.sentence, { cursorOffset: stableInsertOffset });
        } else {
          insertContinuation(result.sentence, { cursorOffset: stableInsertOffset });
        }
      }
    } catch {
      // silent fail
    }

    gem.classList.remove('loading');
    setTimeout(() => gem.classList.remove('active'), 300);
    updateGemVisibility();
  }

  function insertContinuation(sentence, options = {}) {
    recordBeforeProgrammaticTextChange();
    const text = getEditorText();
    const cursorOffset = typeof options.cursorOffset === 'number'
      ? Math.max(0, Math.min(options.cursorOffset, text.length))
      : getCursorOffset();
    const lineStart = text.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
    const lineEndRaw = text.indexOf('\n', cursorOffset);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    const lineText = text.slice(lineStart, lineEnd);
    const lineTrimmedEnd = lineText.trimEnd();
    const endsWithTerminalPunctuation = /[.!?:]["')\]]?$/u.test(lineTrimmedEnd);

    const insertPos = lineEnd;
    const prefix = endsWithTerminalPunctuation ? ' ' : '. ';
    const updatedText = text.slice(0, insertPos) + prefix + sentence + text.slice(insertPos);
    const newCursor = insertPos + prefix.length + sentence.length;

    renderEditorText(updatedText, { cursorOffset: newCursor });
    focusEditorAtOffset(newCursor);
    lastKnownEditorText = updatedText;
    scheduleSave();
  }

  function insertContinuationAtCursor(rawText, options = {}) {
    const continuation = (rawText || '').trim();
    if (!continuation) return;

    recordBeforeProgrammaticTextChange();
    const text = getEditorText();
    const cursorOffset = typeof options.cursorOffset === 'number'
      ? Math.max(0, Math.min(options.cursorOffset, text.length))
      : getCursorOffset();
    const updatedText = text.slice(0, cursorOffset) + continuation + text.slice(cursorOffset);
    const newCursor = cursorOffset + continuation.length;

    renderEditorText(updatedText, { cursorOffset: newCursor });
    focusEditorAtOffset(newCursor);
    lastKnownEditorText = updatedText;
    scheduleSave();
  }

  function showGemHint() {
    gemHint.classList.remove('hidden');
    setTimeout(() => {
      gemHint.classList.add('fading');
      setTimeout(() => {
        gemHint.classList.add('hidden');
        gemHint.classList.remove('fading');
      }, 600);
    }, 3500);
  }

  // --- Recall ---
  let recallDismissTimer = null;
  let recallLongPressTimer = null;
  let recallPendingTrigger = null;
  let recallAbortController = null;
  let recallRequestToken = 0;

  function clearRecallDismissTimer() {
    if (!recallDismissTimer) return;
    clearTimeout(recallDismissTimer);
    recallDismissTimer = null;
  }

  function clearRecallLongPressTimer() {
    if (!recallLongPressTimer) return;
    clearTimeout(recallLongPressTimer);
    recallLongPressTimer = null;
  }

  function clearRecallPendingTrigger() {
    recallPendingTrigger = null;
  }

  function hideRecallPulse() {
    recallPulse.classList.remove('visible');
    recallPulse.classList.add('hidden');
    recallPulse.style.left = '';
    recallPulse.style.top = '';
  }

  function hideRecallOverlay() {
    recallOverlay.classList.remove('visible');
    recallOverlay.classList.add('hidden');
    recallOverlay.textContent = '';
    recallOverlay.style.left = '';
    recallOverlay.style.top = '';
    recallOverlay.style.maxWidth = '';
  }

  function clearRecallDisplay() {
    clearRecallDismissTimer();
    hideRecallPulse();
    hideRecallOverlay();
  }

  function cancelRecallRequest() {
    recallRequestToken += 1;
    if (recallAbortController) {
      recallAbortController.abort();
      recallAbortController = null;
    }
  }

  function dismissRecall(options = {}) {
    clearRecallPendingTrigger();
    clearRecallLongPressTimer();
    if (options.abortRequest !== false) cancelRecallRequest();
    clearRecallDisplay();
  }

  function scheduleRecallDismiss() {
    clearRecallDismissTimer();
    recallDismissTimer = setTimeout(() => {
      recallDismissTimer = null;
      clearRecallDisplay();
    }, RECALL_DISMISS_MS);
  }

  function showRecallPulseAtRect(rect) {
    if (!rect) return;
    const containerRect = editorContainer.getBoundingClientRect();
    const centerX = (rect.left - containerRect.left) + ((rect.width || 12) / 2);
    const centerY = (rect.top - containerRect.top) + ((rect.height || getEditorLineHeightPx()) / 2);
    recallPulse.style.left = `${Math.round(centerX)}px`;
    recallPulse.style.top = `${Math.round(centerY)}px`;
    recallPulse.classList.remove('hidden');
    requestAnimationFrame(() => {
      recallPulse.classList.add('visible');
    });
  }

  function positionRecallOverlayAtRect(rect) {
    if (!rect) return;
    const containerRect = editorContainer.getBoundingClientRect();
    const availableWidth = Math.max(180, Math.min(352, containerRect.width - 24));
    recallOverlay.style.maxWidth = `${Math.round(availableWidth)}px`;
    recallOverlay.style.left = '0px';
    recallOverlay.style.top = '0px';

    const overlayWidth = recallOverlay.offsetWidth || availableWidth;
    const overlayHeight = recallOverlay.offsetHeight || 0;
    const desiredLeft = (rect.right - containerRect.left) + 12;
    const maxLeft = Math.max(0, containerRect.width - overlayWidth);
    const left = Math.max(0, Math.min(desiredLeft, maxLeft));
    const aboveTop = (rect.top - containerRect.top) - overlayHeight - 10;
    const belowTop = (rect.bottom - containerRect.top) + 10;
    const top = aboveTop >= 0 ? aboveTop : belowTop;

    recallOverlay.style.left = `${Math.round(left)}px`;
    recallOverlay.style.top = `${Math.round(Math.max(0, top))}px`;
  }

  function showRecallOverlayText(text, rect) {
    recallOverlay.textContent = text;
    recallOverlay.classList.remove('hidden');
    positionRecallOverlayAtRect(rect);
    requestAnimationFrame(() => {
      recallOverlay.classList.add('visible');
    });
    scheduleRecallDismiss();
  }

  function armRecallTrigger(source) {
    recallPendingTrigger = {
      source,
      expiresAt: Date.now() + RECALL_TRIGGER_WINDOW_MS,
    };
  }

  async function requestRecall(candidate) {
    if (!currentStory || !candidate || !candidate.selectedText) return;

    cancelRecallRequest();
    clearRecallDisplay();
    showRecallPulseAtRect(candidate.rect);

    const requestToken = recallRequestToken;
    const controller = new AbortController();
    recallAbortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);

    try {
      const result = await api('/api/recall', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          selectedText: candidate.selectedText,
          fullText: candidate.fullText,
          selectionStart: candidate.start,
          selectionEnd: candidate.end,
          storyIntent: storyIntentEl.value || null,
        }),
      });

      if (requestToken !== recallRequestToken) return;
      if (!result || !result.recall) {
        clearRecallDisplay();
        return;
      }

      showRecallOverlayText(result.recall, candidate.rect);
    } catch {
      if (requestToken !== recallRequestToken) return;
      clearRecallDisplay();
    } finally {
      clearTimeout(timeoutId);
      if (recallAbortController === controller) recallAbortController = null;
    }
  }

  function triggerPendingRecallIfAvailable() {
    if (!recallPendingTrigger) return false;
    if (recallPendingTrigger.expiresAt < Date.now()) {
      clearRecallPendingTrigger();
      return false;
    }

    const candidate = getRecallSelectionCandidate();
    if (!candidate) return false;

    hideRewriteOverlay();
    clearRecallPendingTrigger();
    requestRecall(candidate);
    return true;
  }

  // --- Keyboard shortcut ---
  function handleKeydown(e) {
    if (shouldHandleEditorUndoRedo(e)) {
      const key = (e.key || '').toLowerCase();
      const modifierPressed = isMacPlatform ? e.metaKey : e.ctrlKey;
      if (modifierPressed && !e.altKey && !e.shiftKey && key === 'z') {
        e.preventDefault();
        undoEdit();
        return;
      }
      if (modifierPressed && !e.altKey && ((e.shiftKey && key === 'z') || (!e.shiftKey && key === 'y'))) {
        e.preventDefault();
        redoEdit();
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      gem.classList.add('active');
      setTimeout(() => gem.classList.remove('active'), 300);
      triggerContinuation({ source: 'shortcut', premium: e.shiftKey });
    }
  }

  // --- Rewrite selection ---
  let selectedTextForRewrite = '';
  let selectedRangeForRewrite = null; // { start, end } offsets in UTF-16 code units

  function handleSelectionChange() {
    if (rewriteOverlay.contains(document.activeElement)) return;

    const offsets = getSelectionOffsets();
    if (!offsets || offsets.start === offsets.end) {
      dismissRecall();
      if (!rewriteOverlay.classList.contains('hidden')) return;
      updateGemVisibility();
      refreshChapterContextAtCursor();
      return;
    }

    if (triggerPendingRecallIfAvailable()) return;

    const recallCandidate = getRecallSelectionCandidate();
    if (recallCandidate) {
      hideRewriteOverlay();
      updateGemVisibility();
      return;
    }

    const fullText = getEditorText();
    const selectedRaw = fullText.slice(offsets.start, offsets.end);
    const leadingWhitespace = (selectedRaw.match(/^\s*/) || [''])[0].length;
    const trailingWhitespace = (selectedRaw.match(/\s*$/) || [''])[0].length;
    const trimmedStart = offsets.start + leadingWhitespace;
    const trimmedEnd = offsets.end - trailingWhitespace;
    const trimmedSelection = fullText.slice(trimmedStart, trimmedEnd);

    if (trimmedSelection.length < 3) {
      dismissRecall();
      hideRewriteOverlay();
      return;
    }

    dismissRecall();
    selectedTextForRewrite = trimmedSelection;
    selectedRangeForRewrite = { start: trimmedStart, end: trimmedEnd };

    showRewriteOverlay();
  }

  function showRewriteOverlay() {
    rewriteOverlay.classList.remove('hidden');
    positionRewriteOverlay();
    rewritePreview.classList.add('hidden');
    rewriteSelected.textContent = selectedTextForRewrite;
    rewriteInput.value = '';
  }

  function hideRewriteOverlay() {
    rewriteOverlay.classList.add('hidden');
    rewriteOverlay.classList.remove('mobile-positioned');
    rewriteOverlay.style.top = '';
    delete rewriteOverlay.dataset.mobilePlacement;
    rewritePreview.classList.add('hidden');
    rewriteSelected.textContent = '';
    rewriteInput.value = '';
    selectedTextForRewrite = '';
    selectedRangeForRewrite = null;
  }

  function getSelectionMidpointY() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect.top + (rect.height / 2);
  }

  function getViewportMetrics() {
    if (window.visualViewport) {
      return {
        top: window.visualViewport.offsetTop,
        height: window.visualViewport.height,
      };
    }
    return {
      top: 0,
      height: window.innerHeight,
    };
  }

  function positionRewriteOverlay() {
    if (!shouldUseMobileRewritePositioning) {
      rewriteOverlay.classList.remove('mobile-positioned');
      rewriteOverlay.style.top = '';
      delete rewriteOverlay.dataset.mobilePlacement;
      return;
    }

    const selectionMidpointY = getSelectionMidpointY();
    if (selectionMidpointY === null) return;

    const viewport = getViewportMetrics();
    const viewportMiddleY = viewport.top + (viewport.height / 2);
    const placeNearTop = selectionMidpointY > viewportMiddleY;
    const inset = Math.max(20, Math.round(viewport.height * 0.08));
    const targetTop = placeNearTop
      ? viewport.top + inset
      : viewport.top + viewport.height - inset;

    rewriteOverlay.classList.add('mobile-positioned');
    rewriteOverlay.dataset.mobilePlacement = placeNearTop ? 'top' : 'bottom';
    rewriteOverlay.style.top = `${Math.round(targetTop)}px`;
  }

  async function submitRewrite() {
    const instruction = rewriteInput.value.trim();
    if (!instruction || !selectedTextForRewrite || !selectedRangeForRewrite) return;

    rewriteInput.disabled = true;
    try {
      const result = await api('/api/rewrite', {
        method: 'POST',
        body: JSON.stringify({
          selectedText: selectedTextForRewrite,
          instruction,
          fullText: getFullEditorText(),
          selectionStart: selectedRangeForRewrite.start,
          selectionEnd: selectedRangeForRewrite.end,
          storyIntent: storyIntentEl.value || null,
        }),
      });

      if (result && result.rewritten) {
        showRewriteDiff(selectedTextForRewrite, result.rewritten);
      }
    } catch {
      // silent
    }
    rewriteInput.disabled = false;
  }

  function showRewriteDiff(original, rewritten) {
    rewriteDiff.innerHTML = `<del>${escapeHtml(original)}</del> → <ins>${escapeHtml(rewritten)}</ins>`;
    rewritePreview.classList.remove('hidden');
    rewritePreview.dataset.rewritten = rewritten;
  }

  function acceptRewrite() {
    const rewritten = rewritePreview.dataset.rewritten;
    if (!rewritten || !selectedRangeForRewrite) return;

    recordBeforeProgrammaticTextChange();
    const fullText = getEditorText();
    const { start, end } = selectedRangeForRewrite;
    const updatedText = fullText.slice(0, start) + rewritten + fullText.slice(end);
    const newCursor = start + rewritten.length;

    renderEditorText(updatedText, { cursorOffset: newCursor });
    lastKnownEditorText = updatedText;
    hideRewriteOverlay();
    scheduleSave();
  }

  function rejectRewrite() {
    hideRewriteOverlay();
  }

  // --- Export ---
  function buildMarkdownExport(story, manuscript) {
    const source = typeof manuscript === 'string' ? manuscript : '';
    if (!source) return '';
    if (!Chapters.parseChapters || !Chapters.splitLinesWithOffsets) return source;

    const title = normalizeMetadataText(story && story.title);
    const author = normalizeMetadataText(story && story.author);
    const chapterHeadingPrefix = title ? '## ' : '# ';
    const lines = Chapters.splitLinesWithOffsets(source);
    const parsedChapters = Chapters.parseChapters(source);
    const chapterHeadingStartOffsets = new Set();
    for (const chapter of parsedChapters) {
      for (const line of lines) {
        if (line.startOffset < chapter.startOffset) continue;
        if (line.startOffset >= chapter.endOffset) break;
        if (!line.trimmed || (Chapters.isDividerLine && Chapters.isDividerLine(line.text))) continue;
        chapterHeadingStartOffsets.add(line.startOffset);
        break;
      }
    }

    const processed = [];
    for (const line of lines) {
      if (Chapters.isDividerLine && Chapters.isDividerLine(line.text)) continue;
      if (chapterHeadingStartOffsets.has(line.startOffset)) {
        processed.push('');
        processed.push(line.trimmed.startsWith('#') ? line.text : `${chapterHeadingPrefix}${line.trimmed}`);
        processed.push('');
      } else {
        processed.push(line.text);
      }
    }

    const paragraphs = [];
    let current = [];
    for (const line of processed) {
      if (line.trim() === '') {
        if (current.length) {
          paragraphs.push(current);
          current = [];
        }
      } else {
        current.push(line);
      }
    }
    if (current.length) paragraphs.push(current);

    const manuscriptBody = paragraphs.map((p) => p.join('\n')).join('\n\n');
    if (!title && !author) return manuscriptBody;

    const preface = [];
    if (title) preface.push(`# ${title}`);
    if (author) preface.push(author);
    return `${preface.join('\n\n')}\n\n${manuscriptBody}`.trim();
  }

  function exportAsMarkdown() {
    if (!currentStory) return;
    const manuscript = getEditorText();
    const markdown = buildMarkdownExport(currentStory, manuscript);
    const fileBase = getExportFileBaseName(currentStory, manuscript);
    downloadFile(`${fileBase}.md`, markdown, 'text/markdown');
    hideStoryOverlay();
  }

  function exportAsPlainText() {
    if (!currentStory) return;
    const text = getFullEditorText();
    const title = normalizeMetadataText(currentStory.title);
    const author = normalizeMetadataText(currentStory.author);
    const prefixed = title || author
      ? `${[title ? title : '', author ? author : ''].filter(Boolean).join('\n\n')}\n\n${text}`
      : text;
    const fileBase = getExportFileBaseName(currentStory, text);
    downloadFile(`${fileBase}.txt`, prefixed, 'text/plain');
    hideStoryOverlay();
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- New story ---
  async function createNewStory() {
    const result = await api('/api/stories', { method: 'POST', body: JSON.stringify({}) });
    if (result) {
      hideStoryOverlay();
      await loadStory(result.story.id);
    }
  }

  // --- Event listeners ---

  editor.addEventListener('beforeinput', () => {
    if (isApplyingHistory) return;
    pendingBeforeInputSnapshot = captureCurrentSnapshot(lastKnownEditorText);
  });

  editor.addEventListener('input', () => {
    const cursorOffset = getCursorOffset();
    const text = getEditorText();
    const previousScrollY = window.scrollY;
    dismissRecall();
    if (!isApplyingHistory && pendingBeforeInputSnapshot && pendingBeforeInputSnapshot.text !== text) {
      pushSnapshot(undoStack, pendingBeforeInputSnapshot);
      redoStack = [];
    }
    renderEditorText(text, { cursorOffset });
    lastKnownEditorText = text;
    pendingBeforeInputSnapshot = null;
    refreshStoryHeaderLabel(text);
    scheduleSave();
    updateGemVisibility({ typing: true });
    ensureCursorBottomPadding();
    requestAnimationFrame(() => {
      window.scrollTo({ top: previousScrollY, left: 0, behavior: 'auto' });
    });
  });

  editor.addEventListener('keyup', () => {
    updateGemVisibility();
    refreshChapterContextAtCursor();
    ensureCursorBottomPadding();
  });
  editor.addEventListener('click', () => {
    updateGemVisibility();
    refreshChapterContextAtCursor();
    ensureCursorBottomPadding();
  });
  editor.addEventListener('dblclick', () => {
    armRecallTrigger('double_click');
    requestAnimationFrame(() => {
      triggerPendingRecallIfAvailable();
    });
  });
  editor.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    clearRecallLongPressTimer();
    recallLongPressTimer = setTimeout(() => {
      recallLongPressTimer = null;
      armRecallTrigger('long_press');
      triggerPendingRecallIfAvailable();
    }, RECALL_LONG_PRESS_DELAY_MS);
  });
  editor.addEventListener('pointerup', clearRecallLongPressTimer);
  editor.addEventListener('pointercancel', clearRecallLongPressTimer);

  editorContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (gem.contains(e.target)) return;
    requestAnimationFrame(() => {
      if (document.activeElement === editor || isSelectionInsideEditor()) return;
      focusEditorAtEnd();
    });
  });

  gem.addEventListener('click', (e) => {
    e.preventDefault();
    triggerContinuation({ source: 'gem' });
  });

  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('mousedown', () => {
    dismissRecall();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      dismissRecall();
      return;
    }
    scheduleRemoteRefresh();
  });
  window.addEventListener('focus', scheduleRemoteRefresh);
  window.addEventListener('pageshow', scheduleRemoteRefresh);

  titleBtn.addEventListener('click', toggleStoryPanel);

  storyOverlay.addEventListener('click', (e) => {
    if (e.target === storyOverlay) hideStoryOverlay();
  });

  newStoryBtn.addEventListener('click', createNewStory);
  exportMdBtn.addEventListener('click', exportAsMarkdown);
  exportTxtBtn.addEventListener('click', exportAsPlainText);
  storyTitleInput.addEventListener('input', scheduleMetadataSave);
  storyAuthorInput.addEventListener('input', scheduleMetadataSave);
  storyTitleInput.addEventListener('blur', saveMetadata);
  storyAuthorInput.addEventListener('blur', saveMetadata);
  storyIntentEl.addEventListener('input', scheduleIntentSave);
  storyIntentEl.addEventListener('blur', saveIntents);
  manageStoriesLink.addEventListener('click', () => {
    hideStoryPanel();
    showStoryOverlay();
  });
  storyPanelBackdrop.addEventListener('click', hideStoryPanel);

  window.addEventListener('resize', () => {
    dismissRecall();
    if (!storyPanel.classList.contains('hidden')) positionStoryPanel();
    if (!rewriteOverlay.classList.contains('hidden')) positionRewriteOverlay();
    updateGemVisibility();
  });
  window.addEventListener('scroll', () => {
    dismissRecall();
    if (!storyPanel.classList.contains('hidden')) hideStoryPanel();
    if (!rewriteOverlay.classList.contains('hidden')) positionRewriteOverlay();
    updateGemVisibility();
  }, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      dismissRecall();
      if (!rewriteOverlay.classList.contains('hidden')) positionRewriteOverlay();
      updateGemVisibility();
    });
    window.visualViewport.addEventListener('scroll', () => {
      dismissRecall();
      if (!rewriteOverlay.classList.contains('hidden')) positionRewriteOverlay();
      updateGemVisibility();
    });
  }

  rewriteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitRewrite();
    }
    if (e.key === 'Escape') hideRewriteOverlay();
  });

  rewriteAccept.addEventListener('click', acceptRewrite);
  rewriteReject.addEventListener('click', rejectRewrite);

  let selectionDebounce = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionDebounce);
    selectionDebounce = setTimeout(handleSelectionChange, 300);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!storyPanel.classList.contains('hidden')) hideStoryPanel();
      if (!storyOverlay.classList.contains('hidden')) hideStoryOverlay();
      if (!rewriteOverlay.classList.contains('hidden')) hideRewriteOverlay();
    }
    // Auto-dismiss transform modal when user types in document (not in modal input)
    if (!rewriteOverlay.classList.contains('hidden') && !rewriteOverlay.contains(e.target)) {
      hideRewriteOverlay();
    }
  });

  // --- Start ---
  init();
})();
