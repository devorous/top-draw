import { mount } from 'svelte';
import { inject } from '@vercel/analytics';
import Landing from './Landing.svelte';

inject();

const app = mount(Landing, { target: document.getElementById('app') });

export default app;
