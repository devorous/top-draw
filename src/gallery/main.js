import { mount } from 'svelte';
import Gallery from './Gallery.svelte';
import { installAppConfirmGlobal } from '../ui/ConfirmDialog.js';

installAppConfirmGlobal();

const app = mount(Gallery, { target: document.getElementById('app') });

export default app;
