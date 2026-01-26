
import './components/AppRoot.js';

// Global error handler for unhandled promise rejections
window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled rejection:', event.reason);
});

console.log('Agent Orcha Client Initialized');
