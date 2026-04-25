import { mount } from 'svelte';
import MessengerPage from './MessengerPage.svelte';

const app = mount(MessengerPage, { target: document.getElementById('app') });

export default app;
