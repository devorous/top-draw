/**
 * @fileoverview Mounts the shared Svelte Dropdown in place of a native <select>
 * for the vanilla-JS parts of the app (tool options).
 *
 * The returned mount point keeps a `value` property and emits `change` events,
 * so existing code that did `select.value = x` and `addEventListener('change')`
 * keeps working unchanged. Runes module (`.svelte.js`) so the props object can
 * be `$state` and update the component without remounting it.
 */

import { mount, unmount } from 'svelte';
import Dropdown from './svelte/Dropdown.svelte';

/**
 * Replaces a <select> element with the shared Dropdown.
 * @param {HTMLSelectElement|null} selectEl - The select to replace.
 * @param {Object} [config]
 * @param {Array<{value: string, label: string}>} [config.options] - Options;
 *   defaults to the <select>'s own <option> children.
 * @param {string} [config.variant] - Trigger variant.
 * @param {string} [config.size] - 'sm' | 'md'.
 * @param {boolean} [config.uppercase]
 * @param {boolean} [config.fullWidth]
 * @returns {HTMLElement|null} The mount point, with `value` / `setOptions()`.
 */
export function replaceSelectWithDropdown(selectEl, config = {}) {
  if (!selectEl) return null;
  if (selectEl._dropdownReady) return selectEl;

  const optionsFromDom = Array.from(selectEl.options ?? []).map(o => ({
    value: o.value,
    label: o.textContent.trim()
  }));

  const props = $state({
    options: config.options ?? optionsFromDom,
    value: config.value ?? selectEl.value ?? null,
    variant: config.variant ?? 'flat',
    size: config.size ?? 'sm',
    uppercase: config.uppercase ?? false,
    fullWidth: config.fullWidth ?? true,
    disabled: false,
    ariaLabel: selectEl.getAttribute('aria-label') || config.ariaLabel || '',
    onchange: (next) => {
      props.value = next;
      mountPoint.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  const mountPoint = document.createElement('div');
  mountPoint.id = selectEl.id;
  mountPoint.className = 'dd-mount';
  selectEl.replaceWith(mountPoint);
  mountPoint._dropdownReady = true;

  const component = mount(Dropdown, { target: mountPoint, props });

  // `value` mirrors the native select API used by the existing call sites.
  Object.defineProperty(mountPoint, 'value', {
    configurable: true,
    get: () => props.value,
    set: (next) => { props.value = next; }
  });

  Object.defineProperty(mountPoint, 'disabled', {
    configurable: true,
    get: () => props.disabled,
    set: (next) => { props.disabled = !!next; }
  });

  /**
   * Swaps the option list, keeping the current value if it still exists.
   * @param {Array<{value: string, label: string}>} nextOptions
   */
  mountPoint.setOptions = (nextOptions) => {
    props.options = nextOptions;
    if (!nextOptions.some(o => o.value === props.value)) {
      props.value = nextOptions[0]?.value ?? null;
    }
  };

  mountPoint.destroyDropdown = () => unmount(component);

  return mountPoint;
}
