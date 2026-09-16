/**
 * The 20 approved technical discovery questions.
 *
 * VERBATIM from docs/Cloud-Migration-Assessment.docx (the team-lead-approved
 * questionnaire). Wording is not paraphrased, because these are the approved
 * questions and the user has said they will be finalised in a later round —
 * editing them here would silently fork them.
 *
 * The grouping matches DISCOVERY_QUESTION_GROUPS already shipped on
 * health.aeygis.com (assets/aeygis-enhancements.js:219-265), so staff see the
 * same structure the prospect saw.
 *
 * These are STAFF-FILLED. They are deliberately not on the public form: they are
 * consultant-level questions ("What are the dependencies between applications,
 * servers, databases, and services?") that a clinic office manager cannot answer
 * cold, and the Framework places them in Phase 1 Discover — during or after the
 * call, not before it.
 *
 * Lives in @aeygis/domain (not apps/console) because both the console AND the
 * render-proposal-pdf Lambda need the same 20 questions in the same order —
 * the client-facing "Technical discovery" section renders every one of them,
 * so the question text must be a single source of truth, not duplicated.
 */

export interface DiscoveryQuestion {
  /** Stable key. Answers are stored against these, so NEVER renumber. */
  readonly id: string;
  /** 1-20 for the approved set; 21+ for per-assessment custom additions. */
  readonly number: number;
  readonly question: string;
  /**
   * Present and true ONLY for a per-assessment custom question. Omitted (never
   * `false`) on the approved 20, so `exactOptionalPropertyTypes` keeps the
   * constant below free of noise.
   */
  readonly isCustom?: true;
}

export interface DiscoveryGroup {
  readonly id: string;
  readonly title: string;
  readonly questions: readonly DiscoveryQuestion[];
  /** Present and true ONLY for a per-assessment custom category. */
  readonly isCustom?: true;
}

export const DISCOVERY_GROUPS: readonly DiscoveryGroup[] = [
  {
    id: 'scope',
    title: 'Scope & inventory',
    questions: [
      { id: 'q01', number: 1, question: 'What applications and systems are included in the migration scope?' },
      { id: 'q02', number: 2, question: 'Where are the workloads currently hosted?' },
      { id: 'q03', number: 3, question: 'What is the current server and virtual machine inventory?' },
    ],
  },
  {
    id: 'app-data',
    title: 'Application & data architecture',
    questions: [
      { id: 'q04', number: 4, question: 'What is the current application architecture?' },
      { id: 'q05', number: 5, question: 'What technologies and runtime dependencies does each application use?' },
      { id: 'q06', number: 6, question: 'What databases are currently in use?' },
      { id: 'q07', number: 7, question: 'What storage platforms are being used?' },
      { id: 'q08', number: 8, question: 'What are the dependencies between applications, servers, databases, and services?' },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations & network',
    questions: [
      { id: 'q09', number: 9, question: 'What external systems and third-party services are integrated with the environment?' },
      { id: 'q10', number: 10, question: 'Which integration protocols and data-exchange standards are used?' },
      { id: 'q11', number: 11, question: 'What is the current network architecture?' },
      {
        id: 'q12',
        number: 12,
        question:
          'What connectivity is required between on-premises locations, cloud environments, users, vendors, and external systems?',
      },
    ],
  },
  {
    id: 'identity-security',
    title: 'Identity & security',
    questions: [
      { id: 'q13', number: 13, question: 'How are users, administrators, applications, and services authenticated and authorized?' },
      { id: 'q14', number: 14, question: 'What security controls are currently implemented in the architecture?' },
      {
        id: 'q15',
        number: 15,
        question: 'Which systems contain sensitive healthcare or patient data, and how is that data protected?',
      },
    ],
  },
  {
    id: 'resilience-ops',
    title: 'Resilience & operations',
    questions: [
      { id: 'q16', number: 16, question: 'What availability architecture is currently implemented?' },
      { id: 'q17', number: 17, question: 'What are the backup and disaster-recovery configurations?' },
      { id: 'q18', number: 18, question: 'What monitoring, logging, and alerting platforms are currently used?' },
      { id: 'q19', number: 19, question: 'How are applications and infrastructure deployed and managed?' },
      { id: 'q20', number: 20, question: 'What technical constraints could affect the migration approach?' },
    ],
  },
];

export const ALL_DISCOVERY_QUESTIONS: readonly DiscoveryQuestion[] = DISCOVERY_GROUPS.flatMap(
  (g) => g.questions,
);

/** Answers keyed by question id. Stored as JSON on the Assessment record. */
export type DiscoveryAnswers = Record<string, string>;

export function countAnswered(answers: DiscoveryAnswers): number {
  return ALL_DISCOVERY_QUESTIONS.filter((q) => (answers[q.id] ?? '').trim().length > 0).length;
}

/**
 * Answered/total across whatever question set is actually in force, so the
 * console's counter stays honest once custom questions are added — the
 * standard-only `countAnswered` above would report "20/20" while custom
 * questions sat empty.
 */
export function countAnsweredIn(
  groups: readonly DiscoveryGroup[],
  answers: DiscoveryAnswers,
): { readonly answered: number; readonly total: number } {
  const all = groups.flatMap((g) => g.questions);
  return {
    answered: all.filter((q) => (answers[q.id] ?? '').trim().length > 0).length,
    total: all.length,
  };
}

/**
 * Tolerates a null, a JSON string, or an already-parsed object — the same
 * three shapes `Assessment.discoveryAnswers` can arrive in, whether read by
 * the console (a live GraphQL result) or a Lambda (the same field, but
 * defensive parsing matters more server-side since a malformed value must
 * not fail proposal generation outright).
 *
 * Never throws. A field that isn't a string is dropped rather than coerced,
 * so a future accidental non-string value can't silently render as
 * "[object Object]" in a client-facing document.
 */
export function parseDiscoveryAnswers(raw: unknown): DiscoveryAnswers {
  if (raw === null || raw === undefined) return {};
  const value = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: DiscoveryAnswers = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ─────────────────── per-assessment custom questions ─────────────────── */

/**
 * The approved 20 are the same for every client. Some engagements need more:
 * an extra question inside an existing category, or a whole new category.
 *
 * SCOPE IS PER-ASSESSMENT, deliberately. A custom question added for one
 * clinic exists only on that clinic's assessment — it does not become part of
 * the approved set, does not appear for anyone else, and does not require the
 * approved questionnaire to be reopened. Stored as JSON on
 * `Assessment.customDiscoveryQuestions`, alongside (not inside) the answers.
 *
 * ANSWERS STAY IN ONE MAP. `Assessment.discoveryAnswers` is keyed by question
 * id for both standard and custom questions, which is why the id-collision
 * guards in `parseCustomDiscoverySchema` matter: a custom question allowed to
 * call itself `q07` would silently overwrite a standard question's answer.
 */

export const STANDARD_QUESTION_COUNT = ALL_DISCOVERY_QUESTIONS.length;

const STANDARD_GROUP_IDS: ReadonlySet<string> = new Set(DISCOVERY_GROUPS.map((g) => g.id));
const STANDARD_QUESTION_IDS: ReadonlySet<string> = new Set(
  ALL_DISCOVERY_QUESTIONS.map((q) => q.id),
);

/**
 * Length caps on staff-authored text that reaches a client PDF.
 *
 * The proposal's interior pages are a fixed physical size with no automatic
 * pagination, so unbounded input is a layout failure waiting to happen. The
 * question cap is set near the longest APPROVED question (q12, ~120 chars) with
 * headroom, rather than picked arbitrarily — and the resulting worst case is
 * verified by rendering, not by arithmetic.
 */
export const MAX_CUSTOM_QUESTION_LENGTH = 200;
export const MAX_CUSTOM_CATEGORY_TITLE_LENGTH = 80;

export interface CustomDiscoveryCategory {
  readonly id: string;
  readonly title: string;
}

export interface CustomDiscoveryQuestion {
  readonly id: string;
  /** A standard group id ('scope', 'app-data', …) or a custom category id. */
  readonly categoryId: string;
  readonly question: string;
}

export interface CustomDiscoverySchema {
  readonly categories: readonly CustomDiscoveryCategory[];
  readonly questions: readonly CustomDiscoveryQuestion[];
}

export const EMPTY_CUSTOM_DISCOVERY: CustomDiscoverySchema = Object.freeze({
  categories: Object.freeze([]) as readonly CustomDiscoveryCategory[],
  questions: Object.freeze([]) as readonly CustomDiscoveryQuestion[],
});

/** Prefixes make a custom id recognizable on sight in stored JSON. */
export const CUSTOM_CATEGORY_ID_PREFIX = 'cc-';
export const CUSTOM_QUESTION_ID_PREFIX = 'cq-';

/**
 * Parses `Assessment.customDiscoveryQuestions`. Never throws.
 *
 * Rejects rather than repairs: an entry missing an id or text, a duplicate id,
 * or an id that would shadow a standard question or group is DROPPED. Silently
 * accepting a colliding id would corrupt a standard answer, which is a far
 * worse outcome than losing one malformed custom question.
 */
export function parseCustomDiscoverySchema(raw: unknown): CustomDiscoverySchema {
  if (raw === null || raw === undefined) return EMPTY_CUSTOM_DISCOVERY;
  const value = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return EMPTY_CUSTOM_DISCOVERY;
  }
  const record = value as Record<string, unknown>;

  const readString = (entry: Record<string, unknown>, key: string): string =>
    typeof entry[key] === 'string' ? (entry[key] as string).trim() : '';

  const categories: CustomDiscoveryCategory[] = [];
  const seenCategoryIds = new Set<string>();
  if (Array.isArray(record['categories'])) {
    for (const raw of record['categories']) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const id = readString(entry, 'id');
      const title = readString(entry, 'title');
      // A custom category may not shadow a standard group: questions are
      // matched to groups by id, so a duplicate id would merge the two.
      if (id === '' || title === '' || seenCategoryIds.has(id) || STANDARD_GROUP_IDS.has(id)) {
        continue;
      }
      seenCategoryIds.add(id);
      categories.push({ id, title: title.slice(0, MAX_CUSTOM_CATEGORY_TITLE_LENGTH) });
    }
  }

  const questions: CustomDiscoveryQuestion[] = [];
  const seenQuestionIds = new Set<string>();
  if (Array.isArray(record['questions'])) {
    for (const raw of record['questions']) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const id = readString(entry, 'id');
      const categoryId = readString(entry, 'categoryId');
      const question = readString(entry, 'question');
      // The collision guard that protects the shared answers map.
      if (
        id === '' ||
        categoryId === '' ||
        question === '' ||
        seenQuestionIds.has(id) ||
        STANDARD_QUESTION_IDS.has(id)
      ) {
        continue;
      }
      seenQuestionIds.add(id);
      questions.push({
        id,
        categoryId,
        question: question.slice(0, MAX_CUSTOM_QUESTION_LENGTH),
      });
    }
  }

  return { categories, questions };
}

/**
 * The question set actually in force for one assessment: the approved 20 plus
 * that assessment's custom additions, in render order.
 *
 * ORDERING AND NUMBERING ARE STABLE AND DETERMINISTIC. Standard questions keep
 * their approved numbers 1-20 no matter what is added around them — inserting a
 * custom question into "Scope & inventory" must NOT renumber the approved set,
 * because those numbers are how the source document refers to them. Custom
 * questions are numbered from 21 upward, in the order they render: extras
 * inside standard categories first (in category order), then custom categories.
 *
 * A custom question whose `categoryId` matches neither a standard group nor a
 * listed custom category is dropped — it has nowhere to render. The console
 * removes a category's questions when the category is deleted, so this is a
 * defensive floor, not the normal path.
 *
 * Both the console and the PDF renderer call this, so what staff fill in and
 * what the client reads cannot drift apart.
 */
export function effectiveDiscoveryGroups(
  custom: CustomDiscoverySchema,
): readonly DiscoveryGroup[] {
  let nextNumber = STANDARD_QUESTION_COUNT;

  const customQuestionsFor = (categoryId: string): DiscoveryQuestion[] =>
    custom.questions
      .filter((q) => q.categoryId === categoryId)
      .map((q) => {
        nextNumber += 1;
        return { id: q.id, number: nextNumber, question: q.question, isCustom: true as const };
      });

  // Evaluated before the custom categories below, which is what makes the
  // numbering match the render order.
  const standard: DiscoveryGroup[] = DISCOVERY_GROUPS.map((group) => {
    const extra = customQuestionsFor(group.id);
    return extra.length === 0 ? group : { ...group, questions: [...group.questions, ...extra] };
  });

  const added: DiscoveryGroup[] = custom.categories.map((category) => ({
    id: category.id,
    title: category.title,
    questions: customQuestionsFor(category.id),
    isCustom: true as const,
  }));

  return [...standard, ...added];
}

/** Convenience: parse the stored value and merge in one step. */
export function discoveryGroupsForAssessment(rawCustom: unknown): readonly DiscoveryGroup[] {
  return effectiveDiscoveryGroups(parseCustomDiscoverySchema(rawCustom));
}
