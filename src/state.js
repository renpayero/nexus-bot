import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { logger } from './logger.js';

const DEFAULT_STATE = { isPaused: false };

export const loadState = () => {
  try {
    if (!fs.existsSync(paths.state)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(paths.state, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    logger.warn({ err: err.message }, 'state.json ilegible — uso default');
    return { ...DEFAULT_STATE };
  }
};

export const saveState = (state) => {
  const tmp = `${paths.state}.tmp`;
  fs.mkdirSync(path.dirname(paths.state), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, paths.state);
};

export const setPaused = (isPaused, meta = {}) => {
  if (isPaused) {
    const next = {
      isPaused: true,
      pausedAt: new Date().toISOString(),
      pausedBy: meta.pausedBy ?? null,
    };
    if (meta.pausedUntil) next.pausedUntil = meta.pausedUntil;
    saveState(next);
    return next;
  }
  saveState({ isPaused: false });
  return { isPaused: false };
};

export const isPaused = () => {
  const state = loadState();
  if (!state.isPaused) return false;
  if (state.pausedUntil) {
    const until = Date.parse(state.pausedUntil);
    if (Number.isFinite(until) && Date.now() >= until) {
      logger.info({ pausedUntil: state.pausedUntil }, 'Pausa expiró — auto-reanudación');
      saveState({ isPaused: false });
      return false;
    }
  }
  return true;
};

export const getState = () => loadState();
