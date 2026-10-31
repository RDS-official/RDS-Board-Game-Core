import {
  Action,
  ActorId,
  DecisionPolicy,
  DecisionSubmission,
  DecisionWindow,
  GameState,
  PlayerId
} from './types';

export interface OpenDecisionSpec {
  id?: string;
  kind: DecisionWindow['kind'];
  title: string;
  description?: string;
  participants: ActorId[];
  secret: boolean;
  policy: DecisionPolicy;
  payload?: DecisionWindow['payload'];
  /** Absolute logical-clock deadlines per participant. */
  participantDeadlines?: Record<ActorId, number>;
}

export interface SubmitResult {
  state: GameState;
  accepted: boolean;
  error?: string;
  window?: DecisionWindow;
  ready: boolean;
}

export function topDecision(state: GameState): DecisionWindow | undefined {
  for (let i = state.pendingDecisions.length - 1; i >= 0; i--) {
    if (state.pendingDecisions[i].status === 'OPEN') return state.pendingDecisions[i];
  }
  return undefined;
}

export function openDecision(state: GameState, spec: OpenDecisionSpec, id: string): { state: GameState; window: DecisionWindow } {
  if (spec.participants.length === 0) throw new Error('Decision window needs at least one participant');
  if (new Set(spec.participants).size !== spec.participants.length) throw new Error('Duplicate decision participants');

  const window: DecisionWindow = {
    id: spec.id ?? id,
    kind: spec.kind,
    title: spec.title,
    description: spec.description,
    participants: [...spec.participants],
    submissions: {},
    secret: spec.secret,
    policy: spec.policy,
    status: 'OPEN',
    payload: spec.payload,
    participantDeadlines: spec.participantDeadlines
  };

  return {
    state: { ...state, pendingDecisions: [...state.pendingDecisions, window] },
    window
  };
}

export function submitDecision(
  state: GameState,
  windowId: string,
  playerId: PlayerId,
  submission: DecisionSubmission
): SubmitResult {
  const index = state.pendingDecisions.findIndex(w => w.id === windowId);
  if (index < 0) return { state, accepted: false, error: `Unknown decision window: ${windowId}`, ready: false };

  const window = state.pendingDecisions[index];
  if (window.status !== 'OPEN') {
    return { state, accepted: false, error: `Decision window ${windowId} is ${window.status}`, window, ready: false };
  }
  if (!window.participants.includes(playerId)) {
    return { state, accepted: false, error: `${playerId} is not a participant of ${windowId}`, window, ready: false };
  }
  if (window.submissions[playerId] !== undefined) {
    return { state, accepted: false, error: `${playerId} already committed to ${windowId}`, window, ready: false };
  }

  const nextWindow: DecisionWindow = {
    ...window,
    submissions: { ...window.submissions, [playerId]: submission }
  };

  const { ready } = evaluateWindow(nextWindow);
  if (ready) nextWindow.status = 'READY';

  const pendingDecisions = [...state.pendingDecisions];
  pendingDecisions[index] = nextWindow;

  return {
    state: { ...state, pendingDecisions },
    accepted: true,
    window: nextWindow,
    ready
  };
}

export function evaluateWindow(window: DecisionWindow): { ready: boolean; shortCircuited: boolean } {
  const submitted = (pid: PlayerId) => window.submissions[pid] !== undefined;
  const allCommitted = window.participants.every(submitted);

  if (window.policy.type === 'FIRST_ACCEPT') {
    const accepted = window.participants.some(pid => {
      const submission = window.submissions[pid];
      return (
        submission !== undefined &&
        submission !== 'PASS' &&
        submission !== 'COMMITTED' &&
        window.policy.type === 'FIRST_ACCEPT' &&
        window.policy.acceptTypes.includes(submission.type)
      );
    });
    if (accepted) return { ready: true, shortCircuited: true };
    return { ready: allCommitted, shortCircuited: false };
  }

  if (window.policy.type === 'PRIORITY') {
    let highest = -Infinity;
    for (const pid of window.participants) {
      const submission = window.submissions[pid];
      if (!submission || submission === 'PASS' || submission === 'COMMITTED') continue;
      const priority = window.policy.priorities[submission.type] ?? 0;
      highest = Math.max(highest, priority);
    }
    if (highest >= window.policy.shortCircuitAt) {
      return { ready: true, shortCircuited: true };
    }
  }

  return { ready: allCommitted, shortCircuited: false };
}

/**
 * Ordered list of submissions for reveal/execution.
 * PRIORITY windows execute highest-priority actions first; ties keep seat order.
 */
export function orderedSubmissions(window: DecisionWindow): { playerId: PlayerId; submission: DecisionSubmission }[] {
  const entries = window.participants
    .map(pid => ({ playerId: pid, submission: window.submissions[pid] }))
    .filter((entry): entry is { playerId: PlayerId; submission: DecisionSubmission } => entry.submission !== undefined);

  if (window.policy.type === 'FIRST_ACCEPT') {
    const acceptTypes = window.policy.acceptTypes;
    const acceptedIndex = entries.findIndex(
      entry =>
        entry.submission !== 'PASS' &&
        entry.submission !== 'COMMITTED' &&
        acceptTypes.includes(entry.submission.type)
    );
    return acceptedIndex >= 0 ? entries.slice(0, acceptedIndex + 1) : entries;
  }

  if (window.policy.type === 'PRIORITY') {
    const priorities = window.policy.priorities;
    return entries.sort((a, b) => {
      const pa = a.submission === 'PASS' || a.submission === 'COMMITTED' ? -1 : priorities[a.submission.type] ?? 0;
      const pb = b.submission === 'PASS' || b.submission === 'COMMITTED' ? -1 : priorities[b.submission.type] ?? 0;
      if (pb !== pa) return pb - pa;
      return window.participants.indexOf(a.playerId) - window.participants.indexOf(b.playerId);
    });
  }

  return entries;
}

export function resolveDecision(state: GameState, windowId: string): { state: GameState; window?: DecisionWindow } {
  const index = state.pendingDecisions.findIndex(w => w.id === windowId);
  if (index < 0) return { state };

  const window = state.pendingDecisions[index];
  if (window.status === 'RESOLVED' || window.status === 'CANCELLED') return { state, window };

  const reveal: Record<PlayerId, DecisionSubmission> = {};
  for (const entry of orderedSubmissions(window)) reveal[entry.playerId] = entry.submission;

  const resolved: DecisionWindow = { ...window, status: 'RESOLVED', reveal };
  delete resolved.followUpContinuation;
  const pendingDecisions = [...state.pendingDecisions];

  // Keep the most recent completed windows for auditability but bound growth.
  pendingDecisions[index] = resolved;
  const trimmed = pendingDecisions
    .filter(w => w.status === 'OPEN')
    .concat(pendingDecisions.filter(w => w.status !== 'OPEN').slice(-4));

  return { state: { ...state, pendingDecisions: trimmed }, window: resolved };
}

/** Projection of a decision window for one viewer: secret submissions stay hidden. */
export function projectDecision(window: DecisionWindow, viewerId: PlayerId | 'GOD'): DecisionWindow {
  // The continuation queue is kernel scheduling data; clients never need it.
  const visible: DecisionWindow = { ...window };
  delete visible.followUpContinuation;

  if (!window.secret || window.status !== 'OPEN' || viewerId === 'GOD') return visible;

  const submissions: DecisionWindow['submissions'] = {};
  for (const pid of window.participants) {
    const submission = window.submissions[pid];
    submissions[pid] = submission === undefined ? undefined : 'COMMITTED';
  }

  const { reveal: _reveal, ...rest } = visible;
  return { ...rest, submissions };
}

export function actionsInWindow(window: DecisionWindow, playerId: PlayerId): Action[] {
  const submission = window.submissions[playerId];
  return submission && submission !== 'PASS' && submission !== 'COMMITTED' ? [submission] : [];
}
