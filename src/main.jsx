import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// GitHub Pages production build can run before any analytics polyfill is present,
// so guard the Metric global to avoid a ReferenceError that prevents the UI from mounting.
if (typeof window !== 'undefined' && typeof window.Metric === 'undefined') {
  window.Metric = class Metric {};
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
