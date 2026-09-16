import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_STATUSES,
  ASSESSMENT_STATUS_LABEL,
  assessmentStatusLabel,
  isOneOf,
} from './assessment.js';

describe('assessment status vocabulary', () => {
  it('labels every status in the vocabulary', () => {
    // Guards the console's status picker: it renders one option per entry in
    // ASSESSMENT_STATUSES, so a value added without a label would show up
    // blank rather than fail.
    for (const status of ASSESSMENT_STATUSES) {
      expect(ASSESSMENT_STATUS_LABEL[status]).toBeTruthy();
    }
    expect(Object.keys(ASSESSMENT_STATUS_LABEL)).toHaveLength(ASSESSMENT_STATUSES.length);
  });

  it('gives each status a distinct label', () => {
    const labels = Object.values(ASSESSMENT_STATUS_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('renders known statuses', () => {
    expect(assessmentStatusLabel('new')).toBe('New');
    expect(assessmentStatusLabel('needs_confirmation')).toBe('Needs confirmation');
    expect(assessmentStatusLabel('in_review')).toBe('In review');
    expect(assessmentStatusLabel('proposed')).toBe('Proposed');
    expect(assessmentStatusLabel('closed')).toBe('Closed');
  });

  it('renders an absent status as Unknown rather than blank', () => {
    expect(assessmentStatusLabel(null)).toBe('Unknown');
    expect(assessmentStatusLabel(undefined)).toBe('Unknown');
    expect(assessmentStatusLabel('')).toBe('Unknown');
  });

  /**
   * `status` is a plain string on the model, not a GraphQL enum, so a value
   * outside the vocabulary is possible. It must stay READABLE — the queue
   * lists every record rather than querying the status index precisely so an
   * unexpected status cannot make a lead invisible, and that only helps if
   * the label renders too.
   */
  it('renders an unrecognised status readably instead of blanking it', () => {
    expect(assessmentStatusLabel('on_hold')).toBe('on hold');
    expect(assessmentStatusLabel('waiting_on_client_legal')).toBe('waiting on client legal');
    expect(assessmentStatusLabel('weird')).toBe('weird');
  });

  it('never returns an empty label for a non-empty input', () => {
    for (const raw of ['new', 'nonsense', 'a_b_c', 'X']) {
      expect(assessmentStatusLabel(raw).trim()).not.toBe('');
    }
  });

  it('recognises exactly the vocabulary', () => {
    expect(isOneOf(ASSESSMENT_STATUSES, 'in_review')).toBe(true);
    expect(isOneOf(ASSESSMENT_STATUSES, 'on_hold')).toBe(false);
    expect(isOneOf(ASSESSMENT_STATUSES, 42)).toBe(false);
  });
});
