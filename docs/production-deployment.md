# Moving to a production branch deployment

Written 2026-09-16. **Nothing in here has been executed.** It is the procedure,
the blockers found while checking it, and the order they have to happen in.

---

## Where we are today

The entire platform runs on an **Amplify sandbox** stack. Not a figure of speech —
it is the literal tag on the CloudFormation stack:

```
Stack : amplify-aeygissalesplatform-EmadHussain-sandbox-b7b6a4ac77
Tag   : amplify:deployment-type = sandbox
```

There is **no Amplify Hosting app** for this project. Every deploy so far has been
`npx ampx sandbox` run from one laptop.

### What that costs

| | |
|---|---|
| Safety settings are **overridden** | the deploy log says it plainly: `keepOnDelete is ignored in sandbox deployments. The bucket will be deleted.` The code asked for retention; Amplify refused *because* it is a sandbox |
| Deletion protection is off everywhere | all 5 DynamoDB tables `False`, the Cognito pool `INACTIVE` |
| One command destroys it | `npm run sandbox:delete` |
| Tied to one developer | the stack name embeds `EmadHussain` |
| No CI/CD | every deploy is manual, from a laptop, with no record of who or when |

PITR gives a 35-day restore window on DynamoDB, so table data survives a mistake.
**The S3 proposal PDFs and the Cognito user accounts do not.**

---

## ⛔ Two hard blockers, found by checking rather than assuming

**A branch deployment cannot be created while the sandbox exists.** Three resources
are declared with fixed, account-unique names, and a second stack creating them
fails outright:

| Resource | Name | Uniqueness |
|---|---|---|
| SES configuration set | `aeygis-proposal-delivery` | per account + region |
| SES configuration set | `aeygis-internal-notifications` | per account + region |
| KMS alias | `alias/aeygis-sales-platform-data` | per account + region |

The fixed names were a deliberate choice — `check:synth` asserts them, because a
CloudFormation-generated name would change under the function and break sending.
That reasoning still holds. It simply also means **the two stacks cannot coexist**.

Two ways past it, and they are genuinely different decisions:

1. **Delete the sandbox first, then create the branch deployment.** Simplest. A gap
   with no working backend between the two, and the sandbox data is gone.
2. **Make the names environment-aware** (`aeygis-proposal-delivery-main` and so on).
   Lets both run side by side, allows a real cutover with no gap, and costs a code
   change plus an update to `check:synth`.

**Recommendation: (1), and do it now.** The `Assessment` table is currently **empty**
— everything else in the tables is test data from verification runs. There is no
real client data to lose today, and that will not be true for long. The cost of (1)
is near zero this week and rises every week after.

---

## What carries over, and what does not

This is the part most likely to surprise. **A branch deployment is a new
environment, not a migration.**

### Survives — these are account-level, not in the stack

- SES **domain identity** `aeygis.com`, DKIM `SUCCESS`, signing on
- SES **production access** (50,000 / 24 h, 14 / s) — granted to the account
- SES suppression list and account reputation
- The `emad` IAM user and its keys

Everything gained in the SES cutover is kept. That work does not need repeating.

### Recreated empty — new ids, new endpoint

| Resource | Consequence |
|---|---|
| Cognito **user pool** | new pool id — **every staff account must be created again** |
| Cognito **identity pool** | new id — **the public website must be updated** |
| **AppSync API** | new endpoint URL — **the public website must be updated** |
| DynamoDB tables ×5 | empty |
| S3 proposals bucket | empty — existing PDFs are not carried across |
| KMS key | new key; old data is not readable with it, which does not matter if the tables are empty |
| SNS bounce topic | new topic — **the email subscription must be re-added and re-confirmed by a human** |

### ⚠ The website is coupled to this

`assets/js/assessment.js` hardcodes both values:

```js
const AEYGIS_IDENTITY_POOL_ID = "ca-central-1:b8b32869-dce2-4f64-b98c-de40483d886b";
const AEYGIS_API_ENDPOINT = 'https://p562sq56szd4tnzalxnz2iqfmi.appsync-api.ca-central-1.amazonaws.com/graphql';
```

Both change. **So the order matters: migrate the backend BEFORE deploying the live
site**, or the site ships pointing at a backend that is about to be deleted and has
to be deployed twice.

---

## The procedure

Each step that touches AWS needs its own go-ahead. Nothing here is automatic.

### 0. Prerequisites

- [ ] The GitHub repo is **private** (it is currently public — see
      [known-issues.md](known-issues.md) item 11)
- [ ] `npm run check:git` passes
- [ ] The full local gate passes: `npm test`, `npm run typecheck`,
      `npm run check:synth`
- [ ] Decide the branch name. `main` is the convention; Amplify maps one git branch
      to one fullstack environment.

### 1. Record what exists, before deleting anything

```bash
AWS_PROFILE=aeygis npm run check:ses        # SES posture — should be unchanged after
AWS_PROFILE=aeygis npm run check:dns        # DKIM — should be unchanged after
```

Keep the output. These are the things that must look identical afterwards; if they
do not, something account-level was taken down with the stack.

### 2. Delete the sandbox ⛔ DESTRUCTIVE, IRREVERSIBLE

```bash
npm run sandbox:delete
```

Destroys the tables, the bucket, the user pool, the Lambdas, the KMS key and both
SES configuration sets. **Confirm the `Assessment` table is empty first** — the
whole argument for doing this now is that there is nothing real in it.

Does **not** touch the SES domain identity or production access.

### 3. Create the Amplify Hosting app, connected to the repo

Console → Amplify → *Create new app* → connect the GitHub repository → select the
branch. This is where Amplify gets permission to read the repo and build it.

The app id it produces is what `pipeline-deploy` needs.

### 4. Add the backend build to `amplify.yml`

The repo has no `amplify.yml` at its root today — the one in the *website* repo is a
different file for a different app. It needs:

```yaml
version: 1
backend:
  phases:
    build:
      commands:
        - npm ci --cache .npm --prefer-offline
        - npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID
frontend:
  phases:
    build:
      commands:
        - npm run build --workspace apps/console
  artifacts:
    baseDirectory: apps/console/dist
    files:
      - '**/*'
```

`ampx pipeline-deploy` refuses to run locally by design — its own help says *"not
intended to be used locally"*. `$AWS_BRANCH` and `$AWS_APP_ID` are injected by
Amplify's build environment.

### 5. Push, and let CI deploy

```bash
git push origin main
```

The build runs `pipeline-deploy`, which creates the whole stack fresh. Expect it to
take longer than a sandbox deploy — every resource is being created, not updated.

### 6. Put the account-level pieces back

Not created by the stack, so each needs doing by hand again:

- [ ] **Staff accounts** — create the console users and assign
      `contributor` / `approver` groups
- [ ] **SNS bounce subscription** — subscribe `aws@aeygis.com` to the new topic,
      and **a human must click the confirmation link**. A `SubscriptionArn` of the
      literal string `PendingConfirmation` means it is not done.
- [ ] **`IP_HASH_SALT`** — `npx ampx sandbox secret set IP_HASH_SALT` has a
      pipeline equivalent; the salt does not travel with the stack. Without it the
      rate limiter disables itself and logs an error rather than hashing weakly.

### 7. Turn on the protections a sandbox would not honour

The reason for doing all this. None of these applied before:

- [ ] DynamoDB **deletion protection** on all 5 tables
- [ ] Cognito user pool **deletion protection**
- [ ] Confirm the S3 bucket **retained** `keepOnDelete` this time — the sandbox
      log said it was ignoring it, and this is the check that it no longer does

### 8. Update the website, then deploy it

- [ ] Put the new `AEYGIS_IDENTITY_POOL_ID` and `AEYGIS_API_ENDPOINT` into
      `assets/js/assessment.js`
- [ ] `npm run verify:signing` and `npm run verify:local-site` against the new
      backend
- [ ] Deploy the live site

### 9. Prove it end to end

```bash
AWS_PROFILE=aeygis npm run check:ses         # SES unchanged?
AWS_PROFILE=aeygis npm run check:dns         # DKIM unchanged?
AWS_PROFILE=aeygis npm run verify:encryption # CMK + PITR on all 5 tables
AWS_PROFILE=aeygis npm run verify:phone      # a real submission stores correctly
AWS_PROFILE=aeygis npm run verify:email      # ⛔ sends one real email
npm run cleanup:tests
```

**Run `verify:encryption` without fail.** Gotcha §16.1 — Amplify ignores
`kmsMasterKeyId` when it CREATES a table and only honours the CMK on a later
update. Every table in this stack will be newly created, so **every table is exposed
to that bug at once**. It has already struck three times on single tables.

---

## Rollback

There is not one, in the usual sense. Once the sandbox is deleted it is gone, and
the branch stack is a fresh environment rather than a replacement for it.

What makes that acceptable **only today**: the `Assessment` table is empty and
everything else is verification residue. The same procedure carried out after real
leads exist would need step 2 replaced by the side-by-side approach — option (2)
under the blockers above — and a genuine data migration.

**That is the argument for doing it now rather than later.**

---

## What this buys

| | Sandbox (today) | Branch deployment |
|---|---|---|
| `keepOnDelete` | **ignored** | honoured |
| Deletion protection | off | can be on |
| Deploys | one laptop, manual | from git, in CI, recorded |
| Tied to | one developer's identity | a branch |
| Destroyed by | one command | deliberate action |
| Who deployed what, when | unknown | in the build history |
