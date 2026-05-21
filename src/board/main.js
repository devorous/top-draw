import { mount } from 'svelte';
import Board from './Board.svelte';

const app = mount(Board, { target: document.getElementById('app') });

export default app;
