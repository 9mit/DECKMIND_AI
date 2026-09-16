/**
 * DeckMind AI — Content Script & Interactive Floating Draggable HUD Injector
 * 
 * Lightweight, safe DOM scraper and draggable HUD injector for AI chat interfaces.
 * Allows users to drag and reposition the HUD anywhere across the screen with persistent
 * coordinates, debounced observers, zero host page interference, tactile audio feedback,
 * and an instant in-page slide deck preview modal.
 */

'use strict';

(function () {
  // Prevent duplicate execution
  if (window.__DECKMIND_CONTENT_INJECTED__) return;
  window.__DECKMIND_CONTENT_INJECTED__ = true;

  // Domain guard: on x.com or twitter.com, only inject if on Grok AI chat (/i/grok)
  const currentHost = (window.location.hostname || '').toLowerCase();
  const currentPath = (window.location.pathname || '').toLowerCase();
  if ((currentHost.includes('x.com') || currentHost.includes('twitter.com')) && !currentPath.startsWith('/i/grok')) {
    return;
  }

  let hudContainer = null;
  let toastEl = null;
  let previewOverlayEl = null;
  let lastTurnCount = 0;
  let scanDebounceTimer = null;
  let isScanning = false;
  let audioCtx = null;

  // In-Page Preview State
  let previewSlides = [];
  let previewActiveIdx = 0;

  // Drag state
  let isDragging = false;
  let hasMoved = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  /**
   * Synthesize Subtle Tactile Audio via HTML5 Web Audio API (100% Offline, Zero Assets)
   */
  function playTactileSound(type = 'pop') {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      const now = audioCtx.currentTime;
      if (type === 'pop') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(840, now + 0.04);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.04);
      } else if (type === 'chime') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(783.99, now + 0.06); // G5
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (e) {
      // Audio autoplay policy fallback
    }
  }

  /**
   * Apply coordinates to HUD and toast with viewport clamping
   */
  function applyHUDPosition(x, y, save = false) {
    if (!hudContainer) return;

    const pad = 12;
    const hudW = hudContainer.offsetWidth || 340;
    const hudH = hudContainer.offsetHeight || 44;
    const maxLeft = Math.max(pad, window.innerWidth - hudW - pad);
    const maxTop = Math.max(pad, window.innerHeight - hudH - pad);

    const clampedX = Math.max(pad, Math.min(maxLeft, Math.round(x)));
    const clampedY = Math.max(pad, Math.min(maxTop, Math.round(y)));

    hudContainer.style.bottom = 'auto';
    hudContainer.style.right = 'auto';
    hudContainer.style.left = `${clampedX}px`;
    hudContainer.style.top = `${clampedY}px`;

    // Position toast relative to the HUD
    if (toastEl) {
      toastEl.style.bottom = 'auto';
      toastEl.style.right = 'auto';
      toastEl.style.left = `${clampedX}px`;
      const toastY = clampedY > 70 ? clampedY - 52 : clampedY + hudH + 12;
      toastEl.style.top = `${toastY}px`;
    }

    if (save && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ deckmind_hud_pos: { x: clampedX, y: clampedY } });
    }
  }

  /**
   * Attach Draggable Listeners to HUD
   */
  function initDraggable(pillEl) {
    function onPointerDown(e) {
      if (e.target.tagName === 'BUTTON' || (e.target.closest && e.target.closest('button'))) return;

      isDragging = false;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const rect = hudContainer.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      if (!hasMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        hasMoved = true;
        isDragging = true;
        hudContainer.classList.add('deckmind-hud-dragging');
        if (pillEl.setPointerCapture && e.pointerId) {
          try {
            pillEl.setPointerCapture(e.pointerId);
          } catch (err) {}
        }
      }

      if (isDragging) {
        e.preventDefault();
        applyHUDPosition(initialLeft + dx, initialTop + dy, false);
      }
    }

    function onPointerUp(e) {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (isDragging) {
        hudContainer.classList.remove('deckmind-hud-dragging');
        const rect = hudContainer.getBoundingClientRect();
        applyHUDPosition(rect.left, rect.top, true);
      }

      setTimeout(() => {
        isDragging = false;
        hasMoved = false;
      }, 50);
    }

    pillEl.addEventListener('pointerdown', onPointerDown);
  }

  /**
   * Check if current page is in Dark Mode
   */
  function checkAndApplyDarkMode() {
    if (!hudContainer) return;
    try {
      const isDark = (
        document.documentElement.classList.contains('dark') ||
        document.body.classList.contains('dark') ||
        document.documentElement.getAttribute('data-theme') === 'dark' ||
        document.body.getAttribute('data-theme') === 'dark' ||
        document.documentElement.getAttribute('data-color-mode') === 'dark' ||
        window.matchMedia('(prefers-color-scheme: dark)').matches
      );
      hudContainer.classList.toggle('deckmind-dark-mode', isDark);
    } catch (e) {}
  }

  /**
   * Initialize In-Page Action Pill
   */
  function initHUD() {
    try {
      if (document.getElementById('deckmind-hud-container')) return;

      const platformKey = (window.DeckMindParsers && window.DeckMindParsers.detectPlatform) 
        ? window.DeckMindParsers.detectPlatform(document) 
        : 'ai';
      const platformDisplay = platformKey.toUpperCase();

      hudContainer = document.createElement('div');
      hudContainer.id = 'deckmind-hud-container';
      hudContainer.innerHTML = `
        <div class="deckmind-hud-pill" id="deckmind-pill-trigger" title="Click DM to minimize • Drag to move">
          <div class="deckmind-drag-grip" title="Drag to move across screen">
            <div class="deckmind-drag-dots"><div class="deckmind-drag-dot"></div><div class="deckmind-drag-dot"></div></div>
            <div class="deckmind-drag-dots"><div class="deckmind-drag-dot"></div><div class="deckmind-drag-dot"></div></div>
          </div>
          <div class="deckmind-hud-icon-wrap" id="deckmind-icon-toggle" title="Toggle Compact Mode">
            <div class="deckmind-hud-icon">DM</div>
            <div class="deckmind-pulse-indicator" title="Connected & Ingesting"></div>
          </div>
          <div class="deckmind-hud-label" id="deckmind-label-click">
            <div class="deckmind-hud-title-row">
              <span class="deckmind-hud-title">DeckMind</span>
              <span class="deckmind-hud-platform-tag" id="deckmind-platform-tag">${platformDisplay}</span>
            </div>
            <span class="deckmind-hud-counter" id="deckmind-turn-count">Chat Ready</span>
          </div>
          <div class="deckmind-hud-actions">
            <button class="deckmind-hud-btn gold" id="deckmind-quick-preview" title="Instant In-Page Slide Deck Preview">✨ Preview</button>
            <button class="deckmind-hud-btn" id="deckmind-quick-pptx" title="Instant 1-Click PPTX Presentation">.PPTX</button>
            <button class="deckmind-hud-btn" id="deckmind-quick-docx" title="Instant Word Essay (.docx)">DOCX</button>
            <button class="deckmind-hud-btn primary" id="deckmind-open-studio" title="Open Presentation Studio">Studio</button>
            <button class="deckmind-hud-collapse-btn" id="deckmind-btn-minimize" title="Minimize to discreet dot">−</button>
          </div>
        </div>
      `;

      toastEl = document.createElement('div');
      toastEl.className = 'deckmind-toast';
      toastEl.id = 'deckmind-toast';
      toastEl.innerHTML = '<span id="deckmind-toast-text">Generating Presentation...</span>';

      // Build In-Page Preview Modal Overlay
      previewOverlayEl = document.createElement('div');
      previewOverlayEl.className = 'deckmind-preview-overlay';
      previewOverlayEl.id = 'deckmind-preview-overlay';
      previewOverlayEl.innerHTML = `
        <div class="deckmind-preview-modal">
          <div class="deckmind-preview-header">
            <div class="deckmind-preview-brand">
              <div class="deckmind-preview-logo">DM</div>
              <span class="deckmind-preview-title" id="deckmind-preview-deck-title">Presentation Preview</span>
            </div>
            <div class="deckmind-preview-controls">
              <button class="deckmind-preview-btn primary" id="deckmind-preview-download-pptx">Download .PPTX</button>
              <button class="deckmind-preview-btn" id="deckmind-preview-open-studio">Open Full Studio ↗</button>
              <button class="deckmind-preview-close" id="deckmind-preview-close" title="Close [Esc]">✕</button>
            </div>
          </div>
          <div class="deckmind-preview-body">
            <div class="deckmind-preview-canvas" id="deckmind-preview-canvas">
              <!-- Rendered slide preview -->
            </div>
          </div>
          <div class="deckmind-preview-footer">
            <div class="deckmind-preview-nav">
              <button class="deckmind-preview-btn" id="deckmind-preview-prev">◀ Previous</button>
              <span class="deckmind-preview-indicator" id="deckmind-preview-indicator">Slide 1 of 6</span>
              <button class="deckmind-preview-btn" id="deckmind-preview-next">Next ▶</button>
            </div>
            <span style="font-size: 11px; opacity: 0.7; font-family: monospace;">DeckMind AI • Verbatim Grounded</span>
          </div>
        </div>
      `;

      const target = document.body || document.documentElement;
      if (target) {
        target.appendChild(hudContainer);
        target.appendChild(toastEl);
        target.appendChild(previewOverlayEl);
      }

      checkAndApplyDarkMode();

      // Restore saved position and collapsed state if available
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['deckmind_hud_pos', 'deckmind_hud_collapsed'], (res) => {
          if (res && res.deckmind_hud_pos && typeof res.deckmind_hud_pos.x === 'number') {
            applyHUDPosition(res.deckmind_hud_pos.x, res.deckmind_hud_pos.y, false);
          }
          if (res && res.deckmind_hud_collapsed) {
            hudContainer.classList.add('deckmind-collapsed');
          }
        });
      }

      const pillTrigger = document.getElementById('deckmind-pill-trigger');
      if (pillTrigger) {
        initDraggable(pillTrigger);
      }

      // Toggle compact orb mode on DM icon click
      const iconToggle = document.getElementById('deckmind-icon-toggle');
      if (iconToggle) {
        iconToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          if (hasMoved || isDragging) return;
          playTactileSound('pop');
          const isCollapsed = hudContainer.classList.toggle('deckmind-collapsed');
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ deckmind_hud_collapsed: isCollapsed });
          }
        });
      }

      // Minimize button click
      const btnMinimize = document.getElementById('deckmind-btn-minimize');
      if (btnMinimize) {
        btnMinimize.addEventListener('click', (e) => {
          e.stopPropagation();
          playTactileSound('pop');
          hudContainer.classList.add('deckmind-collapsed');
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ deckmind_hud_collapsed: true });
          }
        });
      }

      // Label click opens studio
      const labelClick = document.getElementById('deckmind-label-click');
      if (labelClick) {
        labelClick.addEventListener('click', (e) => {
          e.stopPropagation();
          if (hasMoved || isDragging) return;
          playTactileSound('pop');
          triggerOpenStudio();
        });
      }

      // Action: Instant In-Page Preview
      const btnPreview = document.getElementById('deckmind-quick-preview');
      if (btnPreview) {
        btnPreview.addEventListener('click', (e) => {
          e.stopPropagation();
          playTactileSound('chime');
          triggerInPagePreview();
        });
      }

      // Action: Quick PPTX
      const btnQuick = document.getElementById('deckmind-quick-pptx');
      if (btnQuick) {
        btnQuick.addEventListener('click', (e) => {
          e.stopPropagation();
          playTactileSound('chime');
          triggerQuickPPTX();
        });
      }

      // Action: Quick DOCX
      const btnDocx = document.getElementById('deckmind-quick-docx');
      if (btnDocx) {
        btnDocx.addEventListener('click', (e) => {
          e.stopPropagation();
          playTactileSound('pop');
          triggerQuickDOCX();
        });
      }

      // Action: Studio Launcher
      const btnStudio = document.getElementById('deckmind-open-studio');
      if (btnStudio) {
        btnStudio.addEventListener('click', (e) => {
          e.stopPropagation();
          playTactileSound('pop');
          triggerOpenStudio();
        });
      }

      // Bind Preview Modal Controls
      const btnClosePreview = document.getElementById('deckmind-preview-close');
      if (btnClosePreview) {
        btnClosePreview.addEventListener('click', () => {
          if (previewOverlayEl) previewOverlayEl.classList.remove('active');
        });
      }

      const btnPreviewPrev = document.getElementById('deckmind-preview-prev');
      if (btnPreviewPrev) {
        btnPreviewPrev.addEventListener('click', () => {
          if (previewActiveIdx > 0) {
            previewActiveIdx--;
            renderPreviewSlide();
          }
        });
      }

      const btnPreviewNext = document.getElementById('deckmind-preview-next');
      if (btnPreviewNext) {
        btnPreviewNext.addEventListener('click', () => {
          if (previewActiveIdx < previewSlides.length - 1) {
            previewActiveIdx++;
            renderPreviewSlide();
          }
        });
      }

      const btnPreviewPptx = document.getElementById('deckmind-preview-download-pptx');
      if (btnPreviewPptx) {
        btnPreviewPptx.addEventListener('click', () => {
          playTactileSound('chime');
          triggerQuickPPTX();
        });
      }

      const btnPreviewStudio = document.getElementById('deckmind-preview-open-studio');
      if (btnPreviewStudio) {
        btnPreviewStudio.addEventListener('click', () => {
          if (previewOverlayEl) previewOverlayEl.classList.remove('active');
          triggerOpenStudio();
        });
      }

      // Keyboard Shortcuts
      window.addEventListener('keydown', (e) => {
        if (e.altKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
          if (hudContainer) {
            hudContainer.style.display = hudContainer.style.display === 'none' ? 'block' : 'none';
          }
        }
        if (previewOverlayEl && previewOverlayEl.classList.contains('active')) {
          if (e.key === 'Escape') {
            previewOverlayEl.classList.remove('active');
          } else if (e.key === 'ArrowRight' || e.key === 'Space') {
            if (previewActiveIdx < previewSlides.length - 1) {
              previewActiveIdx++;
              renderPreviewSlide();
            }
          } else if (e.key === 'ArrowLeft') {
            if (previewActiveIdx > 0) {
              previewActiveIdx--;
              renderPreviewSlide();
            }
          }
        }
      });

      // Window resize adjustment
      window.addEventListener('resize', () => {
        if (hudContainer && hudContainer.style.left) {
          const rect = hudContainer.getBoundingClientRect();
          applyHUDPosition(rect.left, rect.top, true);
        }
        checkAndApplyDarkMode();
      });

      scheduleScan(1000);
    } catch (err) {
      console.warn('[DeckMind AI] HUD initialization skipped:', err);
    }
  }

  /**
   * Show HUD Toast
   */
  function showToast(message, duration = 3000) {
    if (!toastEl) return;
    try {
      const textEl = document.getElementById('deckmind-toast-text');
      if (textEl) textEl.textContent = message;
      toastEl.classList.add('show');
      setTimeout(() => {
        if (toastEl) toastEl.classList.remove('show');
      }, duration);
    } catch (e) {}
  }

  /**
   * Schedule debounced scan
   */
  function scheduleScan(delay = 1200) {
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(() => {
      updateScan();
    }, delay);
  }

  /**
   * Scan active chat DOM safely without blocking host app
   */
  function updateScan() {
    if (isScanning || typeof window.DeckMindParsers === 'undefined') return;
    isScanning = true;

    try {
      const chat = window.DeckMindParsers.extractCurrentChat(document);
      const turns = (chat && chat.turns) || [];
      const turnCount = turns.length;

      const counterEl = document.getElementById('deckmind-turn-count');
      if (counterEl) {
        const newText = turnCount > 0 ? `${turnCount} Turns Captured` : 'Chat Ready';
        if (counterEl.textContent !== newText) {
          counterEl.textContent = newText;
        }
      }

      const platformTag = document.getElementById('deckmind-platform-tag');
      if (platformTag && chat.platform) {
        platformTag.textContent = chat.platform.toUpperCase();
      }

      if (turnCount !== lastTurnCount) {
        lastTurnCount = turnCount;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({ action: 'UPDATE_BADGE', count: turnCount }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      }
    } catch (e) {
      console.warn('[DeckMind AI] Safe scan notice:', e);
    } finally {
      isScanning = false;
    }
  }

  /**
   * Package current conversation state safely
   */
  function packageCurrentChat() {
    const rawChat = window.DeckMindParsers.extractCurrentChat(document);
    const serializableTurns = (rawChat.turns || []).map(t => ({
      id: t.id,
      index: t.index,
      role: t.role,
      text: t.text,
      headings: t.headings || [],
      bullets: t.bullets || [],
      tables: t.tables || [],
      boldHighlights: t.boldHighlights || [],
      codeBlocks: t.codeBlocks || [],
      timestamp: t.timestamp || Date.now()
    }));

    return {
      title: rawChat.title || document.title || 'AI Strategy Presentation',
      platform: rawChat.platform || 'AI Platform',
      turns: serializableTurns,
      url: window.location.href,
      extractedAt: Date.now()
    };
  }

  /**
   * Instant In-Page Slide Deck Preview Generator
   */
  function triggerInPagePreview() {
    const payload = packageCurrentChat();
    if (!payload.turns || payload.turns.length === 0) {
      showToast('No active conversation detected to preview.');
      return;
    }

    // Synthesize preview slides from turns
    const title = payload.title.replace(/^ChatGPT - | - Claude| - Gemini/i, '').trim();
    previewSlides = [
      {
        tag: 'EXECUTIVE COVER',
        title: title,
        subtitle: `Synthesized presentation from ${payload.turns.length} conversation turns on ${payload.platform}.`,
        bullets: [
          'High-Isolation Architecture & Strategic Direction',
          'Verbatim grounded turns mapped to slide evidence ledger',
          'Executive visual hierarchy ready for 16:9 PowerPoint export'
        ]
      }
    ];

    payload.turns.filter(t => t.role === 'assistant').slice(0, 6).forEach((turn, idx) => {
      const heading = (turn.headings && turn.headings[0]) || `Strategic Architectural Pillar ${idx + 1}`;
      const bullets = (turn.bullets && turn.bullets.length > 0) 
        ? turn.bullets.slice(0, 3) 
        : turn.text.split('\n').filter(l => l.trim().length > 15).slice(0, 3);

      previewSlides.push({
        tag: `PILLAR 0${idx + 1}`,
        title: heading,
        subtitle: `Key operational conclusions discussed in Turn #${turn.index || idx + 1}.`,
        bullets: bullets.map(b => b.replace(/^\*+\s*/, '').slice(0, 140))
      });
    });

    previewActiveIdx = 0;
    const titleEl = document.getElementById('deckmind-preview-deck-title');
    if (titleEl) titleEl.textContent = title;

    if (previewOverlayEl) {
      previewOverlayEl.classList.add('active');
      renderPreviewSlide();
    }
  }

  function renderPreviewSlide() {
    const canvas = document.getElementById('deckmind-preview-canvas');
    const indicator = document.getElementById('deckmind-preview-indicator');
    if (!canvas || !previewSlides || previewSlides.length === 0) return;

    const s = previewSlides[previewActiveIdx];
    if (!s) return;

    if (indicator) {
      indicator.textContent = `Slide ${previewActiveIdx + 1} of ${previewSlides.length}`;
    }

    canvas.innerHTML = `
      <div style="display: flex; flex-direction: column; height: 100%; justify-content: space-between;">
        <div>
          <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 800; font-family: monospace; background: #FFF1F2; color: #BE185D; margin-bottom: 8px;">
            ${escapeSafe(s.tag)}
          </span>
          <h2 style="font-size: 22px; font-weight: 800; color: #18181B; margin: 0 0 6px 0; letter-spacing: -0.3px;">
            ${escapeSafe(s.title)}
          </h2>
          <p style="font-size: 13px; color: #52525B; margin: 0 0 16px 0;">
            ${escapeSafe(s.subtitle || '')}
          </p>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 8px;">
          ${(s.bullets || []).map((b, i) => `
            <div style="background: #FAF7F2; border: 1.5px solid #18181B; border-radius: 8px; padding: 12px; box-shadow: 2px 2px 0px #18181B;">
              <span style="font-size: 11px; font-weight: 800; font-family: monospace; color: #FB7185;">0${i + 1}</span>
              <p style="font-size: 12px; font-weight: 600; color: #18181B; margin: 4px 0 0 0; line-height: 1.35;">${escapeSafe(b)}</p>
            </div>
          `).join('')}
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 10.5px; font-family: monospace; color: #A1A1AA; border-top: 1px solid #EAE5DD; padding-top: 6px;">
          <span>DECKMIND AI • IN-PAGE PREVIEW</span>
          <span>16:9 EXECUTIVE FORMAT</span>
        </div>
      </div>
    `;
  }

  function escapeSafe(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Action 1: Instant Quick PPTX Download
   */
  async function triggerQuickPPTX() {
    showToast('Synthesizing Presentation...');
    try {
      const payload = packageCurrentChat();
      if (!payload.turns || payload.turns.length === 0) {
        showToast('No active conversation detected.');
        return;
      }

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ activeChatData: payload, currentDeckPayload: null });
        chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', autoDownload: 'pptx' }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (err) {
      console.error('[DeckMind AI] Quick PPTX trigger error:', err);
      showToast('Generation notice: ' + err.message);
    }
  }

  /**
   * Action 2: Instant Quick Word Document (.docx)
   */
  async function triggerQuickDOCX() {
    showToast('Building Word Document (.docx)...');
    try {
      const payload = packageCurrentChat();
      if (!payload.turns || payload.turns.length === 0) {
        showToast('No active conversation detected.');
        return;
      }

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ activeChatData: payload, currentDeckPayload: null });
        chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', autoDownload: 'docx' }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (err) {
      console.error('[DeckMind AI] Quick DOCX trigger error:', err);
      showToast('Word export notice: ' + err.message);
    }
  }

  /**
   * Action 3: Open Deck Studio
   */
  async function triggerOpenStudio() {
    showToast('Launching DeckMind Studio...');
    try {
      const payload = packageCurrentChat();
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ activeChatData: payload, currentDeckPayload: null });
        chrome.runtime.sendMessage({ action: 'OPEN_STUDIO' }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (err) {
      console.error('[DeckMind AI] Open Studio error:', err);
      showToast('Error launching studio: ' + err.message);
    }
  }

  /**
   * Teleport and Highlight Turn Element
   */
  function highlightTurn(turnIndex) {
    try {
      const rawChat = window.DeckMindParsers.extractCurrentChat(document);
      const turn = (rawChat.turns || [])[turnIndex];
      if (turn && turn.elementRef) {
        turn.elementRef.scrollIntoView({ behavior: 'smooth', block: 'center' });
        turn.elementRef.classList.add('deckmind-highlighted-turn');
        setTimeout(() => {
          if (turn.elementRef) {
            turn.elementRef.classList.remove('deckmind-highlighted-turn');
          }
        }, 4000);
      }
    } catch (e) {
      console.warn('[DeckMind AI] Highlight error:', e);
    }
  }

  // Listen for background / popup commands
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      try {
        if (req.action === 'TRIGGER_HUD_GENERATE') {
          triggerOpenStudio();
          sendResponse({ status: 'ok' });
          return true;
        }
        if (req.action === 'EXTRACT_CURRENT_CHAT') {
          const payload = packageCurrentChat();
          sendResponse({ status: 'ok', data: payload });
          return true;
        }
        if (req.action === 'HIGHLIGHT_TURN') {
          highlightTurn(req.turnIndex);
          sendResponse({ status: 'ok' });
          return true;
        }
      } catch (err) {
        console.warn('[DeckMind AI] Message handler notice:', err);
      }
      return false;
    });
  }

  // Non-blocking Mutation Observer with strict self-ignoring filter
  try {
    const observer = new MutationObserver((mutations) => {
      const isSelfMutation = mutations.every(m => {
        return m.target && (
          m.target.id === 'deckmind-hud-container' ||
          m.target.id === 'deckmind-toast' ||
          m.target.id === 'deckmind-preview-overlay' ||
          (m.target.closest && (
            m.target.closest('#deckmind-hud-container') ||
            m.target.closest('#deckmind-preview-overlay')
          ))
        );
      });

      if (!isSelfMutation) {
        scheduleScan(1500);
      }
    });

    function startObserver() {
      initHUD();
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserver);
    } else {
      startObserver();
    }
  } catch (err) {
    console.warn('[DeckMind AI] Observer setup error:', err);
  }
})();
