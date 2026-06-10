/**
 * ResizableSections - Makes sections in the tool options panel resizable
 *
 * Adds drag handles between sections to allow height adjustment.
 * Heights are persisted to localStorage.
 */

export class ResizableSections {
  constructor(containerId, sections, options = {}) {
    this.container = document.getElementById(containerId);
    this.sections = sections; // Array of { id, minHeight, defaultHeight } — defaultHeight is only a fallback when content can't be measured
    this.handles = [];
    this.activeResize = null;
    this.storageKey = options.storageKey || 'toolOptions_sectionHeights';
    this.getContextKey = options.getContextKey || (() => 'default');
    this.currentContextKey = 'default';
    this.sharedSectionIds = new Set(options.sharedSectionIds || []);
    this._pendingRefreshKey = null;
    this._pendingRefreshTimer = null;

    this.init();
  }

  init() {
    if (!this.container) return;

    // Setup each section shell and create handles once.
    this.sections.forEach((section, index) => {
      const element = document.getElementById(section.id);
      if (!element) return;

      element.style.flexShrink = '0';
      element.style.flexDirection = 'column';

      if (index < this.sections.length - 1) {
        const handle = this.createHandle();
        this.handles.push(handle);
        this.container.appendChild(handle);
      }
    });

    this.refreshLayout(this.getContextKey());
  }

  createHandle() {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';

    // Add visual indicator
    handle.innerHTML = '<div class="resize-handle-line"></div>';

    // Mouse events
    handle.addEventListener('mousedown', (e) => {
      if (!handle.dataset.topSection || !handle.dataset.bottomSection) return;
      this.startResize(e, handle.dataset.topSection, handle.dataset.bottomSection);
    });

    // Touch events for mobile
    handle.addEventListener('touchstart', (e) => {
      if (!handle.dataset.topSection || !handle.dataset.bottomSection) return;
      e.preventDefault();
      this.startResize(e.touches[0], handle.dataset.topSection, handle.dataset.bottomSection);
    }, { passive: false });

    return handle;
  }

  startResize(event, topSectionId, bottomSectionId) {
    this.activeResize = {
      topSectionId,
      bottomSectionId,
      startY: event.clientY,
      topSection: document.getElementById(topSectionId),
      bottomSection: document.getElementById(bottomSectionId),
      startTopHeight: document.getElementById(topSectionId).offsetHeight,
      startBottomHeight: document.getElementById(bottomSectionId).offsetHeight,
    };

    // Add move and up listeners
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    document.addEventListener('touchend', this.handleTouchEnd);

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  }

  handleMouseMove = (e) => {
    if (!this.activeResize) return;
    this.resize(e.clientY);
  };

  handleTouchMove = (e) => {
    if (!this.activeResize) return;
    e.preventDefault();
    this.resize(e.touches[0].clientY);
  };

  resize(currentY) {
    const { topSection, bottomSection, startY, startTopHeight, startBottomHeight, topSectionId, bottomSectionId } = this.activeResize;

    const deltaY = currentY - startY;
    const newTopHeight = startTopHeight + deltaY;
    const newBottomHeight = startBottomHeight - deltaY;

    // Get min heights
    const topSectionConfig = this.sections.find(s => s.id === topSectionId);
    const bottomSectionConfig = this.sections.find(s => s.id === bottomSectionId);

    const topMinHeight = topSectionConfig?.minHeight || 50;
    const bottomMinHeight = bottomSectionConfig?.minHeight || 50;

    // Only apply if both sections are above minimum
    if (newTopHeight >= topMinHeight && newBottomHeight >= bottomMinHeight) {
      topSection.style.height = `${newTopHeight}px`;

      // Only set explicit height for non-last visible sections
      const visibleSections = this.getVisibleSections();
      const isLastSection = bottomSectionId === visibleSections[visibleSections.length - 1]?.id;
      if (!isLastSection) {
        bottomSection.style.height = `${newBottomHeight}px`;
      }
    }
  }

  handleMouseUp = () => {
    this.endResize();
  };

  handleTouchEnd = () => {
    this.endResize();
  };

  endResize() {
    if (!this.activeResize) return;

    // Remove listeners
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('touchmove', this.handleTouchMove);
    document.removeEventListener('touchend', this.handleTouchEnd);

    // Restore cursor and selection
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    // Save heights
    this.saveHeights();

    this.activeResize = null;
  }

  getContextStorageKey(contextKey = this.getContextKey()) {
    return contextKey || 'default';
  }

  loadAllHeights() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      console.warn('Failed to load section heights:', e);
      return {};
    }
  }

  loadHeights(contextKey = this.currentContextKey) {
    const allHeights = this.loadAllHeights();
    const scopedHeights = allHeights[this.getContextStorageKey(contextKey)] || {};
    const sharedHeights = allHeights.__shared__ || {};

    return {
      ...scopedHeights,
      ...sharedHeights
    };
  }

  saveHeights(contextKey = this.currentContextKey) {
    const allHeights = this.loadAllHeights();
    const heights = { ...(allHeights[this.getContextStorageKey(contextKey)] || {}) };
    const sharedHeights = { ...(allHeights.__shared__ || {}) };

    this.getVisibleSections().forEach(section => {
      const element = section.element;
      if (element && element.style.height) {
        const height = parseInt(element.style.height, 10);
        if (this.sharedSectionIds.has(section.id)) {
          sharedHeights[section.id] = height;
        } else {
          heights[section.id] = height;
        }
      }
    });

    try {
      allHeights[this.getContextStorageKey(contextKey)] = heights;
      allHeights.__shared__ = sharedHeights;
      localStorage.setItem(this.storageKey, JSON.stringify(allHeights));
    } catch (e) {
      console.warn('Failed to save section heights:', e);
    }
  }

  getVisibleSections() {
    this._visibilityCache = new Map();
    const visible = this.sections
      .map(section => ({
        ...section,
        element: document.getElementById(section.id)
      }))
      .filter(section => section.element && this.sectionHasVisibleContent(section));
    this._visibilityCache = null;
    return visible;
  }

  sectionHasVisibleContent(section) {
    const element = section.element || document.getElementById(section.id);
    if (!element) return false;

    // Optimization: Skip scanning children for sections we KNOW are always visible.
    // Do not trust the section shell's current inline display state here because
    // refreshLayout() manages that value. If we treat a previously hidden shell as
    // permanently empty, sections like tool sliders/extras never come back after
    // visiting a tool with no options.
    if (section.hasPersistentContent) return true;

    const contentRoot = section.contentSelector
      ? element.querySelector(section.contentSelector)
      : element;

    if (!contentRoot) return false;

    // Optimization: Skip children scan if the content root itself is explicitly hidden
    if (contentRoot !== element && contentRoot.style.display === 'none') return false;

    const children = contentRoot.children;
    const len = children.length;
    
    if (len === 0) {
      return this.isElementVisible(contentRoot) && !!contentRoot.textContent?.trim();
    }

    // Faster for loop to avoid Array.from/some overhead
    for (let i = 0; i < len; i++) {
      const child = children[i];
      const classList = child.classList;
      if (classList.contains('scroll-indicator') || classList.contains('resize-handle')) {
        continue;
      }

      // Check explicit display style before expensive computed check
      if (child.style.display === 'none') continue;

      if (this.isElementVisible(child)) {
        return true;
      }
    }

    return false;
  }

  isElementVisible(element) {
    if (!element) return false;

    if (element.hidden) return false;

    // Use cached result if available within the same refresh cycle
    if (this._visibilityCache?.has(element)) {
      return this._visibilityCache.get(element);
    }

    // Checking display property first is much faster as it doesn't always trigger style recalc
    if (element.style.display === 'none') {
      this._visibilityCache?.set(element, false);
      return false;
    }

    const style = window.getComputedStyle(element);
    const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
    
    this._visibilityCache?.set(element, isVisible);
    return isVisible;
  }

  refreshLayout(contextKey = this.getContextKey()) {
    if (!this.container) return;

    const newContextKey = this.getContextStorageKey(contextKey);

    // If the tool context changed, run immediately and cancel any pending throttled refresh
    if (newContextKey !== this._lastContextKey) {
      if (this._pendingRefreshTimer !== null) {
        clearTimeout(this._pendingRefreshTimer);
        this._pendingRefreshTimer = null;
        this._pendingRefreshKey = null;
      }
      this._doRefreshLayout(newContextKey);
      return;
    }

    // Throttle repeated calls with the same context to 150ms — getVisibleSections
    // calls getComputedStyle which is expensive and doesn't need 60fps resolution.
    if (this._pendingRefreshTimer === null) {
      this._pendingRefreshKey = newContextKey;
      this._pendingRefreshTimer = setTimeout(() => {
        this._pendingRefreshTimer = null;
        const key = this._pendingRefreshKey;
        this._pendingRefreshKey = null;
        this._doRefreshLayout(key);
      }, 150);
    }
  }

  _doRefreshLayout(newContextKey) {
    if (!this.container) return;

    const visibleSections = this.getVisibleSections();
    const visibleSectionIds = visibleSections.map(section => section.id).join(',');

    // Skip if context hasn't changed AND visible sections are the same
    if (this._lastContextKey === newContextKey && this._lastVisibleSectionIds === visibleSectionIds) {
      return;
    }

    this._lastContextKey = newContextKey;
    this._lastVisibleSectionIds = visibleSectionIds;
    this.currentContextKey = newContextKey;

    const visibleSectionIdSet = new Set(visibleSections.map(section => section.id));
    const savedHeights = this.loadHeights(this.currentContextKey);

    this.sections.forEach(section => {
      const element = document.getElementById(section.id);
      if (!element) return;

      const isVisible = visibleSectionIdSet.has(section.id);
      element.style.display = isVisible ? 'flex' : 'none';

      if (!isVisible) {
        element.style.height = '';
        element.style.flex = '';
      }
    });

    this.handles.forEach((handle, index) => {
      const topSection = visibleSections[index];
      const bottomSection = visibleSections[index + 1];

      if (topSection && bottomSection) {
        handle.dataset.topSection = topSection.id;
        handle.dataset.bottomSection = bottomSection.id;
        topSection.element.insertAdjacentElement('afterend', handle);
        handle.style.display = '';
      } else {
        delete handle.dataset.topSection;
        delete handle.dataset.bottomSection;
        handle.style.display = 'none';
      }
    });

    visibleSections.forEach((section, index) => {
      const { element } = section;
      const isLastVisibleSection = index === visibleSections.length - 1;

      element.style.flexShrink = '0';
      element.style.flexDirection = 'column';
      element.style.minHeight = `${section.minHeight}px`;

      if (isLastVisibleSection) {
        element.style.flex = '1 1 auto';
        element.style.height = '';
      } else {
        const height = savedHeights[section.id] || this.getAutoHeight(section, visibleSections);
        element.style.flex = '0 0 auto';
        element.style.height = `${height}px`;
      }
    });
  }

  /**
   * Default height for a section with no saved user preference: fit the
   * section's natural content height, clamped between its minHeight and the
   * space left over after reserving minHeights for the other visible sections.
   */
  getAutoHeight(section, visibleSections) {
    const natural = this.measureNaturalHeight(section);
    return Math.min(
      Math.max(natural, section.minHeight || 50),
      this.getMaxAutoHeight(section, visibleSections)
    );
  }

  measureNaturalHeight(section) {
    const element = section.element || document.getElementById(section.id);
    if (!element) return section.defaultHeight;

    const prevHeight = element.style.height;
    const prevFlex = element.style.flex;
    element.style.height = '';
    element.style.flex = '0 0 auto';

    const natural = element.offsetHeight;

    element.style.height = prevHeight;
    element.style.flex = prevFlex;

    return natural > 0 ? natural : section.defaultHeight;
  }

  getMaxAutoHeight(section, visibleSections) {
    const containerHeight = this.container.clientHeight;
    if (!containerHeight) return Infinity;

    let reserved = 0;
    visibleSections.forEach(other => {
      if (other.id === section.id) return;
      reserved += other.minHeight || 50;
    });
    this.handles.forEach(handle => {
      if (handle.style.display !== 'none') {
        reserved += handle.offsetHeight;
      }
    });

    return Math.max(section.minHeight || 50, containerHeight - reserved);
  }

  // Public method to reset to defaults
  resetHeights(contextKey = this.currentContextKey) {
    const allHeights = this.loadAllHeights();
    const sharedHeights = { ...(allHeights.__shared__ || {}) };
    this.sharedSectionIds.forEach(sectionId => {
      delete sharedHeights[sectionId];
    });
    allHeights.__shared__ = sharedHeights;
    delete allHeights[this.getContextStorageKey(contextKey)];
    localStorage.setItem(this.storageKey, JSON.stringify(allHeights));
    this.refreshLayout(contextKey);
  }
}
