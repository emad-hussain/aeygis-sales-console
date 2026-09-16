import { describe, expect, it } from 'vitest';
import {
  ALL_DISCOVERY_QUESTIONS,
  DISCOVERY_GROUPS,
  MAX_CUSTOM_CATEGORY_TITLE_LENGTH,
  MAX_CUSTOM_QUESTION_LENGTH,
  STANDARD_QUESTION_COUNT,
  countAnsweredIn,
  discoveryGroupsForAssessment,
  effectiveDiscoveryGroups,
  parseCustomDiscoverySchema,
} from './discoveryQuestions.js';

/**
 * Per-assessment custom discovery questions.
 *
 * The single most important behaviour here is the ID COLLISION GUARD. Standard
 * and custom answers share one map on `Assessment.discoveryAnswers`, so a
 * custom question permitted to call itself `q07` would silently overwrite an
 * approved question's answer. Several tests below exist only to pin that shut.
 */

const flat = (groups: readonly { questions: readonly unknown[] }[]) =>
  groups.flatMap((g) => g.questions);

describe('parseCustomDiscoverySchema', () => {
  it('treats null, undefined and malformed JSON as "no custom questions"', () => {
    for (const raw of [null, undefined, '{not json', '[]', '"a string"', 42]) {
      expect(parseCustomDiscoverySchema(raw)).toEqual({ categories: [], questions: [] });
    }
  });

  it('accepts both a JSON string and an already-parsed object', () => {
    const value = {
      categories: [{ id: 'cc-1', title: 'Imaging' }],
      questions: [{ id: 'cq-1', categoryId: 'cc-1', question: 'Which modalities?' }],
    };
    expect(parseCustomDiscoverySchema(JSON.stringify(value))).toEqual(value);
    expect(parseCustomDiscoverySchema(value)).toEqual(value);
  });

  it('REFUSES a custom question id that would shadow an approved question', () => {
    // The collision that would corrupt a standard answer.
    const parsed = parseCustomDiscoverySchema({
      categories: [],
      questions: [
        { id: 'q07', categoryId: 'scope', question: 'Hijacks q07 answer' },
        { id: 'cq-ok', categoryId: 'scope', question: 'Legitimate' },
      ],
    });
    expect(parsed.questions.map((q) => q.id)).toEqual(['cq-ok']);
  });

  it('refuses EVERY approved question id, not just the one sampled above', () => {
    const parsed = parseCustomDiscoverySchema({
      categories: [],
      questions: ALL_DISCOVERY_QUESTIONS.map((q) => ({
        id: q.id,
        categoryId: 'scope',
        question: 'shadow attempt',
      })),
    });
    expect(parsed.questions).toEqual([]);
  });

  it('REFUSES a custom category id that would shadow a standard group', () => {
    const parsed = parseCustomDiscoverySchema({
      categories: DISCOVERY_GROUPS.map((g) => ({ id: g.id, title: 'shadow attempt' })),
      questions: [],
    });
    expect(parsed.categories).toEqual([]);
  });

  it('drops entries missing an id, a title, or question text', () => {
    const parsed = parseCustomDiscoverySchema({
      categories: [{ id: 'cc-1' }, { title: 'No id' }, { id: '  ', title: 'blank id' }],
      questions: [
        { id: 'cq-1', categoryId: 'scope' },
        { id: 'cq-2', question: 'no category' },
        { categoryId: 'scope', question: 'no id' },
      ],
    });
    expect(parsed).toEqual({ categories: [], questions: [] });
  });

  it('drops duplicate ids, keeping the first', () => {
    const parsed = parseCustomDiscoverySchema({
      categories: [
        { id: 'cc-1', title: 'First' },
        { id: 'cc-1', title: 'Second' },
      ],
      questions: [
        { id: 'cq-1', categoryId: 'cc-1', question: 'First' },
        { id: 'cq-1', categoryId: 'cc-1', question: 'Second' },
      ],
    });
    expect(parsed.categories).toEqual([{ id: 'cc-1', title: 'First' }]);
    expect(parsed.questions.map((q) => q.question)).toEqual(['First']);
  });

  it('truncates over-long question text and category titles rather than rejecting them', () => {
    const parsed = parseCustomDiscoverySchema({
      categories: [{ id: 'cc-1', title: 'T'.repeat(MAX_CUSTOM_CATEGORY_TITLE_LENGTH + 50) }],
      questions: [
        { id: 'cq-1', categoryId: 'cc-1', question: 'Q'.repeat(MAX_CUSTOM_QUESTION_LENGTH + 50) },
      ],
    });
    expect(parsed.categories[0]?.title).toHaveLength(MAX_CUSTOM_CATEGORY_TITLE_LENGTH);
    expect(parsed.questions[0]?.question).toHaveLength(MAX_CUSTOM_QUESTION_LENGTH);
  });

  it('trims surrounding whitespace', () => {
    const parsed = parseCustomDiscoverySchema({
      categories: [{ id: '  cc-1  ', title: '  Imaging  ' }],
      questions: [{ id: ' cq-1 ', categoryId: ' cc-1 ', question: '  Which?  ' }],
    });
    expect(parsed.categories[0]).toEqual({ id: 'cc-1', title: 'Imaging' });
    expect(parsed.questions[0]).toEqual({ id: 'cq-1', categoryId: 'cc-1', question: 'Which?' });
  });
});

describe('effectiveDiscoveryGroups', () => {
  it('with no custom questions, is exactly the approved set, numbered 1-20', () => {
    const groups = effectiveDiscoveryGroups({ categories: [], questions: [] });
    expect(groups).toEqual(DISCOVERY_GROUPS);
    expect(flat(groups)).toHaveLength(STANDARD_QUESTION_COUNT);
  });

  it('appends a custom question to an EXISTING category without renumbering the approved 20', () => {
    // The invariant that matters: the source document refers to these by
    // number, so inserting into the FIRST group must not shift the rest.
    const groups = effectiveDiscoveryGroups({
      categories: [],
      questions: [{ id: 'cq-1', categoryId: 'scope', question: 'Extra scope question' }],
    });

    const standardNumbers = flat(groups)
      .filter((q) => !(q as { isCustom?: true }).isCustom)
      .map((q) => (q as { number: number }).number);
    expect(standardNumbers).toEqual(ALL_DISCOVERY_QUESTIONS.map((q) => q.number));

    const scope = groups.find((g) => g.id === 'scope');
    expect(scope?.questions).toHaveLength(4);
    expect(scope?.questions[3]).toMatchObject({ id: 'cq-1', number: 21, isCustom: true });
  });

  it('adds a custom category AFTER every standard group', () => {
    const groups = effectiveDiscoveryGroups({
      categories: [{ id: 'cc-1', title: 'Imaging & PACS' }],
      questions: [{ id: 'cq-1', categoryId: 'cc-1', question: 'Which modalities?' }],
    });
    expect(groups).toHaveLength(DISCOVERY_GROUPS.length + 1);
    const last = groups[groups.length - 1];
    expect(last).toMatchObject({ id: 'cc-1', title: 'Imaging & PACS', isCustom: true });
    expect(last?.questions[0]).toMatchObject({ number: 21, isCustom: true });
  });

  it('numbers custom questions in render order: in-category extras first, then new categories', () => {
    const groups = effectiveDiscoveryGroups({
      categories: [{ id: 'cc-1', title: 'Imaging' }],
      questions: [
        // Deliberately listed out of render order.
        { id: 'cq-newcat', categoryId: 'cc-1', question: 'In the new category' },
        { id: 'cq-late', categoryId: 'resilience-ops', question: 'In the LAST standard group' },
        { id: 'cq-early', categoryId: 'scope', question: 'In the FIRST standard group' },
      ],
    });
    const byId = new Map(
      flat(groups).map((q) => [(q as { id: string }).id, (q as { number: number }).number]),
    );
    expect(byId.get('cq-early')).toBe(21);
    expect(byId.get('cq-late')).toBe(22);
    expect(byId.get('cq-newcat')).toBe(23);
  });

  it('is deterministic — the same input always yields the same numbering', () => {
    const custom = {
      categories: [{ id: 'cc-1', title: 'Imaging' }],
      questions: [
        { id: 'cq-a', categoryId: 'scope', question: 'A' },
        { id: 'cq-b', categoryId: 'cc-1', question: 'B' },
      ],
    };
    expect(effectiveDiscoveryGroups(custom)).toEqual(effectiveDiscoveryGroups(custom));
  });

  it('drops a question whose category does not exist — it has nowhere to render', () => {
    const groups = effectiveDiscoveryGroups({
      categories: [],
      questions: [{ id: 'cq-orphan', categoryId: 'cc-deleted', question: 'Orphaned' }],
    });
    expect(flat(groups)).toHaveLength(STANDARD_QUESTION_COUNT);
  });

  it('marks only custom entries with isCustom, never the approved ones', () => {
    const groups = effectiveDiscoveryGroups({
      categories: [{ id: 'cc-1', title: 'Imaging' }],
      questions: [{ id: 'cq-1', categoryId: 'cc-1', question: 'Which?' }],
    });
    for (const group of DISCOVERY_GROUPS) {
      const found = groups.find((g) => g.id === group.id);
      expect(found?.isCustom).toBeUndefined();
      for (const q of found?.questions ?? []) expect(q.isCustom).toBeUndefined();
    }
  });
});

describe('discoveryGroupsForAssessment', () => {
  it('parses and merges in one step, tolerating a raw JSON string', () => {
    const groups = discoveryGroupsForAssessment(
      JSON.stringify({
        categories: [{ id: 'cc-1', title: 'Imaging' }],
        questions: [{ id: 'cq-1', categoryId: 'cc-1', question: 'Which?' }],
      }),
    );
    expect(flat(groups)).toHaveLength(STANDARD_QUESTION_COUNT + 1);
  });

  it('falls back to the approved set when the stored value is unusable', () => {
    expect(discoveryGroupsForAssessment('{corrupt')).toEqual(DISCOVERY_GROUPS);
  });
});

describe('countAnsweredIn', () => {
  it('counts against the effective set, so custom questions affect the total', () => {
    const groups = discoveryGroupsForAssessment({
      categories: [],
      questions: [{ id: 'cq-1', categoryId: 'scope', question: 'Extra' }],
    });
    expect(countAnsweredIn(groups, {})).toEqual({ answered: 0, total: 21 });
    expect(countAnsweredIn(groups, { q01: 'yes', 'cq-1': 'also yes' })).toEqual({
      answered: 2,
      total: 21,
    });
  });

  it('treats a whitespace-only answer as unanswered', () => {
    const groups = discoveryGroupsForAssessment(null);
    expect(countAnsweredIn(groups, { q01: '   ' }).answered).toBe(0);
  });
});
