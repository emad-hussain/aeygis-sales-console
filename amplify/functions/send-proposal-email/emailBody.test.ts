import { describe, expect, it } from 'vitest';
import {
  attachmentFileName,
  buildProposalEmail,
  escapeHtml,
  fileNameSlug,
  type ProposalEmailInput,
} from './emailBody.js';

const BASE: ProposalEmailInput = {
  clinicName: 'Bayview Family Health',
  contactName: 'Dana Whitfield',
  versionKey: 'v0003',
  proposalReference: 'PROP-8f21c4-v0003',
  validUntil: 'September 22, 2026',
  previouslySent: false,
};

const build = (overrides: Partial<ProposalEmailInput> = {}) =>
  buildProposalEmail({ ...BASE, ...overrides });

describe('subject', () => {
  it('names the clinic so it is findable in an inbox', () => {
    expect(build().subject).toBe(
      'Your Aeygis cloud migration proposal — Bayview Family Health',
    );
  });

  it('drops the dash cleanly when there is no clinic name', () => {
    const subject = build({ clinicName: null }).subject;
    expect(subject).toBe('Your Aeygis cloud migration proposal');
    expect(subject).not.toContain('—');
    expect(subject.trim()).toBe(subject);
  });

  it('says "updated" only when something has actually been sent before', () => {
    expect(build({ previouslySent: false }).subject).not.toMatch(/updated/i);
    expect(build({ previouslySent: true }).subject).toMatch(/updated/i);
  });
});

describe('greeting', () => {
  it('uses the contact name as given', () => {
    expect(build().text).toContain('Hello Dana Whitfield,');
  });

  it('falls back to a plain greeting rather than an empty one', () => {
    for (const contactName of [null, undefined, '', '   ']) {
      const { text } = build({ contactName });
      expect(text.startsWith('Hello,')).toBe(true);
      expect(text).not.toContain('Hello ,');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
    }
  });
});

describe('body content', () => {
  it('states the validity date exactly as given, never recomputed', () => {
    const { text, html } = build({ validUntil: 'March 3, 2027' });
    expect(text).toContain('held until March 3, 2027.');
    expect(html).toContain('held until March 3, 2027.');
  });

  it('carries the reference so it can be quoted back', () => {
    expect(build().text).toContain('PROP-8f21c4-v0003');
    expect(build().html).toContain('PROP-8f21c4-v0003');
  });

  it('changes the opening line for a resend', () => {
    expect(build({ previouslySent: false }).text).toMatch(/thank you for completing/i);
    expect(build({ previouslySent: true }).text).toMatch(/replaces the one we sent/i);
  });

  it('sends a plain-text part as well as HTML', () => {
    const { text, html } = build();
    expect(text.trim()).not.toBe('');
    expect(html.trim()).not.toBe('');
    expect(text).not.toContain('<');
  });

  it('tells the reader the proposal is attached', () => {
    expect(build().text).toMatch(/attached/i);
  });
});

/**
 * ==========================================================================
 * THE LEAK TEST
 * ==========================================================================
 *
 * Aeygis_Cloud_Rate_Card.pdf is confidential: delivery cost per hour, margin
 * reasoning, competitor pricing and the discount floor must never reach a
 * client. The dependency rule stops this function IMPORTING that data; this
 * test stops anyone typing a figure straight into the copy.
 *
 * The rule enforced here is deliberately blunter than "no confidential data":
 * the email states NO money at all. A blunt rule is checkable; a nuanced one
 * gets argued with.
 */
describe('confidentiality', () => {
  const FORBIDDEN = [
    /\$/,
    /\bCAD\b/i,
    /\bprice\b/i,
    /\bcost\b/i,
    /\bmargin\b/i,
    /\bdiscount\b/i,
    /\bper hour\b/i,
    /\bcompetitor\b/i,
    /\bsetup fee\b/i,
    /\bmonthly total\b/i,
    /\binternal\b/i,
    // Any bare number with a thousands separator or decimal money shape.
    /\d{1,3},\d{3}/,
    /\d+\.\d{2}\b/,
  ];

  /**
   * Scans what the CLIENT READS, not the raw markup.
   *
   * Written this way because the first version scanned the HTML source and
   * tripped on `margin:0 0 16px` in a style attribute — a CSS property, not a
   * profit margin. Testing the source would have forced the copy rule to bend
   * around the stylesheet, which is exactly backwards: the rule is about words
   * a client can read.
   */
  const visibleText = (html: string) => html.replace(/<[^>]*>/g, ' ');

  it('states no figures and no commercial wording in anything the client reads', () => {
    // Every branch, since the copy differs between them.
    const variants = [
      build(),
      build({ previouslySent: true }),
      build({ clinicName: null, contactName: null }),
    ];

    for (const email of variants) {
      for (const pattern of FORBIDDEN) {
        expect(email.text, `text matched ${pattern}`).not.toMatch(pattern);
        expect(visibleText(email.html), `html text matched ${pattern}`).not.toMatch(pattern);
        expect(email.subject, `subject matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('says "pricing" only in the sense of where to find it, never a figure', () => {
    // The one commercial word that IS allowed, because the sentence points at
    // the attached document rather than stating anything.
    expect(build().text).toContain('The pricing in the proposal is held until');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break or inject markup', () => {
    expect(escapeHtml('Smith & Sons')).toBe('Smith &amp; Sons');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
  });

  it('escapes the ampersand first, so escapes are not double-escaped', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('HTML safety with real-world names', () => {
  /**
   * The contact name is free text typed into a PUBLIC form by a stranger and it
   * IS rendered into the HTML body, so it must not be able to alter the markup.
   *
   * An earlier version of this test used the CLINIC name and passed vacuously —
   * the clinic name never reaches the HTML body at all (see the test below), so
   * nothing was being escaped and nothing was being proven.
   */
  it('neutralises a contact name containing markup', () => {
    const { html } = build({ contactName: '<img src=x onerror=alert(1)>' });

    // The property that matters is that the injected text cannot BECOME a tag,
    // not that the word "onerror" is absent. Once the angle brackets are
    // escaped it is inert prose, and asserting on the word would fail a
    // perfectly safe output — an earlier version of this test did exactly that.
    const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(['div', 'p']));

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes an ampersand in a contact name', () => {
    expect(build({ contactName: 'Smith & Sons' }).html).toContain('Smith &amp; Sons');
  });

  /**
   * Documents the actual design rather than assuming it: the SUBJECT names the
   * clinic, the BODY greets the person. Repeating the clinic name in the body
   * would be redundant. If that ever changes, this test fails and whoever
   * changes it has to escape the value on the way in.
   */
  it('does not put the clinic name in the body at all', () => {
    const { html, text } = build({ clinicName: 'Bayview Family Health' });
    expect(html).not.toContain('Bayview');
    expect(text).not.toContain('Bayview');
  });

  it('leaves the plain-text part unescaped, since it is not markup', () => {
    expect(build({ contactName: 'Smith & Sons' }).text).toContain('Smith & Sons');
  });
});

/**
 * The subject becomes a mail HEADER, and it carries the clinic name — free text
 * from a public form. A newline inside a header value is the classic injection
 * shape: everything after it can be read as a new header.
 */
describe('subject is safe to use as a header', () => {
  it('flattens newlines and carriage returns out of a clinic name', () => {
    const { subject } = build({
      clinicName: 'Real Clinic\r\nBcc: attacker@example.com',
    });
    expect(subject).not.toContain('\n');
    expect(subject).not.toContain('\r');
    expect(subject).toContain('Real Clinic');
    // The injected text survives as ordinary words, which is fine — it is the
    // line break that made it dangerous, not the characters.
    expect(subject).toContain('Bcc: attacker@example.com');
  });

  it('strips other control characters too', () => {
    const { subject } = build({ clinicName: `Tab\tClinic\u0000Null` });
    // eslint-disable-next-line no-control-regex
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(subject).toContain('Tab Clinic Null');
  });

  it('does not leave doubled or trailing spaces behind', () => {
    const { subject } = build({ clinicName: 'Spaced\n\n\nOut   Clinic  ' });
    expect(subject).not.toMatch(/\s{2,}/);
    expect(subject.trim()).toBe(subject);
  });
});

describe('fileNameSlug', () => {
  it('keeps letters and digits, collapsing everything else to single hyphens', () => {
    expect(fileNameSlug('Bayview Family Health')).toBe('Bayview-Family-Health');
    expect(fileNameSlug('St. Mary/Joseph  Clinic')).toBe('St-Mary-Joseph-Clinic');
  });

  it('keeps the letter when stripping an accent', () => {
    expect(fileNameSlug('Clinique Santé')).toBe('Clinique-Sante');
    expect(fileNameSlug('Zürich Médical')).toBe('Zurich-Medical');
  });

  it('never starts or ends with a hyphen', () => {
    for (const raw of ['  ...Clinic...  ', '!!!Clinic!!!', '---Clinic---']) {
      const slug = fileNameSlug(raw);
      expect(slug.startsWith('-')).toBe(false);
      expect(slug.endsWith('-')).toBe(false);
    }
  });

  it('caps the length and does not leave a trailing hyphen from the cut', () => {
    const slug = fileNameSlug('A'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(60);

    // A cut landing on a separator would otherwise leave "...Health-".
    const awkward = fileNameSlug(`${'Ab '.repeat(40)}`);
    expect(awkward.endsWith('-')).toBe(false);
  });

  it('returns empty for anything absent', () => {
    for (const raw of [null, undefined, '', '   ', '???']) {
      expect(fileNameSlug(raw)).toBe('');
    }
  });
});

describe('attachmentFileName', () => {
  it('names the file after the clinic and version', () => {
    expect(attachmentFileName('Bayview Family Health', 'v0003')).toBe(
      'Aeygis-Cloud-Proposal-Bayview-Family-Health-v0003.pdf',
    );
  });

  it('stays sensible when the clinic name is missing', () => {
    expect(attachmentFileName(null, 'v0003')).toBe('Aeygis-Cloud-Proposal-v0003.pdf');
    expect(attachmentFileName('   ', 'v0001')).toBe('Aeygis-Cloud-Proposal-v0001.pdf');
  });

  it('never produces a double hyphen or a leading hyphen from an empty part', () => {
    for (const clinic of [null, '', '???', 'Real Clinic']) {
      const name = attachmentFileName(clinic, 'v0007');
      expect(name).not.toContain('--');
      expect(name.startsWith('-')).toBe(false);
      expect(name.endsWith('.pdf')).toBe(true);
    }
  });

  /** SES caps FileName at 255 characters. A long clinic name must not breach it. */
  it('stays well inside the SES filename limit', () => {
    const name = attachmentFileName('Some Extremely Long Clinic Name '.repeat(20), 'v0003');
    expect(name.length).toBeLessThanOrEqual(255);
  });

  it('is what the built email reports', () => {
    expect(build().attachmentFileName).toBe(
      'Aeygis-Cloud-Proposal-Bayview-Family-Health-v0003.pdf',
    );
  });
});
