/** @fileoverview Dev-only entry for the dropdown variant gallery (/dropdown-preview/). */

import { mount } from 'svelte';
import '../css/main.scss';
import DropdownPreview from './DropdownPreview.svelte';

mount(DropdownPreview, { target: document.getElementById('app') });
