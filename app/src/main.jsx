import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Brand tokens come from data/business.json at build time (see vite.config.js),
// the same file the public site is generated from. Setting them as CSS custom
// properties means styles.css never hardcodes a hex value.
const brand = __BRAND__;
const root = document.documentElement;
const vars = {
  '--navy': brand.navy,
  '--navy-deep': brand.navyDeep,
  '--navy-ink': brand.navyInk,
  '--coral': brand.coral,
  '--coral-deep': brand.coralDeep,
  '--ink': brand.ink,
  '--body': brand.body,
  '--muted': brand.muted,
  '--line': brand.line,
  '--wash': brand.wash,
  '--gold': brand.gold,
};
for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
