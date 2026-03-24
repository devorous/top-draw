import { mount } from 'svelte';
import Landing from './Landing.svelte';

const app = mount(Landing, { target: document.getElementById('app') });

export default app;
