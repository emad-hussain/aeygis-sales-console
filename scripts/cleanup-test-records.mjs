/**
 * Deletes verification artifacts from the Assessment table.
 *
 * The verify-* scripts each write a real record every run (that is the point —
 * they exercise the live write path). Without this, the console would fill with
 * fake clinics and a real lead could be missed among them.
 *
 * Only deletes records whose email is on the known test-address list, so it can
 * never remove a genuine submission. A record that looks like a test but has an
 * unrecognised address is reported and LEFT ALONE — refusing to guess is the
 * whole point.
 *
 * Run:  npm run cleanup:tests
 */
import { readFileSync } from 'node:fs';
import {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

/** Addresses used by the verification scripts. Nothing else is ever deleted. */
const TEST_EMAILS = new Set([
  // verification-script artifacts
  // verify-lead-notification.mjs. .example is RFC 2606 reserved like .invalid,
  // but is NOT what isTestSubmission matches on — which is the point: it lets
  // that check exercise the real send path with a provably fake address.
  'notification-check@aeygis-test.example',
  'verify@aeygis-test.invalid',
  // verify:phone — four rows, one per phone format that used to be fatal.
  'phone-check@aeygis-test.invalid',
  'browser-signing@aeygis-test.invalid',
  // The @example.ca forms these replaced on 2026-08-25. Kept so records
  // written before that change are still cleaned up.
  'verify@example.ca',
  'browser-signing@example.ca',
  'bot@example.com',
  'noconsent@example.ca',
  // seed:demo artifacts (@aeygis-test.invalid is a reserved TLD — no mail
  // can ever be delivered to these, which is why they are safe to use)
  'riverside@aeygis-test.invalid',
  'bayview@aeygis-test.invalid',
  'lakeshore@aeygis-test.invalid',
  'northern@aeygis-test.invalid',
]);

/** Non-email test artifacts, matched on referenceId. */
const TEST_REFERENCE_IDS = new Set(['PROBE']);

/**
 * Records created by `npm run verify:email`, matched on a marker in the CLINIC
 * NAME rather than on the email address.
 *
 * That walk has to use a REAL, SES-verified recipient — the whole point is to
 * send an actual message — and that address is a person's own inbox. Adding it
 * to TEST_EMAILS above would mean this script deletes every assessment carrying
 * it, including a genuine lead that happened to use it. Matching a marker the
 * test itself writes into the clinic name has no such failure mode: nothing but
 * that script ever produces it.
 */
const TEST_CLINIC_MARKER = '[e2e-email]';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const region = outputs.data.aws_region;
const apiId = outputs.data.url.match(/https:\/\/([a-z0-9]+)\./)?.[1];

const client = new DynamoDBClient({ region });

// Resolve the table name from the deployed API rather than hardcoding it, so
// this cannot silently point at a stale table after a redeploy.
const { ListTablesCommand } = await import('@aws-sdk/client-dynamodb');
const { TableNames = [] } = await client.send(new ListTablesCommand({}));
const tableName = TableNames.find((n) => n.startsWith('Assessment-'));

if (!tableName) {
  console.error(`No Assessment-* table found in ${region}. Nothing to do.`);
  process.exit(1);
}
console.log(`Region: ${region}\nTable:  ${tableName}\n`);

const { Items = [] } = await client.send(new ScanCommand({ TableName: tableName }));
const val = (item, key) => (item[key] ? Object.values(item[key])[0] : undefined);

let deleted = 0;
const kept = [];

for (const item of Items) {
  const id = val(item, 'id');
  const email = val(item, 'email');
  const ref = val(item, 'referenceId');
  const clinic = val(item, 'clinicName');

  const isTest =
    (email && TEST_EMAILS.has(email)) ||
    (ref && TEST_REFERENCE_IDS.has(ref)) ||
    (typeof clinic === 'string' && clinic.includes(TEST_CLINIC_MARKER));

  if (isTest) {
    await client.send(
      new DeleteItemCommand({ TableName: tableName, Key: { id: { S: String(id) } } }),
    );
    console.log(`  deleted  ${ref ?? '(no ref)'}  ${email ?? '(no email)'}`);
    deleted += 1;
  } else {
    kept.push(`${ref ?? '(no ref)'}  ${email ?? '(no email)'}`);
  }
}

console.log(`\nDeleted ${deleted} test record(s).`);

if (kept.length > 0) {
  console.log(`\nKept ${kept.length} record(s) not on the test list — review these by hand:`);
  for (const k of kept) console.log(`  ${k}`);
}
