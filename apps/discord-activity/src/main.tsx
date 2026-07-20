import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@factory-floor/operator-ui-react/styles.css';
import './styles.css';
import { DiscordActivityApp } from './app.js';
import { discordActivityConfig } from './config.js';

const root = document.getElementById('root');
if (!root) throw new Error('discord_activity_root_required');

createRoot(root).render(
  <StrictMode>
    <DiscordActivityApp config={discordActivityConfig(import.meta.env)} />
  </StrictMode>,
);
