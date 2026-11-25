/**
 * Custom pronunciation dictionary engine.
 *
 * Applies enabled `PronunciationRule[]` transformations to synthesis text
 * non-destructively while keeping the user's raw script intact.
 */

import type { PronunciationRule } from '../types';

export interface RuleValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Escape all special regular-expression metacharacters in a literal string.
 */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate a `PronunciationRule` before saving or compiling.
 */
export function validatePronunciationRule(
  rule: Pick<PronunciationRule, 'pattern' | 'replacement' | 'isRegex' | 'caseSensitive'>
): RuleValidationResult {
  if (typeof rule.pattern !== 'string' || rule.pattern.trim().length === 0) {
    return { valid: false, error: 'Pattern must be a non-empty string.' };
  }

  if (typeof rule.replacement !== 'string') {
    return { valid: false, error: 'Replacement must be a string.' };
  }

  if (rule.isRegex) {
    try {
      const flags = rule.caseSensitive ? 'g' : 'gi';
      const compiled = new RegExp(rule.pattern, flags);
      // Guard against zero-length patterns that match at every character boundary.
      if (compiled.test('')) {
        return {
          valid: false,
          error: 'Regular expression must not match an empty string.',
        };
      }
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : 'Invalid regular expression.',
      };
    }
  }

  return { valid: true };
}

/**
 * Compile a `PronunciationRule` into a global `RegExp`.
 * Returns `null` if disabled or invalid.
 */
export function compilePronunciationRule(rule: PronunciationRule): RegExp | null {
  if (!rule.enabled) return null;
  const validation = validatePronunciationRule(rule);
  if (!validation.valid) return null;

  const flags = rule.caseSensitive ? 'g' : 'gi';
  if (rule.isRegex) {
    return new RegExp(rule.pattern, flags);
  }

  const escaped = escapeRegExp(rule.pattern);
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, flags);
}

/**
 * Apply all enabled `PronunciationRule` entries in sequence without mutating inputs.
 * Note: literal rules use a function replacer so `$` sequences in `replacement`
 * (like `$1` or `$&`) are treated literally and never interpreted as regex backreferences.
 */
export function applyPronunciationRules(
  text: string,
  rules: readonly PronunciationRule[]
): string {
  if (!text || rules.length === 0) return text;

  let result = text;
  for (const rule of rules) {
    const regex = compilePronunciationRule(rule);
    if (!regex) continue;

    if (rule.isRegex) {
      result = result.replace(regex, rule.replacement);
    } else {
      result = result.replace(regex, () => rule.replacement);
    }
  }

  return result;
}

/**
 * Create a normalized `PronunciationRule` record with a generated ID if omitted.
 */
export function createPronunciationRule(
  input: Omit<PronunciationRule, 'id'> & { id?: string }
): PronunciationRule {
  const validation = validatePronunciationRule(input);
  if (!validation.valid) {
    throw new Error(validation.error ?? 'Invalid pronunciation rule.');
  }

  const id =
    input.id ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  return {
    id,
    pattern: input.pattern,
    replacement: input.replacement,
    isRegex: input.isRegex,
    caseSensitive: input.caseSensitive,
    enabled: input.enabled,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

/**
 * Insert or update a rule in an immutable `PronunciationRule[]` array.
 */
export function upsertPronunciationRule(
  rules: readonly PronunciationRule[],
  rule: PronunciationRule
): PronunciationRule[] {
  const index = rules.findIndex((item) => item.id === rule.id);
  if (index === -1) {
    return [...rules, rule];
  }
  return rules.map((item, i) => (i === index ? rule : item));
}

/**
 * Remove a rule by ID from an immutable `PronunciationRule[]` array.
 */
export function removePronunciationRule(
  rules: readonly PronunciationRule[],
  id: string
): PronunciationRule[] {
  return rules.filter((rule) => rule.id !== id);
}

/**
 * Toggle `enabled` on a rule by ID.
 */
export function togglePronunciationRule(
  rules: readonly PronunciationRule[],
  id: string
): PronunciationRule[] {
  return rules.map((rule) =>
    rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
  );
}
