export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// What an agent's model requests actually carry, as its latest step sent them.
// `effort: null` means that request carried no effort (the model takes none).
export type Sent = { model: string; effort: Effort | number | null };

const SHORT: Record<Effort, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' };

// `model · effort` for the router button. Sent values win once a request has
// gone out; before that, the assignment. No effort, no suffix.
export function agentBadge(assigned: { model: string; effort?: Effort } | undefined, sent: Sent | undefined): string | undefined {
  if (!assigned && !sent) return undefined;
  const model = sent?.model ?? assigned!.model;
  const effort = sent ? sent.effort : assigned!.effort;
  const suffix = effort === null || effort === undefined ? '' : ` · ${typeof effort === 'number' ? effort : SHORT[effort]}`;
  return `${model}${suffix}`;
}

export function sameSent(left: Sent | undefined, right: Sent): boolean {
  return left !== undefined && left.model === right.model && left.effort === right.effort;
}
