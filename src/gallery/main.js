import { mount } from 'svelte';
import { inject } from '@vercel/analytics';
import Gallery from './Gallery.svelte';
import { installAppConfirmGlobal } from '../ui/ConfirmDialog.js';

inject();

installAppConfirmGlobal();

const app = mount(Gallery, { target: document.getElementById('app') });

export default app;
