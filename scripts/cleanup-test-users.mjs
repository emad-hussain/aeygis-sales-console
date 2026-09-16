/**
 * Deletes the Cognito test users created for console verification.
 *
 * Only removes usernames on the explicit list below, matched against
 * .test-credentials.json. It will never touch a real staff account, and it
 * reports any other user in the pool rather than guessing.
 *
 * Run:  npm run cleanup:users
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const region = outputs.auth.aws_region;
const userPoolId = outputs.auth.user_pool_id;

const credsPath = new URL('../.test-credentials.json', import.meta.url);
if (!existsSync(credsPath)) {
  console.log('No .test-credentials.json — nothing recorded to clean up.');
  process.exit(0);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));

const testUsernames = new Set(
  Object.values(creds)
    .filter((v) => v && typeof v === 'object' && typeof v.username === 'string')
    .map((v) => v.username),
);

const client = new CognitoIdentityProviderClient({ region });

console.log(`Region:    ${region}`);
console.log(`User pool: ${userPoolId}\n`);

const { Users = [] } = await client.send(new ListUsersCommand({ UserPoolId: userPoolId }));

let deleted = 0;
const kept = [];

for (const user of Users) {
  const email = user.Attributes?.find((a) => a.Name === 'email')?.Value;
  // Match on the email attribute: Cognito's Username is a generated sub when the
  // pool uses email sign-in, so it never equals the address we created with.
  if (email && testUsernames.has(email)) {
    await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: user.Username }));
    console.log(`  deleted  ${email}`);
    deleted += 1;
  } else {
    kept.push(email ?? user.Username ?? '(unknown)');
  }
}

console.log(`\nDeleted ${deleted} test user(s).`);

if (kept.length > 0) {
  console.log(`\nKept ${kept.length} account(s) not on the test list:`);
  for (const k of kept) console.log(`  ${k}`);
}

if (deleted > 0) {
  rmSync(credsPath, { force: true });
  console.log('\nRemoved .test-credentials.json');
}
