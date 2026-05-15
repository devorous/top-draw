<script>
  import { onMount } from 'svelte';
  import { appState } from '../../state.svelte.js';

  const FINISHED_KEY = 'tutorial_v1_finished';
  const STOPPED_KEY = 'tutorial_v1_stopped';
  const VISIT_MARKER_KEY = 'tutorial_v1_visit_marker';

  const steps = [
    {
      section: 'Basic Tutorial',
      title: 'Tweak Your Settings',
      target: '[data-tut="perf-settings"], #appSettingsBtn',
      text: 'Before you start drawing, you can open Settings to adjust performance, power use, controls, and app preferences for your device.',
      actionTarget: '[data-tut="perf-settings"], #appSettingsBtn',
      actionLabel: 'Click Settings to review your setup, or press Next'
    },
    {
      section: 'Basic Tutorial',
      title: 'Setting Settings',
      target: '[data-tut="app-settings-dialog"], .app-settings-dialog',
      text: 'Change anything you want here. When you are done, press Next',
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Room Settings',
      target: '[data-tut="room-settings"], #roomSettingsBtn',
      text: 'Room settings appear for rooms you can edit, including unowned rooms created by this browser.',
      actionTarget: '[data-tut="room-settings"], #roomSettingsBtn',
      actionLabel: 'Click Room Settings to review the room, or press Next',
      when: () => canEditRoomSettings()
    },
    {
      section: 'Basic Tutorial',
      title: 'Setting Room Settings',
      target: '[data-tut="room-settings-dialog"], .room-settings-dialog',
      text: 'Set the room description, privacy, join policy, background, board size, and moderation behavior here.',
      when: () => canEditRoomSettings(),
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Mirror Mode',
      target: '[data-tut="mirror"], #mirrorBtn',
      text: 'Mirror mode lets you create symmetrical drawing areas for patterns, faces, and shared layouts.',
      actionTarget: '[data-tut="mirror"], #mirrorBtn',
      actionLabel: 'Click Mirror to start drawing a mirror region'
    },
    {
      section: 'Basic Tutorial',
      title: 'Draw Mirror Region',
      target: '[data-tut="mirror"], #mirrorBtn',
      text: 'Draw a region on the canvas. Mirror regions can reflect strokes horizontally, vertically, or both depending on the mode, which is useful for faces, icons, patterns, and balanced compositions.',
      allowCanvas: true,
      actionLabel: 'The canvas is unlocked. Draw a mirror region, then press Next'
    },
    {
      section: 'Basic Tutorial',
      title: 'Edit Mirror Region',
      target: '[data-tut="mirror"], #mirrorBtn',
      text: 'To edit or remove a mirror region later, press the Mirror button again. It brings back the mirror controls so you can adjust or clear the region.',
      actionTarget: '[data-tut="mirror"], #mirrorBtn',
      actionLabel: 'Click Mirror again to review editing/removal controls, or press Next',
      allowCanvas: true,
      targetControl: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Mirror Region Controls',
      target: '[data-tut="mirror-region-controls"], [data-tut="mirror-region-panel"], #mirrorRegionPanel',
      text: 'Use the region controls to edit or remove the mirror region. Click Edit to change the mirror mode and guides, or X to remove the region from the canvas.',
      allowCanvas: true,
      targetControl: true,
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Add View',
      target: '[data-tut="add-view"], .boardViewerLaunch',
      text: 'Add View opens a second viewport. Click it to see the board viewer now, or press Next to skip.',
      actionTarget: '[data-tut="add-view"], .boardViewerLaunch',
      actionLabel: 'Click Add View to continue'
    },
    {
      section: 'Basic Tutorial',
      title: 'Board View',
      target: '[data-tut="board-view-controls"], .boardViewer',
      text: 'Board View is a separate viewport you can pan, zoom, reset, or pop out onto another monitor.',
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'User List',
      target: '[data-tut="user-list"], #userList',
      text: 'The user list shows who is present, their activity, and rank colors for moderation context.'
    },
    {
      section: 'Basic Tutorial',
      title: 'Right-Click Menu',
      target: '[data-tut="context-menu"], #userContextMenu, #selfContextMenu',
      fallbackTarget: '[data-tut="user-list"], #userList',
      text: 'Right-click a user to open actions like profile, sync, spectate, message, and moderation tools.',
      waitForTarget: true,
      actionLabel: 'Right-click yourself or another user, then press Next'
    },
    {
      section: 'Basic Tutorial',
      title: 'Ranks',
      target: '[data-tut="ranks-dialog"]',
      text: 'Room ranks and global ranks are separate. Global ranks can stack with room ranks, so a Noble can also be a room Mod or Admin.',
      beforeEnter: () => { appState.ranksDialogVisible = true; }
    },
    {
      section: 'Basic Tutorial',
      title: 'Layers & Blending',
      target: '[data-tut="layer-1"], .layer-btn[data-tut="layer-1"]',
      text: 'There are 3 layers by default. Blend modes are active only on layer 1. Select the blend mode drop down.',
      actionTarget: '[data-tut="layer-1"], .layer-btn[data-tut="layer-1"]',
      actionLabel: 'Click Layer 1, then press Next'
    },
    {
      section: 'Basic Tutorial',
      title: 'Blend Modes',
      target: '[data-tut="blend-mode"], .blend-btn',
      fallbackTarget: '[data-tut="layer-1"], .layer-btn[data-tut="layer-1"]',
      text: 'Blend modes change how new strokes combine with colour underneath them. Multiply darkens, Screen lightens, Add brightens, and Difference inverts against existing colour.',
      actionTarget: '[data-tut="blend-mode"], .blend-btn',
      actionLabel: 'Open the blend mode dropdown'
    },
    {
      section: 'Basic Tutorial',
      title: 'BG vs Existing',
      target: '[data-tut="blend-bake-toggle"], .blend-bake-toggle',
      fallbackTarget: '.blend-dropdown, [data-tut="blend-mode"], .blend-btn',
      text: 'BG blends each stroke against the room background. Existing blends only where pixels already exist. Try switching between BG and Existing, then draw on the canvas to compare.',
      allowCanvas: true,
      actionLabel: 'The canvas is unlocked for testing on this step'
    },
    {
      section: 'Basic Tutorial',
      title: 'History & Snapshots',
      target: '[data-tut="history"], .history-btn',
      text: 'History covers persistent server saves and private local snapshots you can restore or upload from.',
      actionTarget: '[data-tut="history"], .history-btn',
      actionLabel: 'Click History to review snapshots, or press Next to skip'
    },
    {
      section: 'Basic Tutorial',
      title: 'Board History',
      target: '[data-tut="history-dialog"], .snapshot-panel',
      text: 'This panel lets you preview snapshots, compare local and server saves, and restore or upload selected work.',
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Tool Locks',
      target: '[data-tut="locks"], .lockBtn, #sizeLock',
      targetAll: true,
      text: 'Tool locks save values per tool. You can shift click to lock or unlock all the settings on a tool. Blend modes also have a lock and some values are locked by default. ',
      beforeEnter: () => window.app?.selectTool?.('ink')
    },
    {
      section: 'Selection',
      title: 'The Selection Tool',
      target: '#selectBtn',
      text: 'The Selection Tool lets you isolate parts of your drawing to move, transform, or use as a mask.',
      actionTarget: '#selectBtn',
      actionLabel: 'Click Selection Tool to begin'
    },
    {
      section: 'Selection',
      title: 'Lasso vs Rectangle',
      target: '#selectionModeOptions',
      text: 'Choose between Lasso for freehand shapes or Rectangle for precise boxes. Switch between them here.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Making a Selection',
      target: '#boardContainer',
      text: 'Click and drag on the canvas to create your selection. The moving dashed line indicates the active area.',
      allowCanvas: true,
      actionLabel: 'Draw a selection on the canvas'
    },
    {
      section: 'Selection',
      title: 'The Selection Menu',
      target: '#selectionMenu',
      text: 'Once you have a selection, this floating menu appears. It follows your selection and provides quick access to actions like Mask, Clone, Brush, and Obscure.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Moving & Transforming',
      target: '#selectionMenu',
      text: 'Move the selection by dragging it. Use the white corner handles to resize, the top handle to rotate, and the teal handles for perspective warping.',
      allowCanvas: true,
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Draw another selection',
      target: '#boardContainer',
      text: 'Draw a new selection on the canvas. Notice how the previous selection is replaced automatically. We will use this one to explore advanced actions like Clone and Obscure.',
      allowCanvas: true,
      actionLabel: 'Draw a new selection on the canvas'
    },
    {
      section: 'Selection',
      title: 'Clone Selection',
      target: '#selMenuClone',
      text: 'The Clone button creates a floating copy of your selection. You can move and stamp this copy multiple times without affecting the original pixels until you apply it.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Mask Mode',
      target: '#selMenuMask',
      text: 'Toggle Mask mode to lock the selection in place. Your strokes will only appear inside the selected area, allowing for precise coloring.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Use as Brush',
      target: '#selMenuBrush',
      text: 'The Brush button lets you turn your current selection into a custom image brush stamp.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Obscure Content',
      target: '#selMenuObscure',
      text: 'The Obscure action hides the selected area behind a blur until other users click to reveal it. Useful for spoilers or hidden details.',
      skipIfMissing: true
    },
    {
      section: 'Advanced Tools',
      title: 'Text Tool',
      target: '#textBtn',
      text: 'The Text tool lets you place editable text on the canvas. Click anywhere on the board to start typing. Clicking with no text entered swaps you back to your previous tool.',
      actionTarget: '#textBtn',
      actionLabel: 'Click the Text tool to begin'
    },
    {
      section: 'Advanced Tools',
      title: 'Text Shortcuts',
      target: '#textBtn',
      text: 'While typing: Enter commits the text to the board, Shift+Enter starts a new line within the same text block, and Ctrl+Backspace deletes a whole word at a time.',
      allowCanvas: true,
      actionLabel: 'Try placing text on the canvas, then press Next'
    },
    {
      section: 'Advanced Tools',
      title: 'Fonts',
      target: '#font-container',
      text: 'Pick a font from the gallery. Each one has its own personality — try a few on the canvas to see how they read.',
      allowCanvas: true,
      skipIfMissing: true
    },
    {
      section: 'Advanced Tools',
      title: 'Flood Fill',
      target: '#fillBtn',
      text: 'Flood Fill replaces a connected region of similar colour. Select it now.',
      actionTarget: '#fillBtn',
      actionLabel: 'Click the Fill tool to continue'
    },
    {
      section: 'Advanced Tools',
      title: 'Draw a Circle to Fill',
      target: '#circleBtn',
      text: 'First, let\'s give the fill something to work with. The Circle tool is now active — draw a circle on the canvas, then press Next.',
      beforeEnter: () => window.app?.selectTool?.('circle'),
      allowCanvas: true,
      actionLabel: 'Draw a circle on the canvas, then press Next'
    },
    {
      section: 'Advanced Tools',
      title: 'Advanced Fill',
      target: '#fillModeOptions',
      text: 'Switching back to Fill. Enable Advanced, then click inside your circle and drag: up/down to increase or decrease the blur of the fill edge, and left/right to expand or contract the fill area.',
      beforeEnter: () => window.app?.selectTool?.('fill'),
      allowCanvas: true,
      skipIfMissing: true
    },
    {
      section: 'Advanced Tools',
      title: 'Glitch Blur',
      target: '#glitchBlurBtn',
      text: 'This brush messes existing pixels up. Try it on the canvas.',
      beforeEnter: () => window.app?.selectTool?.('glitchBlur'),
      allowCanvas: true,
      actionLabel: 'Drag across the canvas to try it'
    },
    {
      section: 'Advanced Tools',
      title: 'Pattern Brush',
      target: '#patternBtn',
      text: 'The Pattern Brush paints with a repeating image tile instead of a solid stroke. Select it to see the pattern controls.',
      actionTarget: '#patternBtn',
      actionLabel: 'Click the Pattern tool to continue'
    },
    {
      section: 'Advanced Tools',
      title: 'Pattern Controls',
      target: '#patternModeOptions',
      text: 'Upload your own images or pick from the gallery. Tune Image Scale, Grid Rotation, and Grid Spacing for textile-like results. Switch Colour Mode to tint patterns with your current colour.',
      allowCanvas: true,
      skipIfMissing: true
    }
  ];

  let active = $state(false);
  let promptVisible = $state(false);
  let activeSection = $state(null);
  let index = $state(0);
  let rect = $state(null);
  let targetMissing = $state(false);
  let toastPosition = $state(null);
  let dragState = null;
  let rafId = null;
  let mutationObserver = null;
  let preparedStep = null;

  let visibleSteps = $derived(steps.filter((step) => (!step.when || step.when()) && (!activeSection || step.section === activeSection)));
  let currentStep = $derived(visibleSteps[index] || visibleSteps[visibleSteps.length - 1]);
  let total = $derived(visibleSteps.length);
  let sections = $derived([...new Set(steps.filter(s => !s.when || s.when()).map((step) => step.section || 'Tutorial'))]);

  function canEditRoomSettings() {
    const roomData = appState.currentRoomData;
    if (!appState.connected || !appState.currentRoomId || !roomData) return false;
    if ((appState.selfGlobalRole || 0) >= 8) return true;
    return (roomData.ownerId && (appState.selfRoomRole || 0) >= 5) || (!roomData.ownerId && appState.roomCreatedByThisBrowser);
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage can fail in private browsing; the tutorial should still run.
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }

  function hasStorageKey(key) {
    return storageGet(key) !== null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const bounds = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
  }

  function findTargets(step = currentStep) {
    if (!step?.target) return null;
    const matches = [];
    for (const primary of document.querySelectorAll(step.target)) {
      if (isVisible(primary)) matches.push(primary);
    }
    if (matches.length > 0) return step.targetAll ? matches : [matches[0]];
    if (step.fallbackTarget) {
      for (const fallback of document.querySelectorAll(step.fallbackTarget)) {
        if (isVisible(fallback)) return [fallback];
      }
    }
    return null;
  }

  function findTarget(step = currentStep) {
    return findTargets(step)?.[0] || null;
  }

  function cleanupStep(step) {
    if (step?.target?.includes('app-settings-dialog')) {
      appState.appSettingsVisible = false;
    }
    if (step?.target?.includes('room-settings-dialog')) {
      appState.roomSettingsVisible = false;
    }
    if (step?.target?.includes('history-dialog')) {
      appState.snapshotMenuVisible = false;
    }
    if (step?.target?.includes('ranks-dialog')) {
      appState.ranksDialogVisible = false;
    }
  }

  function updateSpotlight() {
    if (!active) return;

    const targets = currentStep?.allowCanvas && !currentStep?.targetControl
      ? findTargets({ target: '#boardContainer, #boards, #board' })
      : findTargets();
    targetMissing = !!currentStep?.target && !targets;

    if (!targets) {
      rect = null;
      return;
    }

    const rects = targets.map((target) => target.getBoundingClientRect());
    const bounds = {
      top: Math.min(...rects.map((item) => item.top)),
      left: Math.min(...rects.map((item) => item.left)),
      right: Math.max(...rects.map((item) => item.right)),
      bottom: Math.max(...rects.map((item) => item.bottom))
    };
    bounds.width = bounds.right - bounds.left;
    bounds.height = bounds.bottom - bounds.top;
    const pad = 3;
    const top = Math.max(0, bounds.top - pad);
    const left = Math.max(0, bounds.left - pad);
    rect = {
      top,
      left,
      width: Math.min(window.innerWidth - left, bounds.width + pad * 2),
      height: Math.min(window.innerHeight - top, bounds.height + pad * 2)
    };
  }

  function scheduleSpotlight() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateSpotlight();
    });
  }

  function stepIsAvailable(step) {
    if (!step?.skipIfMissing) return true;
    return !!findTarget(step);
  }

  function isMirrorTutorialOpen() {
    return !!(
      window.app?.mirrorRegionController?.active ||
      findTarget({ target: '[data-tut="mirror-region-controls"]' }) ||
      findTarget({ target: '[data-tut="mirror-region-panel"], #mirrorRegionPanel' })
    );
  }

  function firstIndexAfterSection(section, startIndex = index) {
    for (let i = startIndex + 1; i < visibleSteps.length; i += 1) {
      if ((visibleSteps[i].section || 'Tutorial') !== section) return i;
    }
    return visibleSteps.length;
  }

  function moveToIndex(nextIndex) {
    let candidate = nextIndex;
    while (candidate < visibleSteps.length && !stepIsAvailable(visibleSteps[candidate])) {
      candidate += 1;
    }
    if (candidate >= visibleSteps.length) {
      finish();
      return;
    }
    index = candidate;
    scheduleSpotlight();
  }

  function next() {
    cleanupStep(currentStep);
    if (index >= visibleSteps.length - 1) {
      finish();
      return;
    }
    if (currentStep?.title === 'Mirror Mode' && !isMirrorTutorialOpen()) {
      moveToIndex(firstIndexAfterSection('Basic Tutorial'));
      return;
    }
    moveToIndex(index + 1);
  }

  function back() {
    let candidate = Math.max(0, index - 1);
    while (candidate > 0 && !stepIsAvailable(visibleSteps[candidate])) {
      candidate -= 1;
    }
    index = candidate;
    scheduleSpotlight();
  }

  function stop() {
    storageSet(STOPPED_KEY, 'true');
    promptVisible = false;
    active = false;
  }

  function finish() {
    storageSet(FINISHED_KEY, 'true');
    promptVisible = false;
    active = false;
  }

  function resetTutorial() {
    storageRemove(FINISHED_KEY);
    storageRemove(STOPPED_KEY);
    startTutorial();
  }

  function startTutorial(section = 'Basic Tutorial') {
    activeSection = section;
    index = 0;
    preparedStep = null;
    promptVisible = false;
    active = true;
    scheduleSpotlight();
  }

  function startFromPrompt() {
    startTutorial('Basic Tutorial');
  }

  function skipFromPrompt() {
    stop();
  }

  function goToSection(section) {
    const nextIndex = visibleSteps.findIndex((step) => (step.section || 'Tutorial') === section);
    if (nextIndex < 0) return;
    index = nextIndex;
    scheduleSpotlight();
  }

  function maybeStart() {
    if (active || promptVisible || storageGet(FINISHED_KEY) || storageGet(STOPPED_KEY)) return;
    const landing = document.getElementById('landingPage');
    const board = document.getElementById('boardContainer');
    if (isVisible(board) && !isVisible(landing)) {
      storageSet(VISIT_MARKER_KEY, 'true');
      promptVisible = true;
    }
  }

  function handleDocumentClick(event) {
    if (!active) return;
    const step = currentStep;
    if (!step?.actionTarget) return;
    if (event.target?.closest?.(step.actionTarget)) {
      setTimeout(next, 120);
    }
  }

  function isCanvasUnlocked() {
    return !!currentStep?.allowCanvas;
  }

  function shouldShowScrim() {
    return !currentStep?.targetControl;
  }

  function handleMirrorRegionApplied() {
    if (!active || currentStep?.title !== 'Draw Mirror Region') return;
    next();
  }

  function handleMirrorRegionRemoved() {
    if (!active || (currentStep?.section || 'Tutorial') !== 'Basics') return;
    cleanupStep(currentStep);
    moveToIndex(firstIndexAfterSection('Basic Tutorial'));
  }

  function handleContextMenu() {
    if (!active || !currentStep?.waitForTarget) return;
    setTimeout(() => {
      updateSpotlight();
    }, 120);
  }

  function handleToastPointerDown(event) {
    if (event.target?.closest?.('button')) return;
    const toast = event.currentTarget;
    const bounds = toast.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top
    };
    toast.setPointerCapture(event.pointerId);
  }

  function handleToastPointerMove(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const width = Math.min(440, window.innerWidth - 24);
    const height = 210;
    toastPosition = {
      x: Math.min(Math.max(12, event.clientX - dragState.offsetX), Math.max(12, window.innerWidth - width - 12)),
      y: Math.min(Math.max(8, event.clientY - dragState.offsetY), Math.max(8, window.innerHeight - height - 8))
    };
  }

  function handleToastPointerUp(event) {
    if (dragState?.pointerId === event.pointerId) {
      dragState = null;
    }
  }

  $effect(() => {
    if (!active) return;
    scheduleSpotlight();
  });

  $effect(() => {
    if (!active || !currentStep) return;
    const stepKey = `${index}:${currentStep.title}`;
    if (preparedStep === stepKey) return;
    preparedStep = stepKey;
    currentStep.beforeEnter?.();
    setTimeout(scheduleSpotlight, 80);
  });

  $effect(() => {
    visibleSteps;
    if (index >= visibleSteps.length) {
      index = Math.max(0, visibleSteps.length - 1);
    }
  });

  onMount(() => {
    window.startTopDrawTutorial = startTutorial;
    const interval = setInterval(maybeStart, 1000);
    window.addEventListener('resize', scheduleSpotlight);
    window.addEventListener('scroll', scheduleSpotlight, true);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('topdraw:mirror-region-applied', handleMirrorRegionApplied);
    window.addEventListener('topdraw:mirror-region-removed', handleMirrorRegionRemoved);
    mutationObserver = new MutationObserver(scheduleSpotlight);
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-tut'] });
    maybeStart();

    return () => {
      clearInterval(interval);
      if (rafId) cancelAnimationFrame(rafId);
      mutationObserver?.disconnect();
      window.removeEventListener('resize', scheduleSpotlight);
      window.removeEventListener('scroll', scheduleSpotlight, true);
      document.removeEventListener('click', handleDocumentClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('topdraw:mirror-region-applied', handleMirrorRegionApplied);
      window.removeEventListener('topdraw:mirror-region-removed', handleMirrorRegionRemoved);
      if (window.startTopDrawTutorial === startTutorial) {
        delete window.startTopDrawTutorial;
      }
    };
  });
</script>

{#if promptVisible}
  <div class="tutorialLayer" role="presentation">
    <div class="tutorialToast tutorialPromptToast" role="dialog" aria-modal="true" aria-labelledby="tutorialPromptTitle">
      <div class="tutorialBody">
        <h2 id="tutorialPromptTitle">Interactive Tutorials</h2>
        <p>Choose a tour to learn about Top Draw's tools and features.</p>
        <div class="tutorialSegmentedBar">
          <button type="button" onclick={() => startTutorial('Basic Tutorial')}>Basic Tutorial</button>
          <button type="button" onclick={() => startTutorial('Selection')}>Selection</button>
          <button type="button" onclick={() => startTutorial('Advanced Tools')}>Advanced Tools</button>
        </div>
      </div>
      <div class="tutorialActions">
        <button type="button" onclick={skipFromPrompt}>No thanks</button>
      </div>
    </div>
  </div>
{/if}

{#if active}
  <div class="tutorialLayer" aria-live="polite">
    {#if rect}
      {#if shouldShowScrim()}
        <div class="tutorialScrim top" class:passthrough={isCanvasUnlocked()} style={`height:${rect.top}px`}></div>
        <div class="tutorialScrim left" class:passthrough={isCanvasUnlocked()} style={`top:${rect.top}px;width:${rect.left}px;height:${rect.height}px`}></div>
        <div class="tutorialScrim right" class:passthrough={isCanvasUnlocked()} style={`top:${rect.top}px;left:${rect.left + rect.width}px;height:${rect.height}px`}></div>
        <div class="tutorialScrim bottom" class:passthrough={isCanvasUnlocked()} style={`top:${rect.top + rect.height}px`}></div>
      {/if}
      <div class="tutorialRing" style={`top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`}></div>
    {:else}
      <div class="tutorialScrim full" class:passthrough={isCanvasUnlocked()}></div>
    {/if}

    <div
      class="tutorialToast"
      class:dragged={!!toastPosition}
      style={toastPosition ? `left:${toastPosition.x}px;top:${toastPosition.y}px;transform:none;` : ''}
      role="dialog"
      tabindex="-1"
      aria-label="Tutorial"
      onpointerdown={handleToastPointerDown}
      onpointermove={handleToastPointerMove}
      onpointerup={handleToastPointerUp}
      onpointercancel={handleToastPointerUp}
    >
      <div class="tutorialSegmentedBar mini">
        <button type="button" class:active={activeSection === 'Basic Tutorial'} onclick={() => startTutorial('Basic Tutorial')}>Basic Tutorial</button>
        <button type="button" class:active={activeSection === 'Selection'} onclick={() => startTutorial('Selection')}>Selection</button>
        <button type="button" class:active={activeSection === 'Advanced Tools'} onclick={() => startTutorial('Advanced Tools')}>Advanced Tools</button>
      </div>
      <div class="tutorialProgress" aria-label="Tutorial progress">
        {#each visibleSteps as step, stepIndex}
          <button
            type="button"
            class:active={stepIndex === index}
            class:complete={stepIndex < index}
            title={`${step.section || 'Tutorial'}: ${step.title}`}
            aria-label={`Go to ${step.title}`}
            onclick={() => {
              cleanupStep(currentStep);
              moveToIndex(stepIndex);
            }}
          ></button>
        {/each}
      </div>
      <div class="tutorialBody">
        <h2>{currentStep.title}</h2>
        <p>{currentStep.text}</p>
        {#if currentStep.actionLabel && !targetMissing}
          <div class="tutorialHint">{currentStep.actionLabel}</div>
        {:else if targetMissing}
          <div class="tutorialHint">This control is not visible right now. You can press Next.</div>
        {/if}
      </div>
      <div class="tutorialActions">
        <button type="button" onclick={back} disabled={index === 0}>Back</button>
        <button type="button" class="primary" onclick={next}>{index === total - 1 ? 'Finish' : 'Next'}</button>
        <button type="button" onclick={stop}>Exit Tutorial</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tutorialLayer {
    position: fixed;
    inset: 0;
    z-index: 100000;
    pointer-events: none;
    font-family: inherit;
  }

  .tutorialPromptToast {
    height: auto;
    cursor: default;
    z-index: 100001;
  }

  .tutorialSegmentedBar {
    display: flex;
    width: 100%;
    height: 40px;
    margin-top: 12px;
    background: color-mix(in srgb, var(--text-primary, #fff) 5%, transparent);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    overflow: hidden;
    padding: 2px;
    box-sizing: border-box;
  }

  .tutorialSegmentedBar button {
    flex: 1;
    height: 100%;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary, #b7c0ce);
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }

  .tutorialSegmentedBar button:hover {
    background: color-mix(in srgb, var(--text-primary, #fff) 5%, transparent);
    color: var(--text-primary, #f5f7fb);
  }

  .tutorialSegmentedBar button.active {
    background: var(--accent-primary, #00d4aa);
    color: #06120f;
  }

  .tutorialSegmentedBar.mini {
    height: 28px;
    margin-top: -4px;
    margin-bottom: 6px;
    border-radius: 6px;
    padding: 1px;
    border-color: transparent;
    background: color-mix(in srgb, var(--text-primary, #fff) 3%, transparent);
  }

  .tutorialSegmentedBar.mini button {
    font-size: 0.68rem;
    border-radius: 4px;
  }

  .tutorialScrim {
    position: fixed;
    background: rgba(0, 0, 0, 0.56);
    pointer-events: auto;
  }

  .tutorialScrim.passthrough {
    pointer-events: none;
  }

  .tutorialScrim.full,
  .tutorialScrim.top,
  .tutorialScrim.bottom {
    left: 0;
    right: 0;
  }

  .tutorialScrim.full {
    inset: 0;
  }

  .tutorialScrim.left {
    left: 0;
  }

  .tutorialScrim.right {
    right: 0;
  }

  .tutorialScrim.bottom {
    bottom: 0;
  }

  .tutorialRing {
    position: fixed;
    border: 2px solid var(--accent-primary, #00d4aa);
    border-radius: 8px;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-primary, #00d4aa) 22%, transparent), 0 12px 32px rgba(0, 0, 0, 0.28);
    pointer-events: none;
    animation: tutorialRingPulse 1.6s ease-in-out infinite;
  }

  @keyframes tutorialRingPulse {
    0%, 100% {
      box-shadow:
        0 0 0 4px color-mix(in srgb, var(--accent-primary, #00d4aa) 22%, transparent),
        0 0 0 0 color-mix(in srgb, var(--accent-primary, #00d4aa) 0%, transparent),
        0 12px 32px rgba(0, 0, 0, 0.28);
    }
    50% {
      box-shadow:
        0 0 0 6px color-mix(in srgb, var(--accent-primary, #00d4aa) 42%, transparent),
        0 0 0 14px color-mix(in srgb, var(--accent-primary, #00d4aa) 18%, transparent),
        0 12px 32px rgba(0, 0, 0, 0.28);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tutorialRing {
      animation: none;
    }
  }

  .tutorialToast {
    position: fixed;
    top: max(14px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    width: min(440px, calc(100vw - 24px));
    height: 210px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 10px 12px;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.16));
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-secondary, #1f2530) 95%, transparent);
    color: var(--text-primary, #f5f7fb);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.36);
    pointer-events: auto;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .tutorialToast:active {
    cursor: grabbing;
  }

  .tutorialProgress {
    display: flex;
    height: 18px;
    gap: 2px;
    margin: -6px 0 2px;
    align-items: center;
  }

  .tutorialProgress button {
    flex: 1 1 0;
    min-width: 0;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    position: relative;
  }

  .tutorialProgress button::before {
    content: '';
    position: absolute;
    inset: 6px 0;
    background: color-mix(in srgb, var(--text-primary, #fff) 15%, transparent);
  }

  .tutorialProgress button:first-child {
    border-radius: 999px 0 0 999px;
  }

  .tutorialProgress button:first-child::before {
    border-radius: 999px 0 0 999px;
  }

  .tutorialProgress button:last-child {
    border-radius: 0 999px 999px 0;
  }

  .tutorialProgress button:last-child::before {
    border-radius: 0 999px 999px 0;
  }

  .tutorialProgress button.complete::before {
    background: color-mix(in srgb, var(--accent-primary, #00d4aa) 48%, transparent);
  }

  .tutorialProgress button.active::before {
    background: var(--accent-primary, #00d4aa);
  }

  .tutorialBody {
    flex: 1 1 auto;
    min-height: 0;
  }

  h2 {
    margin: 0 0 4px;
    font-size: 0.92rem;
    line-height: 1.2;
  }

  p {
    margin: 0;
    color: var(--text-secondary, #b7c0ce);
    font-size: 0.8rem;
    line-height: 1.28;
  }

  .tutorialHint {
    margin-top: 6px;
    color: var(--text-primary, #f5f7fb);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .tutorialActions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-shrink: 0;
  }

  button {
    min-width: 0;
    height: 30px;
    padding: 0 9px;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.16));
    border-radius: 6px;
    background: color-mix(in srgb, var(--text-primary, #fff) 7%, transparent);
    color: var(--text-primary, #f5f7fb);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  button.primary {
    background: var(--accent-primary, #00d4aa);
    border-color: transparent;
    color: #06120f;
    font-weight: 800;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  @media (max-width: 520px) {
    .tutorialToast {
      top: 8px;
      padding: 12px;
    }

    .tutorialActions {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    .tutorialActions button:last-child {
      grid-column: 1 / -1;
    }
  }
</style>
