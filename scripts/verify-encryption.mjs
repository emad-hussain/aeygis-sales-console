/**
 * Asserts every DynamoDB table and the S3 bucket actually use the project CMK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS — a real bug, found the hard way, twice over
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Amplify's tables are a `Custom::AmplifyDynamoDBTable` resource, not a native
 * AWS::DynamoDB::Table. Its provider **ignores `kmsMasterKeyId` when it CREATES
 * a table**: the table comes up with KMS SSE enabled but protected by the
 * AWS-managed `alias/aws/dynamodb` key. The setting is only honoured on UPDATE.
 *
 * The result is maximally deceptive:
 *   - the CloudFormation template correctly requests the CMK
 *   - synth logs "customer-managed KMS key applied"
 *   - `describe-table` reports `SSEType: KMS` and `Status: ENABLED`
 *   - and the key is the wrong one
 *
 * Every signal short of comparing the key ARN says success. `ProposalVersion`
 * landed on the AWS-managed key exactly this way, while `Assessment` was correct
 * only because it pre-existed and got updated.
 *
 * That means EVERY NEW MODEL is affected on first deploy — including `Approval`
 * and `AuditEvent` in Phase 4. Run this after any deploy that adds a model, and
 * remediate with:
 *
 *   aws dynamodb update-table --table-name <T> --region ca-central-1 \
 *     --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=<cmk-arn>"
 *
 * That is convergence toward the template, not drift away from it.
 *
 * Run:  npm run verify:encryption
 */
import { readFileSync } from 'node:fs';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { KMSClient, DescribeKeyCommand } from '@aws-sdk/client-kms';

const CMK_ALIAS = 'alias/aeygis-sales-platform-data';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const region = outputs.data.aws_region;

/**
 * Model names come from the generated introspection, and tables are named
 * `<Model>-<apiId>-NONE`.
 *
 * NOT derived from the AppSync URL: its subdomain (p562sq56...) is a DIFFERENT
 * value from the API id (fuufxnavz...). Matching on the URL found zero tables
 * and reported a false failure.
 */
const MODEL_NAMES = Object.keys(outputs.data.model_introspection?.models ?? {});

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });
const kms = new KMSClient({ region });

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); failures += 1; };

console.log(`Region: ${region}\n`);

// Resolve the CMK's real ARN from its alias.
const { KeyMetadata } = await kms.send(new DescribeKeyCommand({ KeyId: CMK_ALIAS }));
const cmkArn = KeyMetadata?.Arn;
if (!cmkArn || KeyMetadata?.KeyManager !== 'CUSTOMER') {
  fail(`${CMK_ALIAS} is not a customer-managed key`);
  process.exit(1);
}
pass(`project CMK resolved: ${cmkArn.split('/').pop()} (CUSTOMER managed)`);

// ---------- DynamoDB ----------
console.log('\nDynamoDB tables');
const { TableNames = [] } = await ddb.send(new ListTablesCommand({}));
// Only this project's tables — the account holds unrelated ones.
const ours = TableNames.filter((n) => MODEL_NAMES.some((m) => n.startsWith(`${m}-`)));

if (MODEL_NAMES.length === 0) fail('no models found in amplify_outputs.json');
if (ours.length !== MODEL_NAMES.length) {
  fail(`expected ${MODEL_NAMES.length} table(s) for [${MODEL_NAMES.join(', ')}], found ${ours.length}`);
} else {
  pass(`found all ${ours.length} model table(s)`);
}

for (const name of ours) {
  const { Table } = await ddb.send(new DescribeTableCommand({ TableName: name }));
  const sse = Table?.SSEDescription;
  const model = name.split('-')[0];

  if (sse?.KMSMasterKeyArn === cmkArn) {
    pass(`${model}: CMK`);
  } else if (sse?.Status === 'UPDATING') {
    fail(`${model}: still UPDATING (key ${sse.KMSMasterKeyArn?.split('/').pop()}) — re-run shortly`);
  } else if (!sse) {
    fail(`${model}: NO SSE description at all — AWS-owned key, not KMS`);
  } else {
    fail(
      `${model}: wrong key ${sse.KMSMasterKeyArn?.split('/').pop()} ` +
        `(reports SSEType=${sse.SSEType}, Status=${sse.Status} — which LOOKS correct). ` +
        'This is the Amplify create-path bug; remediate with update-table.',
    );
  }

  const { ContinuousBackupsDescription } = await ddb.send(
    new DescribeContinuousBackupsCommand({ TableName: name }),
  );
  const pitr = ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
  pitr === 'ENABLED' ? pass(`${model}: PITR enabled`) : fail(`${model}: PITR is ${pitr}`);
}

// ---------- S3 ----------
console.log('\nS3 proposals bucket');
const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
const bucket = Buckets.map((b) => b.Name).find((n) => n?.includes('aeygisproposals'));

if (!bucket) {
  fail('proposals bucket not found');
} else {
  const enc = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
  const rule = enc.ServerSideEncryptionConfiguration?.Rules?.[0];
  const keyId = rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;

  keyId === cmkArn ? pass('bucket: CMK') : fail(`bucket: wrong key ${keyId}`);
  rule?.BucketKeyEnabled === true
    ? pass('bucket: BucketKeyEnabled (cuts per-call KMS cost)')
    : fail('bucket: BucketKeyEnabled is off — every object write bills a KMS call');

  const ver = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  ver.Status === 'Enabled'
    ? pass('bucket: versioning enabled')
    : fail(`bucket: versioning is ${ver.Status ?? 'not set'} — a regenerated proposal would destroy its predecessor`);
}

console.log(failures === 0 ? '\nEncryption posture verified.\n' : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
