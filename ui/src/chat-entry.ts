import './app.css';
import StandaloneChatPage from './pages/StandaloneChatPage.svelte';
import { mount } from 'svelte';

const app = mount(StandaloneChatPage, { target: document.getElementById('app')! });

export default app;
