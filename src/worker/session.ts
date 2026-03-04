import { SessionState, ERROR_STATES } from '../shared/types.js';
import type { SessionConfig, SessionInfo } from '../shared/types.js';
import { MAX_RETRIES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('session');

const VALID_TRANSITIONS: Record<string, SessionState[]> = {
  [SessionState.CREATED]: [SessionState.INITIALIZING],
  [SessionState.INITIALIZING]: [SessionState.RTB_REQUESTING],
  [SessionState.RTB_REQUESTING]: [SessionState.VAST_RESOLVING],
  [SessionState.VAST_RESOLVING]: [SessionState.AD_LOADING],
  [SessionState.AD_LOADING]: [SessionState.AD_PLAYING],
  [SessionState.AD_PLAYING]: [SessionState.CONTENT_PLAYING, SessionState.STOPPING],
  [SessionState.CONTENT_PLAYING]: [SessionState.STOPPING],
  [SessionState.STOPPING]: [SessionState.STOPPED],
};

const ACTIVE_STATES = [
  SessionState.INITIALIZING, SessionState.RTB_REQUESTING, SessionState.VAST_RESOLVING,
  SessionState.AD_LOADING, SessionState.AD_PLAYING, SessionState.CONTENT_PLAYING,
];

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  if (ERROR_STATES.includes(to as typeof ERROR_STATES[number]) && ACTIVE_STATES.includes(from)) {
    return true;
  }
  if (ERROR_STATES.includes(from as typeof ERROR_STATES[number]) && to === SessionState.STOPPING) {
    return true;
  }
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export class SessionStateMachine {
  readonly id: string;
  private _state: SessionState = SessionState.CREATED;
  readonly config?: SessionConfig;
  readonly createdAt: number;
  private updatedAt: number;
  retryCount = 0;
  error?: string;

  constructor(id: string, config?: SessionConfig) {
    this.id = id;
    this.config = config;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  get state(): SessionState {
    return this._state;
  }

  transition(to: SessionState): void {
    if (!isValidTransition(this._state, to)) {
      throw new Error(`Invalid transition: ${this._state} -> ${to} (session ${this.id})`);
    }
    logger.info({ sessionId: this.id, from: this._state, to }, 'State transition');
    this._state = to;
    this.updatedAt = Date.now();
  }

  setError(state: SessionState, message: string): void {
    this.error = message;
    this.transition(state);
  }

  canRetry(): boolean {
    return this.retryCount < MAX_RETRIES;
  }

  incrementRetry(): void {
    this.retryCount++;
  }

  toInfo(): Omit<SessionInfo, 'workerId' | 'events'> {
    return {
      id: this.id,
      state: this._state,
      config: this.config!,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      retryCount: this.retryCount,
      error: this.error,
    };
  }
}
