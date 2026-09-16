import { defineBackend } from '@aws-amplify/backend';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
// SSEType comes from the Amplify GraphQL construct, NOT aws-cdk-lib/aws-dynamodb —
// Amplify's tables are a custom resource with their own wrapper types.
import { SSEType } from '@aws-amplify/graphql-api-construct';
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Distribution, PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Topic } from 'aws-cdk-lib/aws-sns';
import {
  ConfigurationSet,
  ConfigurationSetEventDestination,
  EmailSendingEvent,
  EventDestination,
} from 'aws-cdk-lib/aws-ses';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { storage } from './storage/resource.js';
import {
  submitAssessment,
  NOTIFY_CONFIGURATION_SET,
  NOTIFY_FROM_ADDRESS,
} from './functions/submit-assessment/resource.js';
import { priceProposal } from './functions/price-proposal/resource.js';
import { decideProposal } from './functions/decide-proposal/resource.js';
import { deleteProposalVersion } from './functions/delete-proposal-version/resource.js';
import { renderProposalPdf } from './functions/render-proposal-pdf/resource.js';
import {
  sendProposalEmail,
  SES_CONFIGURATION_SET,
  SES_FROM_ADDRESS,
} from './functions/send-proposal-email/resource.js';

/**
 * ============================================================================
 * DATA RESIDENCY GUARD — do not remove
 * ============================================================================
 *
 * Amplify Gen 2 has NO region configuration field. Not on `defineBackend`, not
 * on `defineData`. Region is resolved entirely from the AWS credential chain:
 *
 *   AWS_REGION -> AWS_DEFAULT_REGION -> profile's `region` -> instance metadata
 *
 * This project must deploy to ca-central-1. Canadian data residency is the core
 * promise in Aeygis_Cloud_Overview.pdf and is mandated by the Migration
 * Framework. A silent deploy to us-east-1 would put Ontario clinic data in
 * Virginia while the marketing says otherwise — a failure that would not
 * announce itself.
 *
 * IMPORTANT — this guard is best-effort, NOT a control. If none of these env
 * vars is set and the region comes from ~/.aws/config, `resolved` is undefined
 * and the guard passes. The only enforceable control is an SCP or an
 * `aws:RequestedRegion` deny condition on the deploy role. Add one before this
 * handles real client data. Tracked in docs/PROJECT-STATUS.md.
 * ============================================================================
 */
const REQUIRED_REGION = 'ca-central-1';

const resolvedRegion =
  process.env['AWS_REGION'] ??
  process.env['AWS_DEFAULT_REGION'] ??
  process.env['CDK_DEFAULT_REGION'];

if (resolvedRegion !== undefined && resolvedRegion !== REQUIRED_REGION) {
  throw new Error(
    `Data-residency guard: resolved region "${resolvedRegion}" is not "${REQUIRED_REGION}". ` +
      `Aeygis assessment data must stay in Canada. ` +
      `Use the npm scripts (e.g. \`npm run sandbox\`), which set ` +
      `AWS_REGION=${REQUIRED_REGION} via cross-env.`,
  );
}

if (resolvedRegion === undefined) {
  console.warn(
    `[residency] No region env var set; relying on the AWS profile. ` +
      `Confirm the active profile targets ${REQUIRED_REGION} before deploying.`,
  );
}

const backend = defineBackend({
  auth,
  data,
  storage,
  submitAssessment,
  priceProposal,
  renderProposalPdf,
  decideProposal,
  deleteProposalVersion,
  sendProposalEmail,
});

/**
 * ============================================================================
 * ENCRYPTION AT REST — customer-managed KMS key
 * ============================================================================
 *
 * DynamoDB always encrypts at rest, but by default with an AWS-OWNED key. That
 * is real encryption, yet it gives us no key policy, no rotation control, and
 * no CloudTrail record of encrypt/decrypt calls.
 *
 * The Aeygis Cloud Migration Framework sells "KMS AES-256 encryption" to
 * clients. With an AWS-owned key that claim and the configuration do not match.
 * A customer-managed key closes that gap and makes the claim auditable.
 *
 * Switching key types on a live table is safe: AWS documents the process as
 * "seamless and does not require downtime or degrade service" (DynamoDB
 * encryption usage notes). Doing it now, while the table is effectively empty,
 * is the cheapest possible moment.
 *
 * Cost note: unlike the AWS-owned key, a CMK bills per API call and counts
 * against KMS quotas. DynamoDB caches the decrypted table key for five minutes,
 * so real call volume is low.
 */
const encryptionStack = backend.createStack('Encryption');

const dataKey = new Key(encryptionStack, 'AeygisDataKey', {
  alias: 'alias/aeygis-sales-platform-data',
  description:
    'Customer-managed key for Aeygis sales platform data at rest (assessments, proposals). ' +
    'Backs the "KMS AES-256" control described in the Cloud Migration Framework.',
  enableKeyRotation: true,
  // Retain on stack deletion. Destroying the key would make every encrypted
  // item permanently unreadable, including anything restored from a backup.
  removalPolicy: RemovalPolicy.RETAIN,
});

/**
 * Apply the CMK and point-in-time recovery to every generated table.
 *
 * NOTE ON THE API: Amplify's data tables are NOT native AWS::DynamoDB::Table
 * resources — they are a custom "AmplifyDynamoDBTable" resource. So
 * `table.node.defaultChild` is undefined and the usual L1 escape hatch fails at
 * synth with "Cannot set properties of undefined". Overrides must go through
 * `cfnResources.amplifyDynamoDbTables[modelName]`, which is a wrapper exposing
 * typed setters. (Learned by the synth failing, not by assuming.)
 *
 * Iterating all tables rather than naming `Assessment` means the models added in
 * Phases 3 and 4 (ProposalVersion, Approval, AuditEvent) inherit both settings
 * automatically — a model added later cannot silently land unencrypted or
 * unrecoverable.
 *
 * PITR gives a continuous 35-day restore window. Without it there is no undo for
 * a bad deploy or an erroneous delete.
 *
 * Deliberately NOT setting `deletionProtectionEnabled` here: it would block
 * `npm run sandbox:delete`, and a sandbox is meant to be disposable. Turn it on
 * for the branch environment when one is created.
 */
const { amplifyDynamoDbTables } = backend.data.resources.cfnResources;

for (const [modelName, table] of Object.entries(amplifyDynamoDbTables)) {
  table.pointInTimeRecoveryEnabled = true;
  table.sseSpecification = {
    sseEnabled: true,
    sseType: SSEType.KMS,
    kmsMasterKeyId: dataKey.keyArn,
  };
  // "requested", NOT "applied". Amplify's custom table resource IGNORES
  // kmsMasterKeyId when it CREATES a table: the table comes up KMS-encrypted but
  // under the AWS-managed alias/aws/dynamodb key, and only honours the CMK on a
  // later UPDATE. describe-table still reports SSEType=KMS / Status=ENABLED, so
  // every signal short of comparing the key ARN looks like success.
  // ALWAYS follow a deploy that adds a model with `npm run verify:encryption`.
  console.info(`[encryption] ${modelName}: CMK + PITR requested (verify with npm run verify:encryption)`);
}

/**
 * ============================================================================
 * KMS PERMISSIONS — two distinct principals, both required
 * ============================================================================
 *
 * 1. The DynamoDB SERVICE, so it can use the key for table data. Granted via
 *    the key's resource policy, since a service principal has no identity
 *    policy to attach to.
 *
 * 2. Amplify's TABLE MANAGER Lambda roles. Amplify's tables are a custom
 *    resource, and its provider Lambda calls kms:DescribeKey while applying the
 *    setting. Without this the deploy fails with:
 *
 *      "...AmplifyManagedTableOnEvent... is not authorized to perform:
 *       kms:DescribeKey ... because no identity-based policy allows it"
 *
 *    A key policy naming the account root only DELEGATES authority to IAM — it
 *    does not itself grant. So the role needs an identity-based policy, which is
 *    what `grant` on an IAM Role adds. (The first attempt granted only the
 *    service principal and rolled back on exactly this error.)
 *
 * The roles live in a nested stack Amplify generates, so they are located by
 * walking the construct tree rather than by a public accessor. If Amplify
 * renames them, the assertion below fails loudly instead of silently skipping
 * the grant and leaving the table on the AWS-owned key.
 */
dataKey.grantEncryptDecrypt(new ServicePrincipal('dynamodb.amazonaws.com'));

/**
 * THREE role families need key access. Missing any one of them produces a
 * DIFFERENT failure, and two of them fail silently-ish:
 *
 *   AmplifyManagedTable(OnEvent|IsComplete)Role
 *     Amplify's custom-resource provider. Missing -> the DEPLOY rolls back with
 *     "not authorized to perform: kms:DescribeKey". Loud and immediate.
 *
 *   <Model>IAMRole  (e.g. AssessmentIAMRole)
 *     The AppSync data-source role that performs the actual DynamoDB reads and
 *     writes. Missing -> the deploy SUCCEEDS and encryption reports ENABLED,
 *     but every write fails at runtime. This is what broke intake after the
 *     first successful CMK deploy: the table was fine, admin writes worked, and
 *     only the end-to-end verification script caught it.
 *
 *   The Lambda execution roles are NOT in this list on purpose: they reach data
 *   through AppSync (authMode 'iam'), so the data-source role is the principal
 *   that touches DynamoDB, not the function.
 *
 * A key policy naming the account root would NOT be enough — that only
 * delegates authority to IAM, so each principal still needs an identity policy.
 * Hence explicit per-role grants.
 *
 * Matching by pattern rather than by name means the models added in Phases 3
 * and 4 are covered automatically. The assertions below fail the build if
 * either family disappears, because the silent-runtime-failure mode is far
 * worse than a broken deploy.
 */
const TABLE_MANAGER_ROLE = /^AmplifyManagedTable(OnEvent|IsComplete)Role$/;
const DATA_SOURCE_ROLE = /IAMRole$/;

const allDataStackRoles = backend.data.stack.node
  .findAll()
  .filter((construct): construct is Role => construct instanceof Role);

const tableManagerRoles = allDataStackRoles.filter((r) => TABLE_MANAGER_ROLE.test(r.node.id));
const dataSourceRoles = allDataStackRoles.filter((r) => DATA_SOURCE_ROLE.test(r.node.id));

if (tableManagerRoles.length === 0) {
  throw new Error(
    'Could not locate Amplify table-manager roles (AmplifyManagedTableOnEventRole / ' +
      'AmplifyManagedTableIsCompleteRole). Without KMS access the deploy rolls back on ' +
      'kms:DescribeKey. Amplify may have renamed them — check .amplify/artifacts/cdk.out.',
  );
}

if (dataSourceRoles.length === 0) {
  throw new Error(
    'Could not locate any AppSync data-source roles (expected e.g. AssessmentIAMRole). ' +
      'Without KMS access the deploy would SUCCEED but every write would fail at runtime. ' +
      'Refusing to deploy. Check .amplify/artifacts/cdk.out for the current role names.',
  );
}

for (const role of [...tableManagerRoles, ...dataSourceRoles]) {
  dataKey.grantEncryptDecrypt(role);

  // VERIFIED BY DUMPING THE DEPLOYED POLICY, not assumed: grantEncryptDecrypt
  // produces exactly kms:Decrypt, kms:Encrypt, kms:ReEncrypt*, kms:GenerateDataKey*.
  // It does NOT include DescribeKey or CreateGrant, both of which DynamoDB
  // requires. An earlier revision claimed otherwise in a comment and was wrong.
  dataKey.grant(role, 'kms:DescribeKey', 'kms:CreateGrant');

  console.info(`[encryption] granted KMS access to ${role.node.id}`);
}

/**
 * ============================================================================
 * S3 — versioning and encryption
 * ============================================================================
 *
 * `defineStorage` exposes no versioning property, so this drops to the L1
 * CfnBucket. The mechanism (unwrap `node.defaultChild`) is the documented escape
 * hatch; note it DOES work here, unlike for DynamoDB, because the bucket really
 * is a native AWS::S3::Bucket rather than a custom resource.
 *
 * Versioning matters because regenerating a proposal writes to the same key. A
 * client may already hold the previous PDF, so the prior bytes must survive for
 * the approval trail to mean anything.
 *
 * Object Lock (WORM) is deliberately NOT enabled — confirmed with the user. It
 * can only be set at bucket creation, so turning it on later requires a new
 * bucket and a data migration. Recorded as a deferred decision.
 */
const bucket = backend.storage.resources.bucket;
const cfnBucket = bucket.node.defaultChild as CfnBucket;

cfnBucket.versioningConfiguration = { status: 'Enabled' };

cfnBucket.bucketEncryption = {
  serverSideEncryptionConfiguration: [
    {
      serverSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: dataKey.keyArn },
      // Cuts KMS request volume sharply by reusing a data key per prefix, which
      // matters because a CMK bills per call.
      bucketKeyEnabled: true,
    },
  ],
};

// Lifecycle: expire noncurrent versions so the audit trail does not grow without
// bound. 365 days comfortably exceeds any live sales cycle.
cfnBucket.lifecycleConfiguration = {
  rules: [
    {
      id: 'expire-noncurrent-proposal-versions',
      status: 'Enabled',
      noncurrentVersionExpiration: { newerNoncurrentVersions: 10, noncurrentDays: 365 },
    },
  ],
};

/**
 * ============================================================================
 * Function permissions
 * ============================================================================
 */

// Both proposal functions need the CMK, since the bucket is now KMS-encrypted.
// Same lesson as the DynamoDB data-source role earlier in this file: encryption
// succeeds at deploy time and fails at RUNTIME if the principal doing the work
// lacks key access. Granting explicitly rather than relying on the bucket grant.
for (const lambdaFn of [
  backend.priceProposal.resources.lambda,
  backend.renderProposalPdf.resources.lambda,
  backend.decideProposal.resources.lambda,
]) {
  dataKey.grantEncryptDecrypt(lambdaFn.grantPrincipal);
  dataKey.grant(lambdaFn.grantPrincipal, 'kms:DescribeKey');
}

/**
 * deleteProposalVersion is DELIBERATELY ABSENT from the list above.
 *
 * Given this file already documents four separate incidents of "S3/DynamoDB
 * access granted, KMS forgotten", leaving a function out of that loop deserves
 * a reason rather than a shrug:
 *
 *   - Its only S3 action is DeleteObject, which does not decrypt or encrypt
 *     anything, so it needs no key access. Get/Put are the operations that do.
 *   - Its DynamoDB work goes through AppSync with `authMode: 'iam'`, so the
 *     data-source roles do the table access — and those were granted the key
 *     earlier in this file, by name.
 *
 * Both halves of that are claims about runtime behaviour, so they are VERIFIED
 * by actually deleting a version against real AWS, not assumed. If a delete
 * ever fails with a KMS denial, the fix is to add this function to the loop
 * above — but over-granting a key to a function that provably does not need it
 * is its own quiet failure, so it is not done pre-emptively.
 */

/**
 * sendProposalEmail gets DECRYPT ONLY, not the encryptDecrypt the loop above
 * hands out.
 *
 * It reads two KMS-encrypted objects — the snapshot, to re-hash it and read the
 * frozen validity date, and the rendered PDF, to attach it. Both are GetObject,
 * which decrypts. It never writes to the bucket at all: the storage rules give
 * it `read` on two prefixes and nothing else, because delivering a document
 * must not be able to alter the document.
 *
 * Granting encrypt here would be handing out a permission with no call site, on
 * the one function whose output leaves the building. The same reasoning that
 * kept deleteProposalVersion out of the loop above applies in the other
 * direction.
 *
 * DescribeKey is separate because grantDecrypt does not include it — verified
 * earlier in this file by dumping the deployed policy, not assumed.
 */
const sendProposalEmailLambda = backend.sendProposalEmail.resources.lambda;
dataKey.grantDecrypt(sendProposalEmailLambda.grantPrincipal);
dataKey.grant(sendProposalEmailLambda.grantPrincipal, 'kms:DescribeKey');

/**
 * The THIRD instance of the exact same trap, this time on the human side.
 *
 * Found by walking the real path: the S3 storage rule
 * (`allow.groups(['contributor','approver']).to(['read'])` in
 * storage/resource.ts) grants GetObject on proposals/client/*, and the
 * console's "View PDF" button (getPdfUrl in apps/console/src/client.ts)
 * correctly generated a presigned URL using it — but every download 403'd
 * anyway, with the real reason buried in the response body, not the status
 * code: `AccessDenied ... is not authorized to perform: kms:Decrypt`. S3
 * read access and KMS decrypt access are two separate grants; this file
 * already documents that lesson for the Lambda roles above and had not yet
 * applied it to the browser-facing Cognito group roles that read the SAME
 * KMS-encrypted objects directly.
 */
for (const groupName of ['contributor', 'approver']) {
  const groupRole = backend.auth.resources.groups[groupName]?.role;
  if (groupRole === undefined) {
    throw new Error(`Cognito group "${groupName}" not found — cannot grant KMS decrypt for proposal PDFs.`);
  }
  dataKey.grantDecrypt(groupRole);
  dataKey.grant(groupRole, 'kms:DescribeKey');
}

/**
 * ============================================================================
 * DO NOT pass the bucket NAME to a function via addEnvironment.
 * ============================================================================
 *
 * An earlier revision did:
 *
 *   backend.renderProposalPdf.addEnvironment(
 *     'AEYGIS_PROPOSALS_BUCKET_NAME', backend.storage.resources.bucket.bucketName)
 *
 * and the deploy failed with:
 *
 *   CloudformationStackCircularDependencyError: circular dependency found
 *   between nested stacks [storage, data, function]
 *
 * The cycle is real: `storage` already depends on `function` because
 * `allow.resource(renderProposalPdf)` grants it bucket access, so referencing
 * `bucket.bucketName` from the function stack points the arrow back again.
 *
 * This is exactly why Amplify injects such values through an SSM parameter
 * indirection instead of a direct CloudFormation reference — the resource grant in
 * storage/resource.ts supplies AEYGIS_PROPOSALS_BUCKET_NAME on its own. Adding it
 * by hand is not just redundant, it breaks the deploy.
 *
 * (That circular-dependency lesson matters again just below: the new
 * ChromiumPack stack is deliberately its OWN dedicated stack, not nested
 * inside render-proposal-pdf's function stack, for the same reason.)
 */

/**
 * ============================================================================
 * CHROMIUM PACK HOSTING (pending item P4)
 * ============================================================================
 *
 * `@sparticuz/chromium-min` fetches its ~66 MB browser pack at runtime with a
 * PLAIN, UNAUTHENTICATED `fetch(url)` — verified by reading the installed
 * package's source (node_modules/@sparticuz/chromium-min/build/helper.js).
 * It does not sign requests, so an S3 URL the function's IAM role can read is
 * NOT sufficient by itself; the URL must be fetchable with zero credentials.
 *
 * A presigned URL would satisfy that today and then silently expire later —
 * chromium-min only refetches on a COLD START, so this would work for days
 * or weeks and then start failing with no code change and no warning. That
 * makes it the wrong shape for a value that lives in a Lambda env var
 * indefinitely, even though it looks like the more locked-down choice.
 *
 * So this is CloudFront + Origin Access Control in front of a PRIVATE
 * bucket: the bucket has BlockPublicAccess.BLOCK_ALL exactly like every
 * other bucket in this account, and only the CloudFront distribution (via
 * OAC) can read it. The pack is reachable over plain HTTPS without touching
 * this account's S3 Block Public Access settings at all.
 *
 * The bucket holds only this one build artifact — never client data — so it
 * is deliberately separate from the proposals bucket in storage/resource.ts
 * rather than adding a public-reachable prefix next to confidential
 * material.
 * ============================================================================
 */
const chromiumPackStack = backend.createStack('ChromiumPack');

const chromiumPackBucket = new Bucket(chromiumPackStack, 'ChromiumPackBucket', {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  encryption: BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.RETAIN,
});

const chromiumPackDistribution = new Distribution(chromiumPackStack, 'ChromiumPackDistribution', {
  comment: 'aeygis-sales-platform chromium-min pack (build artifact, not client data)',
  defaultBehavior: {
    // The cast is narrow and local: aws-cdk-lib's IBucket has an optional
    // isWebsite?: boolean that this project's exactOptionalPropertyTypes: true
    // treats as structurally different from a concrete Bucket's own type —
    // a known friction point between that tsconfig flag and libraries not
    // authored against it, not a real type mismatch.
    origin: S3BucketOrigin.withOriginAccessControl(chromiumPackBucket as unknown as IBucket),
  },
  // North America only — this distribution serves one Lambda in one region,
  // not a public audience. The cheapest price class is the correct one.
  priceClass: PriceClass.PRICE_CLASS_100,
});

// Version pinned in the path on purpose: layers/chromium/VERSION documents
// that the pack version MUST match @sparticuz/chromium-min@149.0.0 exactly,
// and a version-qualified path makes a future bump land at a new URL rather
// than overwriting the old one underneath a cached CloudFront response.
const CHROMIUM_PACK_KEY = 'chromium/chromium-v149.0.0-pack.x64.tar';

backend.renderProposalPdf.addEnvironment(
  'CHROMIUM_PACK_URL',
  `https://${chromiumPackDistribution.distributionDomainName}/${CHROMIUM_PACK_KEY}`,
);

// price-proposal invokes the renderer asynchronously and needs its name.
backend.priceProposal.addEnvironment(
  'RENDER_FUNCTION_NAME',
  backend.renderProposalPdf.resources.lambda.functionName,
);
backend.renderProposalPdf.resources.lambda.grantInvoke(
  backend.priceProposal.resources.lambda.grantPrincipal,
);

/**
 * ============================================================================
 * FIX: render-proposal-pdf never actually received AEYGIS_PROPOSALS_BUCKET_NAME
 * ============================================================================
 *
 * Found by walking the real path, not by reading code: after CHROMIUM_PACK_URL
 * was fixed above, the very next real invocation failed with
 * "AEYGIS_PROPOSALS_BUCKET_NAME is not set on the render-proposal-pdf
 * function" — a SECOND, previously undiscovered gap that the Chromium error
 * had been masking (handler.ts checks CHROMIUM_PACK_URL first and always
 * returned before ever reaching this one).
 *
 * The comment above ("the resource grant in storage/resource.ts supplies
 * AEYGIS_PROPOSALS_BUCKET_NAME on its own") is TRUE for priceProposal and
 * decideProposal — confirmed by reading their deployed
 * AMPLIFY_SSM_ENV_CONFIG, which correctly lists a path to
 * .../AEYGIS_PROPOSALS_BUCKET_NAME. It is FALSE for renderProposalPdf: its
 * AMPLIFY_SSM_ENV_CONFIG deploys as an empty "{}". Amplify's automatic
 * SSM-env injection does not reach a function defined via
 * `defineFunction(provider)` (see render-proposal-pdf/resource.ts) — the
 * same "Amplify does not manage this function's environment" limitation
 * that function's own file already documents for OTHER variables, just not
 * yet applied to this one.
 *
 * Amplify's own parameter already exists and already has the right value
 * (confirmed by reading it directly), but its path embeds the sandbox
 * identifier ("EmadHussain-sandbox-b7b6a4ac77"), which is different per
 * developer and per environment — not something to hardcode. So this
 * publishes a SEPARATE parameter, under a name this project controls and
 * that stays stable across environments, and grants access to it WITHOUT
 * repeating the circular-dependency mistake documented above: the ARN used
 * for the IAM grant is built from account/region literals via
 * `stack.formatArn(...)`, not from the StringParameter construct's own
 * `.parameterArn` — that property is a token owned by whichever stack
 * created it, and using it in render-proposal-pdf's policy would import a
 * value FROM storage's stack, recreating exactly the same cycle
 * (storage -> function -> storage) as passing bucket.bucketName directly.
 * A same-account/same-region ARN string has no such dependency: it is
 * synthesized independently in every stack from that stack's own pseudo
 * parameters.
 */
const PROPOSALS_BUCKET_PARAM_NAME = '/aeygis-sales-platform/render-proposal-pdf/proposals-bucket-name';

// Created in storage's OWN stack: reading bucket.bucketName here is a
// same-stack reference, not a cross-stack one, so it cannot start a cycle.
new StringParameter(Stack.of(backend.storage.resources.bucket), 'ProposalsBucketNameForRenderer', {
  parameterName: PROPOSALS_BUCKET_PARAM_NAME,
  stringValue: backend.storage.resources.bucket.bucketName,
});

const renderProposalPdfLambda = backend.renderProposalPdf.resources.lambda;
renderProposalPdfLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: [
      Stack.of(renderProposalPdfLambda).formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: PROPOSALS_BUCKET_PARAM_NAME.replace(/^\//, ''),
      }),
    ],
  }),
);
backend.renderProposalPdf.addEnvironment('AEYGIS_PROPOSALS_BUCKET_NAME_PARAM', PROPOSALS_BUCKET_PARAM_NAME);

console.info('[phase3] storage versioning + CMK encryption + function grants applied');

/**
 * ============================================================================
 * READABLE ACTORS IN THE AUDIT TRAIL
 * ============================================================================
 *
 * Every audit record identified its actor by a bare Cognito subject —
 * "0c9d1538-3001-7086-cc74-647707c16b4b approved this" — because the request
 * carries no email address to record.
 *
 * The cause, verified rather than guessed: Amplify's data client sends the
 * ACCESS token for `authMode: 'userPool'` (see the switch in
 * @aws-amplify/api-graphql/.../graphqlAuth.mjs), and decoding both tokens for a
 * real signed-in user shows the split exactly:
 *
 *   ID token      -> sub, email, cognito:groups
 *   ACCESS token  -> sub, cognito:groups          (no email)
 *
 * which is precisely what the data showed: group checks working, actorEmail
 * always null.
 *
 * So the three functions that write audit records look the address up
 * themselves, at WRITE time — the same reason `decidedByGroups` is snapshotted
 * rather than resolved later: an audit record must say what was true at the
 * moment of the act, and a user can be renamed or removed afterwards.
 *
 * `ListUsers` filtered on the subject, NOT `AdminGetUser` by username. On this
 * pool the username happens to equal the sub, so AdminGetUser would work today
 * — but that is an artifact of how these users were created, not a guarantee.
 * The subject is the only identifier the request actually carries.
 *
 * NO CIRCULAR DEPENDENCY here, unlike the bucket-name case documented above:
 * that one cycled because `storage` already depended on `function` via
 * allow.resource(). Nothing in `auth` references these functions — there are no
 * Cognito triggers — so this edge points one way only. Confirmed by
 * `npm run check:synth`.
 */
const userPool = backend.auth.resources.userPool;

for (const auditWriter of [
  backend.decideProposal,
  backend.deleteProposalVersion,
  backend.sendProposalEmail,
]) {
  auditWriter.addEnvironment('AEYGIS_USER_POOL_ID', userPool.userPoolId);
  auditWriter.resources.lambda.addToRolePolicy(
    new PolicyStatement({
      actions: ['cognito-idp:ListUsers'],
      resources: [userPool.userPoolArn],
    }),
  );
}

console.info('[audit] actor email lookup granted to the three audit-writing functions');

/**
 * ============================================================================
 * PHASE 5 — EMAIL DELIVERY
 * ============================================================================
 *
 * Three things, in dependency order: a topic for bad news, a configuration set
 * that publishes to it, and permission for the function to send.
 *
 * ── WHAT IS DELIBERATELY *NOT* HERE: the email identity ─────────────────────
 *
 * `aws-cdk-lib/aws-ses` has an `EmailIdentity` construct, and it is tempting to
 * declare the sender address here so the whole thing is infrastructure as code.
 * It is left out on purpose, for two reasons:
 *
 *   1. Creating an identity sends a verification email that a HUMAN must click.
 *      CDK can create the resource but cannot finish it, so an "as code"
 *      identity is only ever half-declared — it exists and does not work until
 *      somebody acts out of band.
 *   2. Verifying an identity is an AWS action this project requires explicit,
 *      per-action permission for. Folding it into a deploy would perform that
 *      action as a side effect of approving something else, which is exactly
 *      the shape of thing the operating rules exist to prevent.
 *
 * So the identity is created by hand (see docs/email-setup.md) and referenced
 * here only by ARN. If it does not exist, sends fail with a clear SES error
 * rather than this stack failing to deploy.
 */
const emailStack = backend.createStack('EmailDelivery');

/**
 * Where bounces and complaints go.
 *
 * Built BEFORE the first send, not after, for two reasons from
 * docs/email-setup.md. The production-access request asks whether bounces and
 * complaints are handled, so having it already working strengthens the request.
 * And in the sandbox a bounce against your own test address lands that address
 * on the ACCOUNT-LEVEL suppression list, after which sends fail for reasons
 * that look nothing like the cause.
 *
 * No subscription is created here — but ONE EXISTS. Subscribing an address sends
 * a confirmation email a human must click, so CloudFormation can create the
 * resource and cannot finish it; an "as code" subscription would sit in
 * PendingConfirmation receiving nothing. Same reasoning as the identity above,
 * and folding it into a deploy would also send that confirmation as a side
 * effect of approving something else.
 *
 * Created by hand and recorded in docs/aws-resources.md:
 *
 *   rajaemadhussain@gmail.com — protocol email, confirmed 2026-08-23
 *
 * BOTH configuration sets publish here (proposal delivery and the internal
 * new-lead notification), so that one subscriber hears bounces from both. It
 * moves to a monitored Aeygis address at the domain cutover — see step 8 of
 * docs/email-setup.md.
 */
const emailEventsTopic = new Topic(emailStack, 'ProposalEmailEvents', {
  displayName: 'Aeygis proposal email bounces and complaints',
});

/**
 * The configuration set named in the function's environment.
 *
 * `configurationSetName` is pinned to the same constant the function sends
 * with. If CloudFormation were left to generate the name, the function would
 * name one string and the deployed set would be another, and every send would
 * fail with a configuration-set-not-found that reads like a service problem.
 *
 * TLS is left at the default (opportunistic) rather than REQUIRE. REQUIRE
 * refuses to deliver to a mail server that will not negotiate TLS, and a
 * clinic on an older mail host would silently stop receiving proposals. That
 * is a real trade-off rather than an oversight — worth revisiting once the
 * recipients are known, and noted in docs/email-setup.md.
 */
const proposalConfigurationSet = new ConfigurationSet(emailStack, 'ProposalDeliverySet', {
  configurationSetName: SES_CONFIGURATION_SET,
  // Reputation metrics per configuration set, so proposal delivery can be
  // judged on its own rather than mixed into any future account-wide sending.
  reputationMetrics: true,
});

/**
 * Only the events that mean something went wrong.
 *
 * The CDK default is ALL event types, which would publish a notification for
 * every successful send and open — noise that trains people to ignore the
 * topic, which is worse than not having one.
 *
 * DELIVERY_DELAY is included because a delayed message is a problem that has
 * not finished happening yet: it is the signal that arrives before a bounce.
 *
 * NOTE — the SNS topic policy that lets ses.amazonaws.com publish is added by
 * this construct automatically, with AWS:SourceAccount and AWS:SourceArn
 * conditions. Verified by reading the installed construct's source, because the
 * SES documentation describes adding that policy BY HAND and following it would
 * have produced a second, redundant statement.
 */
new ConfigurationSetEventDestination(emailStack, 'ProposalDeliveryProblems', {
  configurationSet: proposalConfigurationSet,
  destination: EventDestination.snsTopic(emailEventsTopic),
  events: [
    EmailSendingEvent.BOUNCE,
    EmailSendingEvent.COMPLAINT,
    EmailSendingEvent.REJECT,
    EmailSendingEvent.DELIVERY_DELAY,
  ],
});

/**
 * Permission to send.
 *
 * Scoped to TWO ARNs, both required in practice:
 *
 *   identity/<address>        — mandatory. Verified against the SES v2 service
 *                               authorization reference: `identity` is the
 *                               required resource type for ses:SendEmail.
 *   configuration-set/<name>  — optional in general, but this function always
 *                               passes ConfigurationSetName, and a policy that
 *                               omitted it would refuse the call.
 *
 * Built with `Stack.formatArn` from the SAME constants the function sends with,
 * so the sender address and the policy cannot drift apart. Changing
 * SES_FROM_ADDRESS therefore requires a redeploy, which is the honest
 * behaviour — the alternative is a policy quietly covering the wrong identity.
 *
 * Not a wildcard on `identity/*`: this function has exactly one legitimate
 * sender, and an account-wide send permission is a much larger thing to hand a
 * Lambda than it looks.
 */
/**
 * The domain half of a sender address, or null if there isn't one.
 *
 * ── WHY BOTH ARNs ARE GRANTED ──────────────────────────────────────────────
 * An SES identity can be an ADDRESS (`someone@example.com`) or a DOMAIN
 * (`example.com`), and `ses:SendEmail` is authorized against the identity ARN.
 *
 * Until 2026-09-16 the sender was `rajaemadhussain@gmail.com`, which was itself
 * a verified ADDRESS identity — so `identity/<address>` named something real and
 * the question never came up. The sender is now `aws@aeygis.com`, an address
 * under a verified DOMAIN identity; no address identity for it exists.
 *
 * The AWS documentation is explicit that either form is a valid ARN, and that
 * address-level policies take precedence over domain-level ones — but it does
 * not state whether an address ARN authorizes a send when only the domain is
 * verified. Rather than guess, both are granted. That costs nothing: it is still
 * two named identities belonging to this company, not `identity/*`, and the
 * account-wide wildcard the original comment warns against is still refused.
 *
 * The failure this avoids is a nasty one — the deploy succeeds, the policy looks
 * right, and every send fails with AccessDenied at runtime.
 */
function senderDomainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

const sesArn = (resource: string, resourceName: string) =>
  Stack.of(sendProposalEmailLambda).formatArn({ service: 'ses', resource, resourceName });

sendProposalEmailLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['ses:SendEmail'],
    resources: [
      sesArn('identity', SES_FROM_ADDRESS),
      // Covers the case where the sender sits under a verified DOMAIN identity
      // rather than being a verified address in its own right. See senderDomainOf.
      ...(senderDomainOf(SES_FROM_ADDRESS) === null
        ? []
        : [sesArn('identity', senderDomainOf(SES_FROM_ADDRESS) as string)]),
      sesArn('configuration-set', SES_CONFIGURATION_SET),
    ],
  }),
);

console.info(
  `[phase5] SES configuration set "${SES_CONFIGURATION_SET}" + bounce/complaint topic created; ` +
    `send permission scoped to ${SES_FROM_ADDRESS}`,
);

/**
 * ============================================================================
 * NEW-LEAD NOTIFICATION (2026-08-25)
 * ============================================================================
 *
 * The public form used to email sales through a third-party relay and mirror
 * the data here. The email was removed and this backend became the only
 * destination — which closed a real gap (leads were not being kept) and opened
 * another: a lead lands in DynamoDB and nothing announces it.
 *
 * So `submit-assessment` now sends an internal heads-up. Two design points:
 *
 * ── A SEPARATE CONFIGURATION SET, NOT THE PROPOSAL ONE ──────────────────────
 * The proposal set exists so client-facing delivery reputation can be judged on
 * its own. Routing internal notifications through it would put a bounce on our
 * own inbox into the same metrics as a proposal that failed to reach a clinic.
 * One extra resource keeps the commercially meaningful number clean.
 *
 * It publishes to the SAME SNS topic, because a bounce is still a bounce and
 * there is no reason to want two places to look.
 *
 * ── THE SEND PERMISSION IS SCOPED THE SAME WAY ──────────────────────────────
 * Identity ARN plus configuration-set ARN, built from the same constants the
 * function sends with. `identity` is the required resource type for
 * ses:SendEmail; the set is needed because the function always passes
 * ConfigurationSetName, and a policy omitting it would deny the call.
 */
const notificationConfigurationSet = new ConfigurationSet(emailStack, 'InternalNotificationSet', {
  configurationSetName: NOTIFY_CONFIGURATION_SET,
  reputationMetrics: true,
});

new ConfigurationSetEventDestination(emailStack, 'InternalNotificationProblems', {
  configurationSet: notificationConfigurationSet,
  destination: EventDestination.snsTopic(emailEventsTopic),
  events: [
    EmailSendingEvent.BOUNCE,
    EmailSendingEvent.COMPLAINT,
    EmailSendingEvent.REJECT,
    EmailSendingEvent.DELIVERY_DELAY,
  ],
});

const submitAssessmentLambda = backend.submitAssessment.resources.lambda;
const notifyArn = (resource: string, resourceName: string) =>
  Stack.of(submitAssessmentLambda).formatArn({ service: 'ses', resource, resourceName });

submitAssessmentLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['ses:SendEmail'],
    resources: [
      notifyArn('identity', NOTIFY_FROM_ADDRESS),
      // Same reasoning as the proposal sender above. NOTIFY_FROM_ADDRESS is
      // imported from SES_FROM_ADDRESS, so this moves with it automatically.
      ...(senderDomainOf(NOTIFY_FROM_ADDRESS) === null
        ? []
        : [notifyArn('identity', senderDomainOf(NOTIFY_FROM_ADDRESS) as string)]),
      notifyArn('configuration-set', NOTIFY_CONFIGURATION_SET),
    ],
  }),
);

console.info(
  `[notify] internal new-lead notification enabled: configuration set ` +
    `"${NOTIFY_CONFIGURATION_SET}", sending as ${NOTIFY_FROM_ADDRESS}`,
);

export default backend;
