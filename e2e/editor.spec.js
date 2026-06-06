const { test, expect } = require('@playwright/test');

const { createTempDb } = require('../test-support/temp-db');
const { startTestServer } = require('../test-support/server');

const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';

async function launchStory(page, options = {}) {
  const fixture = createTempDb();
  const user = fixture.db.createUser('Playwright User');
  const session = fixture.db.createSession(user.id);
  fixture.db.createStory(user.id, {
    title: options.title || 'Playwright Story',
    initialContent: options.initialContent || '',
  });

  const server = await startTestServer({ db: fixture.db, ai: options.ai });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
  await page.context().addCookies([{
    name: 'session',
    value: session.id,
    url: server.origin,
  }]);
  await page.goto(`${server.origin}/app`);
  await expect(page.locator('#editor .editor-line').first()).toBeVisible();

  return {
    fixture,
    server,
    async close() {
      await server.close();
      fixture.cleanup();
    },
  };
}

async function doubleClickWord(page, word) {
  const point = await page.evaluate((word) => {
    const lines = Array.from(document.querySelectorAll('#editor .editor-line'));
    for (const line of lines) {
      const text = (line.textContent || '').replace(/\u00A0/g, ' ');
      const index = text.indexOf(word);
      if (index === -1 || !line.firstChild || line.firstChild.nodeType !== Node.TEXT_NODE) continue;

      const range = document.createRange();
      range.setStart(line.firstChild, index);
      range.setEnd(line.firstChild, index + word.length);
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) continue;
      return {
        x: rect.left + Math.max(2, rect.width / 2),
        y: rect.top + Math.max(2, rect.height / 2),
      };
    }
    return null;
  }, word);

  if (!point) throw new Error(`Could not find word: ${word}`);
  await page.mouse.dblclick(point.x, point.y);
}

async function simulateTouchLongPressOnWord(page, word) {
  await page.evaluate((word) => {
    const editor = document.getElementById('editor');
    const lines = Array.from(editor.querySelectorAll('.editor-line'));
    for (const line of lines) {
      const text = (line.textContent || '').replace(/\u00A0/g, ' ');
      const index = text.indexOf(word);
      if (index === -1 || !line.firstChild || line.firstChild.nodeType !== Node.TEXT_NODE) continue;

      const range = document.createRange();
      range.setStart(line.firstChild, index);
      range.setEnd(line.firstChild, index + word.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      const rect = range.getBoundingClientRect();
      editor.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        clientX: rect.left + 2,
        clientY: rect.top + 2,
      }));
      window.setTimeout(() => {
        editor.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          pointerType: 'touch',
          pointerId: 1,
          isPrimary: true,
          clientX: rect.left + 2,
          clientY: rect.top + 2,
        }));
      }, 650);
      return;
    }
    throw new Error(`Could not find word: ${word}`);
  }, word);
}

async function recallAppearsWithin(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => !document.getElementById('recall-overlay').classList.contains('hidden'),
      null,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

async function getEditorText(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#editor .editor-line'))
    .map((line) => (line.textContent || '').replace(/\u00A0/g, ' '))
    .join('\n'));
}

async function setSelectionOffsets(page, start, end) {
  await page.evaluate(({ start, end }) => {
    const editor = document.getElementById('editor');
    const lines = Array.from(editor.querySelectorAll('.editor-line'));
    const totalLength = lines
      .map((line) => (line.textContent || '').replace(/\u00A0/g, ' '))
      .join('\n')
      .length;

    function getLineRawText(line) {
      return (line.textContent || '').replace(/\u00A0/g, ' ');
    }

    function resolvePositionForOffset(offset) {
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

    const startPos = resolvePositionForOffset(start);
    const endPos = resolvePositionForOffset(end);
    if (!startPos || !endPos) return;

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(startPos.container, startPos.offset);
    range.setEnd(endPos.container, endPos.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }, { start, end });
}

async function getSelectionState(page) {
  return page.evaluate(() => {
    const editor = document.getElementById('editor');
    const lines = Array.from(editor.querySelectorAll('.editor-line'));

    function getLineRawText(line) {
      return (line.textContent || '').replace(/\u00A0/g, ' ');
    }

    function getEditorText() {
      return lines.map((line) => getLineRawText(line)).join('\n');
    }

    function computeOffsetFromPosition(container, containerOffset) {
      if (lines.length === 0) return 0;
      const line = container.nodeType === Node.ELEMENT_NODE && container.classList && container.classList.contains('editor-line')
        ? container
        : container.parentElement ? container.parentElement.closest('.editor-line') : null;
      if (!line || !editor.contains(line)) return getEditorText().length;

      const lineIndex = lines.indexOf(line);
      let offset = 0;
      for (let i = 0; i < lineIndex; i += 1) {
        offset += getLineRawText(lines[i]).length + 1;
      }

      const intraRange = document.createRange();
      intraRange.selectNodeContents(line);
      intraRange.setEnd(container, containerOffset);
      const intraOffset = intraRange.toString().length;
      offset += Math.min(intraOffset, getLineRawText(line).length);
      return Math.max(0, Math.min(offset, getEditorText().length));
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: true, start: 0, end: 0, text: '' };
    }
    const range = selection.getRangeAt(0);
    const start = computeOffsetFromPosition(range.startContainer, range.startOffset);
    const end = computeOffsetFromPosition(range.endContainer, range.endOffset);
    const fullText = getEditorText();
    const normalizedStart = Math.min(start, end);
    const normalizedEnd = Math.max(start, end);
    return {
      collapsed: range.collapsed,
      start: normalizedStart,
      end: normalizedEnd,
      text: fullText.slice(normalizedStart, normalizedEnd),
    };
  });
}

async function clickCaretAtOffset(page, offset) {
  const point = await page.evaluate((offset) => {
    const editor = document.getElementById('editor');
    const lines = Array.from(editor.querySelectorAll('.editor-line'));

    function getLineRawText(line) {
      return (line.textContent || '').replace(/\u00A0/g, ' ');
    }

    function resolvePositionForOffset(targetOffset) {
      const totalLength = lines.map((line) => getLineRawText(line)).join('\n').length;
      let remaining = Math.max(0, Math.min(targetOffset, totalLength));
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineText = getLineRawText(line);
        if (remaining <= lineText.length || i === lines.length - 1) {
          if (line.firstChild && line.firstChild.nodeType === Node.TEXT_NODE) {
            return { line, container: line.firstChild, offset: Math.min(remaining, lineText.length) };
          }
          return { line, container: line, offset: line.childNodes.length };
        }
        remaining -= lineText.length;
        if (remaining > 0) remaining -= 1;
      }
      return { line: lines[lines.length - 1], container: lines[lines.length - 1], offset: 0 };
    }

    const position = resolvePositionForOffset(offset);
    const range = document.createRange();
    range.setStart(position.container, position.offset);
    range.collapse(true);

    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    const lineRect = position.line.getBoundingClientRect();
    return {
      x: (rect && Number.isFinite(rect.left) ? rect.left : lineRect.left) + 2,
      y: (rect && Number.isFinite(rect.top) ? rect.top + (rect.height || lineRect.height) / 2 : lineRect.top + lineRect.height / 2),
    };
  }, offset);

  await page.mouse.click(point.x, point.y);
}

test('clicking inside text moves the caret to the clicked position', async ({ page }) => {
  const harness = await launchStory(page, { initialContent: 'abcdef' });
  try {
    await clickCaretAtOffset(page, 3);
    const selection = await getSelectionState(page);
    expect(selection.collapsed).toBe(true);
    expect(selection.start).toBe(3);
  } finally {
    await harness.close();
  }
});

test('typing inserts letters, spaces, and newlines at the current caret position', async ({ page }) => {
  const harness = await launchStory(page, { initialContent: 'abcdef' });
  try {
    await clickCaretAtOffset(page, 3);
    await page.keyboard.type(' X');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Y');

    await expect.poll(() => getEditorText(page)).toBe('abc X\nYdef');
  } finally {
    await harness.close();
  }
});

test('typing divider then newline renders a chapter separator', async ({ page }) => {
  const harness = await launchStory(page);
  try {
    await page.locator('#editor').click();
    await page.keyboard.type('---');
    await page.keyboard.press('Enter');

    await expect(page.locator('#editor .chapter-divider').first()).toHaveAttribute('data-divider-style', '---');
    await expect.poll(() => getEditorText(page)).toBe('---\n');
  } finally {
    await harness.close();
  }
});

test('typing divider, title, and newline formats the title line as a chapter title', async ({ page }) => {
  const harness = await launchStory(page);
  try {
    await page.locator('#editor').click();
    await page.keyboard.type('---');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Chapter One');
    await page.keyboard.press('Enter');

    await expect(page.locator('#editor .chapter-title')).toContainText('Chapter One');
  } finally {
    await harness.close();
  }
});

test('undo leaves the first n-k letters after typing n letters', async ({ page }) => {
  const harness = await launchStory(page);
  try {
    await page.locator('#editor').click();
    await page.keyboard.type('abcdef');
    await page.keyboard.press(`${modifierKey}+Z`);
    await page.keyboard.press(`${modifierKey}+Z`);

    await expect.poll(() => getEditorText(page)).toBe('abcd');
  } finally {
    await harness.close();
  }
});

test('redo restores text after undo', async ({ page }) => {
  const harness = await launchStory(page);
  try {
    await page.locator('#editor').click();
    await page.keyboard.type('a');
    await page.keyboard.press(`${modifierKey}+Z`);
    await page.keyboard.press(`${modifierKey}+Y`);

    await expect.poll(() => getEditorText(page)).toBe('a');
  } finally {
    await harness.close();
  }
});

test('selecting text creates a visible selection and clicking later collapses it', async ({ page }) => {
  const harness = await launchStory(page, { initialContent: 'Alpha beta gamma' });
  try {
    await setSelectionOffsets(page, 6, 16);
    await expect(page.locator('#rewrite-overlay')).not.toHaveClass(/hidden/);

    const selected = await getSelectionState(page);
    expect(selected.collapsed).toBe(false);
    expect(selected.text).toBe('beta gamma');

    await clickCaretAtOffset(page, 16);
    await expect.poll(() => getSelectionState(page)).toMatchObject({
      collapsed: true,
      start: 16,
      end: 16,
    });
  } finally {
    await harness.close();
  }
});

test('double-clicking a single word shows recall without opening rewrite and typing dismisses it', async ({ page }) => {
  const harness = await launchStory(page, {
    initialContent: 'Alpha beta gamma',
    ai: {
      configured: true,
      async chatWithProvider() {
        return 'beta, the word set apart in the line.';
      },
    },
  });
  try {
    await doubleClickWord(page, 'beta');

    await expect(page.locator('#recall-overlay')).toContainText('beta, the word set apart in the line.');
    await expect(page.locator('#rewrite-overlay')).toHaveClass(/hidden/);

    await page.keyboard.type('x');
    await expect(page.locator('#recall-overlay')).toHaveClass(/hidden/);
  } finally {
    await harness.close();
  }
});

test('touch long-press on a single word can trigger recall', async ({ page }) => {
  const harness = await launchStory(page, {
    initialContent: 'Alpha beta gamma',
    ai: {
      configured: true,
      async chatWithProvider() {
        return 'beta, the word singled out and briefly remembered.';
      },
    },
  });
  try {
    await simulateTouchLongPressOnWord(page, 'beta');

    await expect(page.locator('#recall-overlay')).toContainText('beta, the word singled out and briefly remembered.');
    await expect(page.locator('#rewrite-overlay')).toHaveClass(/hidden/);
  } finally {
    await harness.close();
  }
});

test('slow recall results never appear after the timeout window', async ({ page }) => {
  const harness = await launchStory(page, {
    initialContent: 'Alpha beta gamma',
    ai: {
      configured: true,
      async chatWithProvider() {
        await new Promise((resolve) => setTimeout(resolve, 2300));
        return 'This should never appear.';
      },
    },
  });
  try {
    await doubleClickWord(page, 'beta');

    expect(await recallAppearsWithin(page, 2200)).toBe(false);
    expect(await recallAppearsWithin(page, 1200)).toBe(false);
    await expect(page.locator('#recall-overlay')).toHaveClass(/hidden/);
  } finally {
    await harness.close();
  }
});

test('cut removes selected text', async ({ page }) => {
  const harness = await launchStory(page, { initialContent: 'Alpha beta gamma' });
  try {
    await setSelectionOffsets(page, 6, 10);
    await page.locator('#editor').focus();
    await page.keyboard.press(`${modifierKey}+X`);

    await expect.poll(() => getEditorText(page)).toBe('Alpha  gamma');
  } finally {
    await harness.close();
  }
});

test('copy and paste inserts copied text at a new caret position', async ({ page }) => {
  const harness = await launchStory(page, { initialContent: 'Alpha beta gamma' });
  try {
    await setSelectionOffsets(page, 6, 10);
    await page.locator('#editor').focus();
    await page.keyboard.press(`${modifierKey}+C`);
    await clickCaretAtOffset(page, 16);
    await page.keyboard.press(`${modifierKey}+V`);

    await expect.poll(() => getEditorText(page)).toBe('Alpha beta gammabeta');
  } finally {
    await harness.close();
  }
});

test('story panel hides chapter overview for a single divider in empty text', async ({ page }) => {
  const harness = await launchStory(page);
  try {
    await page.locator('#editor').click();
    await page.keyboard.type('---');
    await page.keyboard.press('Enter');
    await page.locator('#story-title-btn').click();

    await expect(page.locator('#story-panel')).not.toHaveClass(/hidden/);
    await expect(page.locator('#story-panel-chapters')).toHaveClass(/hidden/);
  } finally {
    await harness.close();
  }
});

test('story panel shows chapter overview after adding four chapters', async ({ page }) => {
  const harness = await launchStory(page);
  try {
    await page.locator('#editor').click();
    await page.keyboard.insertText('Alpha\n\n---\nBeta\n\n---\nGamma\n\n---\nDelta');
    await page.locator('#story-title-btn').click();

    await expect(page.locator('#story-panel-chapters')).not.toHaveClass(/hidden/);
    await expect(page.locator('.story-panel-chapter-item')).toHaveCount(4);
    await expect(page.locator('.story-panel-chapter-item').nth(0)).toContainText('Alpha');
    await expect(page.locator('.story-panel-chapter-item').nth(3)).toContainText('Delta');
  } finally {
    await harness.close();
  }
});

test('clicking a chapter overview item jumps to that chapter', async ({ page }) => {
  const longBody = Array.from({ length: 120 }, (_, index) => `Line ${index + 1} of body text.`).join('\n');
  const harness = await launchStory(page, {
    initialContent: `Alpha\n${longBody}\n\n---\nBeta\n${longBody}\n\n---\nGamma\nBody\n\n---\nDelta\nBody`,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator('#story-title-btn').click();
    const gammaItem = page.locator('.story-panel-chapter-item', { hasText: 'Gamma' });
    await expect(gammaItem).toBeVisible();
    await gammaItem.click({ force: true });

    await expect.poll(() => page.evaluate(() => window.scrollY > 0)).toBe(true);
  } finally {
    await harness.close();
  }
});
