import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABEL,
  deliveryReachedClient,
  deliveryStatusLabel,
} from './delivery.js';

describe('delivery status vocabulary', () => {
  it('labels every status in the vocabulary', () => {
    for (const status of DELIVERY_STATUSES) {
      expect(DELIVERY_STATUS_LABEL[status]).toBeTruthy();
    }
    expect(Object.keys(DELIVERY_STATUS_LABEL)).toHaveLength(DELIVERY_STATUSES.length);
  });

  it('gives each status a distinct label', () => {
    const labels = Object.values(DELIVERY_STATUS_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('renders known statuses', () => {
    expect(deliveryStatusLabel('sent')).toBe('Sent');
    expect(deliveryStatusLabel('blocked')).toBe('Blocked');
    expect(deliveryStatusLabel('failed')).toBe('Failed');
  });

  it('renders an absent status as Unknown rather than blank', () => {
    expect(deliveryStatusLabel(null)).toBe('Unknown');
    expect(deliveryStatusLabel(undefined)).toBe('Unknown');
    expect(deliveryStatusLabel('')).toBe('Unknown');
  });

  it('renders an unrecognised status readably instead of blanking it', () => {
    expect(deliveryStatusLabel('bounced_hard')).toBe('bounced hard');
    expect(deliveryStatusLabel('weird')).toBe('weird');
  });

  it('never returns an empty label for a non-empty input', () => {
    for (const raw of ['sent', 'nonsense', 'a_b_c', 'X']) {
      expect(deliveryStatusLabel(raw).trim()).not.toBe('');
    }
  });

  /**
   * The distinction that justifies three statuses instead of a boolean:
   * "we deliberately refused" must never read as "the client has it".
   */
  it('treats only `sent` as having reached the client', () => {
    expect(deliveryReachedClient('sent')).toBe(true);
    expect(deliveryReachedClient('blocked')).toBe(false);
    expect(deliveryReachedClient('failed')).toBe(false);
    expect(deliveryReachedClient(null)).toBe(false);
    expect(deliveryReachedClient(undefined)).toBe(false);
    expect(deliveryReachedClient('SENT')).toBe(false);
  });
});
