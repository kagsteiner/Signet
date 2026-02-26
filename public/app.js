(function () {
  'use strict';

  // --- State ---
  let currentStory = null;
  let stories = [];
  let saveTimer = null;
  let intentSaveTimer = null;
  let isSaving = false;
  let gemHintShown = localStorage.getItem('gemHintShown') === '1';

  // --- DOM refs ---
  const titleBtn = document.getElementById('story-title-btn');
  const saveIndicator = document.getElementById('save-indicator');
  const editor = document.getElementById('editor');
  const gemContainer = document.getElementById('gem-container');
  const gem = document.getElementById('gem');
  const intentSection = document.getElementById('intent-section');
  const intentToggle = document.getElementById('intent-toggle');
  const storyIntentEl = document.getElementById('story-intent');
  const chapterIntentEl = document.getElementById('chapter-intent');
  const storyOverlay = document.getElementById('story-overlay');
  const storyList = document.getElementById('story-list');
  const newStoryBtn = document.getElementById('new-story-btn');
  const exportMdBtn = document.getElementById('export-md-btn');
  const exportTxtBtn = document.getElementById('export-txt-btn');
  const rewriteOverlay = document.getElementById('rewrite-overlay');
  const rewriteInput = document.getElementById('rewrite-input');
  const rewritePreview = document.getElementById('rewrite-preview');
  const rewriteDiff = document.getElementById('rewrite-diff');
  const rewriteAccept = document.getElementById('rewrite-accept');
  const rewriteReject = document.getElementById('rewrite-reject');
  const gemHint = document.getElementById('gem-hint');

  // --- API helpers ---
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
    });
    if (res.status === 401) {
      window.location.href = '/';
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
      const result = await api('/api/stories', { method: 'POST', body: JSON.stringify({ title: 'Untitled' }) });
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

  function renderStory() {
    titleBtn.textContent = currentStory.title;
    document.title = `${currentStory.title} — Storytellers`;
    storyIntentEl.value = currentStory.story_intent || '';
    chapterIntentEl.value = currentStory.chapter_intent || '';
    setEditorContent(currentStory.content_markdown);
    updateGemVisibility();
  }

  // --- Markdown ↔ Editor ---
  function setEditorContent(markdown) {
    if (!markdown) {
      editor.innerHTML = '';
      return;
    }
    const html = markdownToHtml(markdown);
    editor.innerHTML = html;
  }

  function getEditorMarkdown() {
    const nodes = editor.childNodes;
    const lines = [];
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text.trim()) lines.push(text);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'h2') {
          lines.push(`## ${node.textContent}`);
        } else if (tag === 'br') {
          lines.push('');
        } else {
          lines.push(node.textContent);
        }
      }
    }
    return lines.join('\n');
  }

  function markdownToHtml(md) {
    const lines = md.split('\n');
    let html = '';
    for (const line of lines) {
      if (line.startsWith('## ')) {
        html += `<h2>${escapeHtml(line.slice(3))}</h2>`;
      } else if (line.trim() === '') {
        html += '<p><br></p>';
      } else {
        html += `<p>${escapeHtml(line)}</p>`;
      }
    }
    return html;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Auto-save ---
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveIndicator.textContent = '';
    saveTimer = setTimeout(() => saveContent(), 1500);
  }

  async function saveContent() {
    if (!currentStory || isSaving) return;
    isSaving = true;
    saveIndicator.textContent = 'Saving…';
    const markdown = getEditorMarkdown();
    try {
      const result = await api(`/api/stories/${currentStory.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content_markdown: markdown }),
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
    intentSaveTimer = setTimeout(() => saveIntents(), 1500);
  }

  async function saveIntents() {
    if (!currentStory) return;
    try {
      await api(`/api/stories/${currentStory.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          story_intent: storyIntentEl.value,
          chapter_intent: chapterIntentEl.value,
        }),
      });
    } catch { /* silent */ }
  }

  // --- Title editing ---
  function promptRenameStory() {
    const newTitle = prompt('Story title:', currentStory.title);
    if (newTitle && newTitle.trim() && newTitle.trim() !== currentStory.title) {
      api(`/api/stories/${currentStory.id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: newTitle.trim() }),
      }).then(result => {
        if (result) {
          currentStory = result.story;
          titleBtn.textContent = currentStory.title;
          document.title = `${currentStory.title} — Storytellers`;
        }
      });
    }
  }

  // --- Story overlay ---
  async function showStoryOverlay() {
    const data = await api('/api/stories');
    if (!data) return;
    stories = data.stories;
    storyList.innerHTML = '';
    for (const s of stories) {
      const li = document.createElement('li');
      if (currentStory && s.id === currentStory.id) li.classList.add('active');
      li.innerHTML = `
        <span class="story-name">${escapeHtml(s.title)}</span>
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
  function updateGemVisibility() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.anchorNode === null) {
        gem.classList.remove('visible');
        return;
      }

      if (!editor.contains(sel.anchorNode) && sel.anchorNode !== editor) {
        gem.classList.remove('visible');
        return;
      }

      const text = getTextUpToCursor();
      const trimmed = text.trimEnd();
      if (trimmed.endsWith('.')) {
        gem.classList.add('visible');
      } else {
        gem.classList.remove('visible');
      }
    } catch {
      gem.classList.remove('visible');
    }
  }

  function getTextUpToCursor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    try {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.setStart(editor, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      return preRange.toString();
    } catch {
      return editor.textContent || '';
    }
  }

  function getFullEditorText() {
    return editor.textContent || '';
  }

  // --- The Gem: continuation ---
  async function triggerContinuation() {
    if (gem.classList.contains('loading')) return;

    const precedingText = getFullEditorText().trim();
    if (!precedingText) return;

    gem.classList.add('loading');
    gem.classList.add('active');

    if (!gemHintShown) {
      showGemHint();
      gemHintShown = true;
      localStorage.setItem('gemHintShown', '1');
    }

    try {
      const result = await api('/api/continue', {
        method: 'POST',
        body: JSON.stringify({
          precedingText: precedingText.slice(-2000),
          storyIntent: storyIntentEl.value || null,
          chapterIntent: chapterIntentEl.value || null,
        }),
      });

      if (result && result.sentence) {
        insertContinuation(result.sentence);
      }
    } catch {
      // silent fail
    }

    gem.classList.remove('loading');
    setTimeout(() => gem.classList.remove('active'), 300);
    updateGemVisibility();
  }

  function insertContinuation(sentence) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    // Find the block element (p or h2) containing the cursor
    let node = sel.anchorNode;
    let block = null;
    while (node && node !== editor) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'p' || tag === 'h2') {
          block = node;
          break;
        }
      }
      node = node.parentNode;
    }

    if (!block) {
      // Fallback: append new paragraph (e.g. empty editor)
      const p = document.createElement('p');
      p.textContent = sentence;
      editor.appendChild(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      editor.scrollTop = editor.scrollHeight;
      scheduleSave();
      return;
    }

    const fullText = block.textContent || '';
    const lastPeriod = fullText.lastIndexOf('.');

    // Insert ". " + sentence after last period, or ". " + sentence at end if none
    const insertPos = lastPeriod >= 0 ? lastPeriod + 1 : fullText.length;
    const prefix = lastPeriod >= 0 ? ' ' : '. ';
    const newText = fullText.slice(0, insertPos) + prefix + sentence + fullText.slice(insertPos);

    block.textContent = newText;

    const endOfInsert = insertPos + prefix.length + sentence.length;
    const textNode = block.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.setStart(textNode, Math.min(endOfInsert, textNode.length));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

  // --- Keyboard shortcut ---
  function handleKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      gem.classList.add('active');
      setTimeout(() => gem.classList.remove('active'), 300);
      triggerContinuation();
    }
  }

  // --- Rewrite selection ---
  let selectedTextForRewrite = '';
  let selectedRangeForRewrite = null;

  function handleSelectionChange() {
    if (rewriteOverlay.contains(document.activeElement)) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !editor.contains(sel.anchorNode)) {
      if (!rewriteOverlay.classList.contains('hidden')) return;
      updateGemVisibility();
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 3) {
      hideRewriteOverlay();
      return;
    }

    selectedTextForRewrite = text;
    selectedRangeForRewrite = sel.getRangeAt(0).cloneRange();

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    showRewriteOverlay(rect);
  }

  function showRewriteOverlay(rect) {
    rewriteOverlay.classList.remove('hidden');
    rewriteOverlay.style.left = `${rect.left}px`;
    rewriteOverlay.style.top = `${rect.bottom + 8}px`;
    rewritePreview.classList.add('hidden');
    rewriteInput.value = '';
  }

  function hideRewriteOverlay() {
    rewriteOverlay.classList.add('hidden');
    rewritePreview.classList.add('hidden');
    rewriteInput.value = '';
    selectedTextForRewrite = '';
    selectedRangeForRewrite = null;
  }

  async function submitRewrite() {
    const instruction = rewriteInput.value.trim();
    if (!instruction || !selectedTextForRewrite) return;

    rewriteInput.disabled = true;
    try {
      const result = await api('/api/rewrite', {
        method: 'POST',
        body: JSON.stringify({
          selectedText: selectedTextForRewrite,
          instruction,
          surroundingContext: getFullEditorText().slice(0, 1000),
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

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(selectedRangeForRewrite);
    document.execCommand('insertText', false, rewritten);

    hideRewriteOverlay();
    scheduleSave();
  }

  function rejectRewrite() {
    hideRewriteOverlay();
  }

  // --- Export ---
  function exportAsMarkdown() {
    if (!currentStory) return;
    const markdown = getEditorMarkdown();
    downloadFile(`${currentStory.title}.md`, markdown, 'text/markdown');
    hideStoryOverlay();
  }

  function exportAsPlainText() {
    if (!currentStory) return;
    const text = getFullEditorText();
    downloadFile(`${currentStory.title}.txt`, text, 'text/plain');
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
    const title = prompt('Story title:', 'Untitled');
    if (!title) return;
    const result = await api('/api/stories', { method: 'POST', body: JSON.stringify({ title: title.trim() || 'Untitled' }) });
    if (result) {
      hideStoryOverlay();
      await loadStory(result.story.id);
    }
  }

  // --- Intent toggle ---
  function toggleIntent() {
    intentSection.classList.toggle('collapsed');
  }

  // --- Event listeners ---

  editor.addEventListener('input', () => {
    scheduleSave();
    updateGemVisibility();
  });

  editor.addEventListener('keyup', () => updateGemVisibility());
  editor.addEventListener('click', () => updateGemVisibility());

  gem.addEventListener('click', (e) => {
    e.preventDefault();
    triggerContinuation();
  });

  document.addEventListener('keydown', handleKeydown);

  titleBtn.addEventListener('click', showStoryOverlay);
  titleBtn.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    hideStoryOverlay();
    promptRenameStory();
  });

  storyOverlay.addEventListener('click', (e) => {
    if (e.target === storyOverlay) hideStoryOverlay();
  });

  newStoryBtn.addEventListener('click', createNewStory);
  exportMdBtn.addEventListener('click', exportAsMarkdown);
  exportTxtBtn.addEventListener('click', exportAsPlainText);

  intentToggle.addEventListener('click', toggleIntent);
  storyIntentEl.addEventListener('input', scheduleIntentSave);
  chapterIntentEl.addEventListener('input', scheduleIntentSave);

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
      if (!storyOverlay.classList.contains('hidden')) hideStoryOverlay();
      if (!rewriteOverlay.classList.contains('hidden')) hideRewriteOverlay();
    }
  });

  // --- Start ---
  init();
})();
