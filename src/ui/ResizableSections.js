/**
 * ResizableSections - Makes sections in the tool options panel resizable
 *
 * Adds drag handles between sections to allow height adjustment.
 * Heights are persisted to localStorage.
 */

export class ResizableSections {
  constructor(containerId, sections) {
    this.container = document.getElementById(containerId);
    this.sections = sections; // Array of { id, minHeight, defaultHeight }
    this.handles = new Map();
    this.activeResize = null;
    this.storageKey = 'toolOptions_sectionHeights';

    this.init();
  }

  init() {
    if (!this.container) return;

    // Load saved heights
    const savedHeights = this.loadHeights();

    // Setup each section
    this.sections.forEach((section, index) => {
      const element = document.getElementById(section.id);
      if (!element) return;

      // Set initial height
      const height = savedHeights[section.id] || section.defaultHeight;
      element.style.height = `${height}px`;
      element.style.flexShrink = '0';
      element.style.display = 'flex';
      element.style.flexDirection = 'column';

      // Add resize handle after each section except the last
      if (index < this.sections.length - 1) {
        const handle = this.createHandle(section.id, this.sections[index + 1].id);
        element.insertAdjacentElement('afterend', handle);
        this.handles.set(section.id, handle);
      }
    });

    // Make the last section flexible to fill remaining space
    const lastSection = document.getElementById(this.sections[this.sections.length - 1].id);
    if (lastSection) {
      lastSection.style.flex = '1';
      lastSection.style.minHeight = `${this.sections[this.sections.length - 1].minHeight}px`;
    }
  }

  createHandle(topSectionId, bottomSectionId) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.topSection = topSectionId;
    handle.dataset.bottomSection = bottomSectionId;

    // Add visual indicator
    handle.innerHTML = '<div class="resize-handle-line"></div>';

    // Mouse events
    handle.addEventListener('mousedown', (e) => this.startResize(e, topSectionId, bottomSectionId));

    // Touch events for mobile
    handle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.startResize(e.touches[0], topSectionId, bottomSectionId);
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

      // Only set explicit height for non-last sections
      const isLastSection = bottomSectionId === this.sections[this.sections.length - 1].id;
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

  loadHeights() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      console.warn('Failed to load section heights:', e);
      return {};
    }
  }

  saveHeights() {
    const heights = {};
    this.sections.forEach(section => {
      const element = document.getElementById(section.id);
      if (element && element.style.height) {
        heights[section.id] = parseInt(element.style.height, 10);
      }
    });

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(heights));
    } catch (e) {
      console.warn('Failed to save section heights:', e);
    }
  }

  // Public method to reset to defaults
  resetHeights() {
    localStorage.removeItem(this.storageKey);
    this.sections.forEach(section => {
      const element = document.getElementById(section.id);
      if (element) {
        element.style.height = `${section.defaultHeight}px`;
      }
    });
  }
}
