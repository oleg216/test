import { describe, it, expect } from 'vitest';
import { SessionStateMachine, isValidTransition } from '../../src/worker/session.js';
import { SessionState } from '../../src/shared/types.js';

describe('isValidTransition', () => {
  it('allows CREATED -> INITIALIZING', () => {
    expect(isValidTransition(SessionState.CREATED, SessionState.INITIALIZING)).toBe(true);
  });

  it('allows full happy path', () => {
    const path = [
      SessionState.CREATED, SessionState.INITIALIZING, SessionState.RTB_REQUESTING,
      SessionState.VAST_RESOLVING, SessionState.AD_LOADING, SessionState.AD_PLAYING,
      SessionState.CONTENT_PLAYING, SessionState.STOPPING, SessionState.STOPPED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('rejects invalid transition', () => {
    expect(isValidTransition(SessionState.CREATED, SessionState.AD_PLAYING)).toBe(false);
  });

  it('allows error transitions from any active state', () => {
    expect(isValidTransition(SessionState.RTB_REQUESTING, SessionState.ERROR_NETWORK)).toBe(true);
    expect(isValidTransition(SessionState.VAST_RESOLVING, SessionState.ERROR_VAST)).toBe(true);
  });
});

describe('SessionStateMachine', () => {
  it('starts in CREATED state', () => {
    const sm = new SessionStateMachine('sess-1');
    expect(sm.state).toBe(SessionState.CREATED);
  });

  it('transitions through states', () => {
    const sm = new SessionStateMachine('sess-1');
    sm.transition(SessionState.INITIALIZING);
    expect(sm.state).toBe(SessionState.INITIALIZING);
  });

  it('throws on invalid transition', () => {
    const sm = new SessionStateMachine('sess-1');
    expect(() => sm.transition(SessionState.AD_PLAYING)).toThrow();
  });
});
