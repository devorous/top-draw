import { mount } from 'svelte';
import Gallery from './Gallery.svelte';

const app = mount(Gallery, { target: document.getElementById('app') });

export default app;
