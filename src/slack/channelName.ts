/**
 * Channel-name → property-input inference.
 *
 * The team uses channel names like `#546-old-haw-creek-rd` for deals. We can
 * extract the implied street address from the name and use that as the input
 * to the resolver, so a user can type just `/henry` (no argument) and we know
 * which property to research.
 *
 * Heuristics:
 *   - Replace hyphens with spaces
 *   - Trim common suffixes/prefixes like "deal", "closing", "offer"
 *   - If the first token looks like a number, treat it as a house number
 */

const STOP_PREFIXES = [
  'deal', 'offer', 'closing', 'closed', 'research', 'dd', 'due-diligence',
  'inspection', 'contract', 'under-contract', 'active', 'pending',
];
const STOP_SUFFIXES = STOP_PREFIXES;

export interface ChannelGuess {
  /** Best-guess property input (address) derived from the channel name */
  guess: string | undefined;
  /** Whether the channel name looks like it starts with a street address */
  confident: boolean;
  /** The cleaned tokens we derived */
  tokens: string[];
}

export function inferPropertyFromChannelName(name: string): ChannelGuess {
  if (!name) return { guess: undefined, confident: false, tokens: [] };

  // Slack channel names are always lowercase; strip the leading # if passed.
  let cleaned = name.replace(/^#/, '').toLowerCase().trim();
  // Split on hyphens and underscores
  let tokens = cleaned.split(/[-_]+/).filter(Boolean);

  // Drop leading/trailing marker tokens ("deal-546-..." → "546-...")
  while (tokens.length && STOP_PREFIXES.includes(tokens[0])) tokens.shift();
  while (tokens.length && STOP_SUFFIXES.includes(tokens[tokens.length - 1])) tokens.pop();

  // If the first token is a house number, we're confident
  const confident = tokens.length >= 2 && /^\d{1,6}$/.test(tokens[0]);

  const guess = tokens.length > 0 ? tokens.join(' ') : undefined;
  return { guess, confident, tokens };
}
