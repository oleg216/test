import { SessionState, ERROR_STATES } from '../shared/types.js';
import { MAX_RETRIES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
const logger = createLogger('session');
const VALID_TRANSITIONS = {
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
export function isValidTransition(from, to) {
    if (ERROR_STATES.includes(to) && ACTIVE_STATES.includes(from)) {
        return true;
    }
    if (ERROR_STATES.includes(from) && to === SessionState.STOPPING) {
        return true;
    }
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
export class SessionStateMachine {
    id;
    _state = SessionState.CREATED;
    config;
    createdAt;
    updatedAt;
    retryCount = 0;
    error;
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.createdAt = Date.now();
        this.updatedAt = Date.now();
    }
    get state() {
        return this._state;
    }
    transition(to) {
        if (!isValidTransition(this._state, to)) {
            throw new Error(`Invalid transition: ${this._state} -> ${to} (session ${this.id})`);
        }
        logger.info({ sessionId: this.id, from: this._state, to }, 'State transition');
        this._state = to;
        this.updatedAt = Date.now();
    }
    setError(state, message) {
        this.error = message;
        this.transition(state);
    }
    canRetry() {
        return this.retryCount < MAX_RETRIES;
    }
    incrementRetry() {
        this.retryCount++;
    }
    toInfo() {
        return {
            id: this.id,
            state: this._state,
            config: this.config,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            retryCount: this.retryCount,
            error: this.error,
        };
    }
}
//# sourceMappingURL=session.js.map