import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Website } from './website';
import { Demo } from './demo';
import './style.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(
  <StrictMode>
    <Website Demo={Demo} />
  </StrictMode>,
);
