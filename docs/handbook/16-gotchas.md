# 16. Gotchas

← [Verification](15-verification.md) · [Index](README.md) · Next: [Decision log](17-decisions.md)

Every trap this project has already fallen into, with the incident behind it. Recorded
because each was discovered the hard way, not read in advance.

Roughly ordered by how much time each cost.

---

## 16.1 Amplify ignores `kmsMasterKeyId` when it CREATES a table

**⚠ This has struck three times. It is the most deceptive failure in the project.**

Amplify's DynamoDB tables are a `Custom::AmplifyDynamoDBTable` resource, and its provider
**ignores `kmsMasterKeyId` on create**. The table comes up KMS-encrypted but under the
AWS-managed `alias/aws/dynamodb` key. The CMK is only honoured on a later **update**.

Everything says it worked:

- The CloudFormation template correctly requests the CMK
- The synth log prints success
- `describe-table` reports `SSEType: KMS`, `Status: ENABLED`

**Every signal short of comparing the key ARN says it worked.**

`ProposalVersion` landed wrong this way. `ProposalDelivery` landed wrong this way.
`Assessment` was fine only because it pre-existed and got *updated*.

**This affects every new model on its first deploy.**

```bash
npm run verify:encryption      # compares the actual key ARN, not the template

aws dynamodb update-table --table-name <T> --region ca-central-1 \
  --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=<cmk-arn>"
```

---

## 16.2 A KMS-encrypted resource needs a **separate** decrypt grant per principal

**Four separate incidents, four different principals.** An S3 or DynamoDB permission is
necessary but **not sufficient**.

| # | Principal | Failure mode |
|---|---|---|
| 1 | `AmplifyManagedTable(OnEvent\|IsComplete)Role` | The **deploy rolls back** on `kms:DescribeKey`. The only one that fails loudly. |
| 2 | `<Model>IAMRole` (the AppSync data source) | Deploy succeeds, encryption reports `ENABLED`, admin writes work — **and every application write fails at runtime.** |
| 3 | Lambda roles touching S3 directly | Deploy succeeds; the first S3 read or write throws `AccessDenied`. |
| 4 | Cognito `contributor` / `approver` group roles | **The one that took longest to find.** The console's "View PDF" generated a presigned URL successfully — `getUrl()` has no way to know decrypt will fail — and the download 403'd **with the real reason buried in the S3 XML error body, not the HTTP status code**. |

Two further facts, established by dumping the deployed policy rather than assumed:

- **A key policy naming the account root does not grant access.** It only *delegates* to IAM,
  so each principal still needs an identity-based policy.
- **`grantEncryptDecrypt` does NOT include `DescribeKey` or `CreateGrant`**, both of which
  DynamoDB requires. An earlier comment in `backend.ts` claimed otherwise and was wrong.

**Lambda roles that reach data only through AppSync do not need this** — the data-source role
is the principal that touches DynamoDB there.

**The rule:** whenever a new principal gets S3 or DynamoDB access to KMS-encrypted data,
grant `kms:Decrypt` explicitly, in the same change.

---

## 16.3 `pgrep` and `pkill` cannot see Windows processes

Git Bash cannot read Windows process command lines. `pgrep -f 'ampx sandbox'` returns **zero
matches while a sandbox is running**, and `pkill -f` kills nothing. Verified directly by
starting a sandbox and testing the patterns.

This silently accumulated **28 orphaned processes** in one session, nine of them
`ampx sandbox`. They exhausted memory and made esbuild die with:

```
fatal error: runtime: cannot allocate memory
```

— **a failure that looks like a code problem and is not.**

**Every "confirmed nothing is running" based on `pgrep` was false.**

```powershell
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
       Where-Object { $_.CommandLine -like '*ampx.js*' })
Write-Output "running: $($p.Count)"
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }
```

Note the `@(...)` — a single object has no `.Count`.

---

## 16.4 Never pass a bucket name to a function via `addEnvironment`

```
CloudformationStackCircularDependencyError: circular dependency found
between nested stacks [storage, data, function]
```

The cycle is real: `storage` already depends on `function` because `allow.resource(fn)`
grants bucket access, so referencing `bucket.bucketName` from the function stack points the
arrow back again.

**Amplify injects such values through an SSM parameter indirection precisely to avoid this.**
The resource grant supplies `AEYGIS_PROPOSALS_BUCKET_NAME` on its own, so adding it by hand is
not merely redundant — **it breaks the deploy.**

**The same lesson applies to construct properties.** Using a `StringParameter`'s own
`.parameterArn` in a function's IAM policy would import a value *from* storage's stack and
recreate the identical cycle. Build the ARN with `stack.formatArn(...)` from
account/region literals instead — that is synthesized independently in every stack.

---

## 16.5 Amplify's automatic SSM env injection does not reach a `defineFunction(provider)`

**Found by walking the real path, not by reading code.** After `CHROMIUM_PACK_URL` was fixed,
the very next invocation failed with:

```
AEYGIS_PROPOSALS_BUCKET_NAME is not set on the render-proposal-pdf function
```

— a **second, previously undiscovered gap that the Chromium error had been masking**, because
the handler checks `CHROMIUM_PACK_URL` first and always returned before reaching it.

Confirmed by reading the deployed configuration of all three functions:

| Function | `AMPLIFY_SSM_ENV_CONFIG` |
|---|---|
| `price-proposal` | correctly lists a path to `AEYGIS_PROPOSALS_BUCKET_NAME` |
| `decide-proposal` | correctly lists a path |
| `render-proposal-pdf` | **`{}`** |

`ProvidedFunctionProps` exposes only `resourceGroupName`, so Amplify does not manage that
function's environment at all. The fix was a dedicated SSM parameter under a name this
project controls, plus an explicit IAM grant.

**This is also why that handler reads `process.env` directly** rather than the generated
`$amplify/env/*` module.

---

## 16.6 A LayerVersion cannot be updated in a sandbox stack

```
Replacement type updates not supported on stack with disable-rollback.
```

`AWS::Lambda::LayerVersion` is immutable, so changed content is a **replacement** update, and
the sandbox deploys with `--disable-rollback`. Hit for real when the layer gained
chromium-min's 18 transitive dependencies.

**Fixed structurally:** the layer's construct id embeds an 8-character content hash
(`ChromiumLayer<hash>`), so new content becomes a **new logical resource** and CloudFormation
does create-then-delete instead of replace-in-place, which it permits.

Hand-renaming the construct works once and is then forgotten.

**Related:** `--disable-rollback` also leaves failed stacks in `UPDATE_FAILED` rather than
rolling back. **That is intended — you fix forward and deploy again.**

---

## 16.7 A layer needs its dependencies, and `cp -r` will not give you them

The first layer was a directory copy of `node_modules/@sparticuz/chromium-min`. It deployed,
the module resolved from `/opt/nodejs/...`, and the function died at runtime:

```
Cannot find package 'tar-fs' imported from
/opt/nodejs/node_modules/@sparticuz/chromium-min/build/helper.js
```

chromium-min pulls in **18 packages**; the hand-copy shipped **1**.

`npm run build:layer` now runs `npm install --omit=dev` into the layer and **asserts
`tar-fs` is present** before finishing — because a layer that resolves the entry point but
not its dependencies fails at **runtime**, not at deploy.

---

## 16.8 Amplify's bundler does not ship sibling asset directories

The renderer originally did `readFileSync(join(dirname, 'assets', ...))`. Downloading the
**actually deployed** Lambda package showed it contained exactly two files: `index.mjs` and
`index.mjs.map`.

Every font and logo was simply **absent**, and the first render would have thrown `ENOENT`.

**Fixed by baking them into the bundle** as base64 constants in
`template-assets.generated.ts`, so esbuild inlines them. A deliberate trade: ~130 kB of
base64 for assets that cannot be left behind.

**Re-run `npm run gen:assets` after changing any font or logo**, or the change never reaches
the Lambda.

---

## 16.9 `@sparticuz/chromium-min` must be external, and Amplify cannot express that

The package resolves its browser binary through **relative paths**, so bundling relocates it
and it fails at runtime with the library's own message: *"you must externalize
@sparticuz/chromium so it is not relocated."*

Not hypothetical: the first deploy used plain `defineFunction`, and the resulting package
contained the library's guard text **inlined into `index.mjs`**.

Amplify cannot express externalization. Verified in the installed types:

```ts
export type FunctionBundlingOptions = { minify?: boolean };
```

**That is the whole type.** So `defineFunction(provider)` with a hand-configured
`NodejsFunction` is the only route — which then costs the automatic environment injection
(§16.5).

---

## 16.10 `chromium-min` fetches with a plain, unauthenticated `fetch()`

Read from its own source, not guessed
(`node_modules/@sparticuz/chromium-min/build/helper.js`):

```js
const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
```

**No SigV4 signing, no headers.** An S3 URL the function's IAM role can read is **not
sufficient** — the URL must be fetchable with zero credentials.

**A presigned URL is the trap here**, and this documentation previously recommended it. It
would satisfy the requirement today and then **silently expire later** — chromium-min only
refetches on a **cold start**, so it would work for days or weeks and then begin failing with
no code change and no warning.

**Resolution:** CloudFront with Origin Access Control in front of a fully private bucket.

---

## 16.11 A presigned S3 URL expires with the credentials that signed it

**The same trap in a different place.** The original Phase 5 plan was to email a presigned
link rather than an attachment.

A presigned URL created inside a Lambda **expires when the Lambda's role session expires**,
regardless of the expiry requested. AWS states this plainly. **A client opening the email the
next morning would have got an error page.**

---

## 16.12 `ContentTransferEncoding` has no documented default

**The first real proposal email arrived with a blank PDF.**

Everything checkable was provably fine: the S3 object rendered, the SDK's base64 round-tripped
byte-identical, the header was intact.

The AWS API reference lists `BASE64`, `QUOTED_PRINTABLE` and `SEVEN_BIT` as valid values and
**documents no default**. A PDF is binary: `SEVEN_BIT` strips the high bit,
`QUOTED_PRINTABLE` rewrites bytes it considers unprintable.

A PDF's object structure is largely ASCII and **survives** a wrong encoding — which is why the
reader found 15 pages. The compressed content streams did not, which is why it drew 15 empty
ones.

> **The lesson is not "set that field." It is that an undocumented default on a binary payload
> is a silent-corruption risk.**

---

## 16.13 A custom mutation cannot reuse an auto-generated name

Re-enabling `delete` on `ProposalVersion` auto-generates
`Mutation.deleteProposalVersion`. Declaring a custom mutation of the same name fails the
deploy outright:

```
Object type extension 'Mutation' cannot redeclare field deleteProposalVersion
```

**Worth recording because nothing catches it earlier.** `tsc` and the unit suite both pass —
the collision only exists in the **synthesized GraphQL schema**. It surfaces at
`ampx sandbox` and nowhere before.

Hence the custom mutation is called `discardProposalVersion`. The Lambda keeps its own name
(`delete-proposal-version`), which is an AWS resource name in a different namespace.

---

## 16.14 `disableOperations` removes an operation for the Lambda too

An early revision disabled `create` on `Approval` along with `update` and `delete`. That was
self-defeating — removing it from the schema removes it for the **Lambda**, leaving nothing
able to write an approval at all.

**The compiler caught it.**

**The pattern that works:** remove `update`/`delete` from the schema outright, keep `create`
in the schema, and exclude users by granting them `read` only. Those are two different
strengths of guarantee, and the schema says which is which.

---

## 16.15 Amplify sends the ACCESS token, not the ID token

Every audit record identified its actor by a bare UUID. **Not a bug in the identity parser
and not a Cognito misconfiguration.**

Verified in the installed source
(`@aws-amplify/api-graphql/dist/esm/internals/graphqlAuth.mjs`):

```js
case 'oidc':
case 'userPool': {
    token = (await amplify.Auth.fetchAuthSession()).tokens?.accessToken...
```

Decoding both tokens for a real signed-in user:

```
ID token      →  sub, email, cognito:groups
ACCESS token  →  sub, cognito:groups, username    (no email)
```

**Exactly the split the data showed:** group checks working, `actorEmail` always null. The
address is simply never sent.

**Fixed by looking it up from Cognito at write time**, using `ListUsers` filtered on `sub` —
not `AdminGetUser` by username, because username-equals-sub is an artifact of how these users
were created, not a guarantee.

**Records written before the fix keep their UUIDs.** Append-only means they cannot be
backfilled.

---

## 16.16 Two copies of React render a blank page

npm hoisted `react@18.3.1` to the workspace root while the console declared `^19.2.8`, so
`@aws-amplify/ui-react` and the app loaded **different copies**:

```
Invalid hook call ... more than one copy of React
Cannot read properties of null (reading 'useEffect')
```

**Fixed twice over:** root `overrides` pins one version at install time, and
`resolve.dedupe: ['react','react-dom']` in `vite.config.ts` makes Vite resolve a single copy
even if the tree drifts again.

---

## 16.17 `generateClient()` at module scope runs before `Amplify.configure()`

```
Amplify has not been configured. Please call Amplify.configure()
before using this service.
```

ES imports evaluate **before the importing module's body**, so `main.tsx`'s
`Amplify.configure(outputs)` had not run yet.

**Fixed by creating the client lazily**, on first use, which makes correctness independent of
import order.

**Do not hoist it back.**

---

## 16.18 Vite's dev server can serve code that is NOT on disk

On this Windows setup the watcher coalesces rapid successive writes and keeps a mid-edit
transform in its cache. It happened twice during the console rebuild: `authTheme.ts` served
the previous font stack while the file said Manrope, and `App.tsx` served a new import with
none of its usages.

**Nothing errors — the page just renders older code, and any verification you run against it
is meaningless.**

`npm run check:ui` now fails loudly on this **before it runs anything else.**

---

## 16.19 The generated update resolver allows writes but forbids nulls

```
allowedFields:            [ ...every field... ]
nullAllowedFields:        []
isAuthorizedOnAllFields:  false
```

Sending a **single** null fails the **whole** mutation with `Unauthorized on [thatField]` —
rejected outright, not partially applied. Verified in a browser against the deployed API:
nulling `internalNotes` and nulling `patientCount` both fail the same way, so it is not about
any particular field.

It reads like a permissions problem with the signed-in user, **and it is not** — nobody can
null a field on this model.

The console sends only what changed, clears strings with `''`, and **refuses a nulled number
loudly** rather than dropping the edit and reporting success.

---

## 16.20 `overflow: hidden` makes `scrollHeight` a check that cannot fail

`.page` in the proposal template is `overflow: hidden`, so `scrollHeight` is **always**
clamped to `clientHeight` and reports "fits" no matter how far content runs past the bottom.

**A check that cannot fail is worse than no check.**

`check:layout` measures the real bottom edge of the last flowed child against the page box and
against the footer's top edge instead.

---

## 16.21 "X is absent" assertions all pass on an empty list

The first version of `check-synth.mjs` used the regex `^type Mutation \{`, which did not allow
for the `@aws_iam` directive the real schema carries. It matched **nothing** — so three
checks reported a clean bill of health for a file they had never read.

**It now fails loudly if it parses zero mutations.**

The same shape appeared in the unit tests: an HTML-escape test asserted the clinic name was
escaped in the email body, but **the clinic name never reaches that body at all**, so the test
passed on nothing.

> **A check that cannot tell "nothing is wrong" from "I looked at nothing" is worse than no
> check**, because nobody investigates a pass.

---

## 16.22 Waiting on synchronous text proves nothing

A screenshot script waited for the text "Intake queue" before capturing. That text renders
**synchronously**, before any data loads — so the wait always succeeded and the screenshot
showed an empty pane.

Wait on something that only exists **after a real fetch**, such as `.queue-item` count > 0.

---

## 16.23 Two CSS selectors at equal specificity — the later one wins

`button.ghost` and `button.msg-id` both have specificity (0,1,1). `.ghost` is declared later,
so its `font-weight: 700` won and the SES message id rendered bold.

**Fixed by moving the weight onto a child span** rather than fighting the cascade with
`!important`.

**Related token trap:** `--surface-line` is **`transparent`** in light mode. It is not the
divider token. `--line` is.

---

## 16.24 Truncate in CSS, not in the string

The SES message id was sliced in JavaScript (`d.messageId.slice(0, 14)`), so **only 14
characters existed in the DOM.** It could be neither read nor selected — you could not even
drag over it to copy the hidden part.

**Fixed by putting the full id in the DOM and shortening it with `text-overflow: ellipsis`.**
The ellipsis is presentation only, so a selection still picks up every character — which is
also what makes the clipboard fallback work.

---

## 16.25 `\t` is inside the control-character range

`\t` sits inside `U+0000–U+001F`, so a control-character strip **deletes** tabs instead of
collapsing them — turning "Bay Street⟨tab⟩Clinic" into "Bay StreetClinic".

Fixed by excluding `U+0009–U+000D` from the strip class.

**The general form:** replacing control characters with a **space** rather than removing them
is usually right, so words either side do not silently run together. `emailBody.ts`'s
`singleLine()` does exactly that.

---

## 16.26 Scanning raw HTML for the word "margin" is useless

`margin` is a CSS property, so a naive whole-document scan for confidential vocabulary trips
on **every stylesheet** — which means the check either always fails or gets deleted by whoever
is tired of it.

`extractVisibleText()` removes `<style>`, `<script>` and `<svg>` blocks **entirely**, strips
all tags, and **decodes HTML entities** before matching — because `esc()` turns every
apostrophe into `&#39;` on the way in, and a scanner that leaves them encoded is not reading
what a reader reads.

`&amp;` is decoded **last**, so a double-escaped entity such as `&amp;lt;` does not become a
real `<`.

---

## 16.27 A near-miss worth recording: deleting "dead" CSS

`grep 'className="ghost"'` found exactly one usage of the `.ghost` class, so it looked
removable.

**`ThemeToggle.tsx` uses `className="ghost theme-toggle"`.** Deleting the rule would have
broken the theme toggle in both themes.

**Match on the word, not on the whole attribute.**

---

## 16.28 `ampx sandbox` is a watcher, and pipes never flush

```bash
npm run sandbox | tail -25     # produces NO OUTPUT AT ALL
```

The pipe never flushes for a process that does not exit. **Redirect to a file and read that.**

There is also no `--once` flag, and only one instance can hold the lock over
`.amplify/artifacts/cdk.out` — a second fails with `MultipleSandboxInstancesError`.

---

## 16.29 API shapes that differ between Amplify's own modules

| Module | Shape |
|---|---|
| `defineData` | `allow.guest()` and `allow.authenticated()` are **function calls** |
| `defineStorage` | `allow.guest` and `allow.authenticated` are **properties** — `allow.guest.to([...])` |
| `SSEType` | Exported by `@aws-amplify/graphql-api-construct`, **not** `aws-cdk-lib/aws-dynamodb` |
| DynamoDB tables | `table.node.defaultChild` is `undefined` — use `cfnResources.amplifyDynamoDbTables[model]` |
| S3 bucket | `node.defaultChild` **does** work — it is a native `AWS::S3::Bucket` |

Mixing the first two produces a confusing type error.

---

## 16.30 Do not put facts that can go stale into product copy

The console's empty-queue message told staff:

> *"The dual-write on health.aeygis.com is currently **inert** — `AEYGIS_API_ENDPOINT` is
> an empty string, so live submissions still only reach `sales@aeygis.com` by email. See
> pending item P2."*

By then there was no dual-write, the endpoint was set, the address had changed, and P2 was
superseded. **Four wrong facts in one paragraph, shown to staff inside the product.**

Two lessons, and the second is the one that matters.

**First: a `docs/` audit does not cover this.** The message survived a full sweep of every
markdown file immediately beforehand, because user-facing copy lives in
`apps/console/src/**`. It was found the only way it could be — somebody opened the app and
read it.

**Second, and more useful: the fix was not to keep that copy accurate.** The first rewrite
swapped the wrong facts for right ones — deployment status, and a `npm run seed:demo`
instruction. That was still wrong, for reasons that outlast any particular fact:

- **It would go stale again.** Deployment status changes; the copy would not.
- **It addressed the wrong reader.** A salesperson looking at an empty queue has no
  terminal, no repository, and no use for an npm script.
- **It leaked internal vocabulary** — pending-item numbers, environment variable names —
  into a product surface.

The message now says only what stays true: submissions appear here, use Refresh. **Anything
specific enough to be useful for one week is specific enough to be wrong the next.**

Project status, environment detail and remedies belong in documentation, which is versioned
and reviewed. Empty states, error messages and help text should survive without
maintenance.

---

## 16.31 The result type field name must match the GraphQL type

`price-proposal` returns `message`, **not** `error`, to match `GenerateProposalResult` in the
schema.

**A field the GraphQL type does not declare is silently dropped**, so a mismatch would leave
the console showing a blank failure reason.

---

## 16.32 A scalar that validates at write time can only destroy a submission

**⚠ This one cost two real leads before anybody noticed, and the whole test suite stayed
green throughout.**

`phone` was declared `a.phone()` — AppSync's `AWSPhone` scalar. It accepts digits with
spaces or hyphens and an optional `+` country code, and rejects everything else. So all of
these are refused:

| Typed by a person | AWSPhone |
|---|---|
| `(416) 555-1234` | **rejected** — parentheses |
| `416.555.1234` | **rejected** — dots |
| `416-555-1234 ext 22` | **rejected** — extension |
| `+1 416 555 0100` | accepted |

On 2026-08-26 two submissions came in from the local site. Both got as far as the Lambda,
passed validation, minted a reference id — and died on the write:

```
ERROR  failed to persist assessment {
  referenceId: 'AEY-5BFZSX',
  errors: [ { message: "Variable 'phone' has an invalid value." } ]
}
```

The visitor saw *"We could not save your assessment. Please email aws@aeygis.com."* Nothing
else was wrong with either submission.

### The lesson is about WHERE validation runs, not about phone numbers

A GraphQL scalar validates at **write** time — inside the Lambda, long after the visitor
has closed the tab. At that point a refusal has exactly one possible effect: it destroys
the submission. It cannot prompt anyone to fix anything, because there is no longer anyone
there.

Compare `email`, which is checked in `validate.ts`. A bad email comes back as
*"a valid email is required"* while the person is still looking at the form. **Same
validation, opposite outcome, purely because of where it sits.**

Worse, the field was **optional**. The form says "Phone (optional)". A field the visitor
was invited to skip was able to take the entire lead with it.

### Why every test passed

```
seed-demo-data.mjs           phone: '+1 416 555 0142',
verify-lead-notification.mjs phone: '+1 416 555 0100',
verify-email-delivery.mjs    phone: '+1 416 555 0100',
```

Every fixture in the repository used the one format that works, and `validate.test.ts` had
**no phone test at all**. The author of the code wrote the fixtures, so both shared the
same blind spot. **A test suite written by whoever wrote the code inherits its assumptions
about what normal input looks like.** Only a real person typing a real number found it.

### The three fixes

1. **`phone` is now `a.string()`.** Format rules moved to `validate.ts`, where a problem is
   a warning rather than a fatality — and where the stored value keeps `ext 22`, which is
   the part a human dialling it actually needs.
2. **A refused write is retried smaller** (`salvage.ts`). The offending field is parsed out
   of the error, dropped, and the lead stored without it. A lead missing its job title is
   worth vastly more than no lead.
3. **`check:synth` fails on `AWSPhone`, `AWSURL` or `AWSIPAddress` anywhere in
   `Assessment`.** Written against the pre-fix schema first, to confirm it actually caught
   the real bug rather than merely passing.

### The general rule

**On a public form, put format rules where the person can still act on them. A rule that
runs after they have gone is not validation — it is a way of losing their submission.**

---

## 16.33 `ampx sandbox` hot-swaps, so CloudFormation timestamps are not a deploy signal

Mid-deploy on 2026-08-26, every stack read `UPDATE_COMPLETE` with a `LastUpdatedTime` of
`10:49 UTC` — while the deploy that had been running for four minutes was nowhere in the
stack events. It was tempting to read that as "the deploy already finished".

It had not. `ampx sandbox` updates the schema and function code **directly** rather than
through a stack update:

```
✔ Updated AWS::AppSync::GraphQLSchema  data/amplifyData/GraphQLAPI/TransformerSchema
✔ Updated AWS::Lambda::Function        function/submit-assessment-lambda
✔ Deployment completed in 49.837 seconds
```

**Neither of those touches `LastUpdatedTime` on any stack.** So a sandbox deploy can
succeed completely while CloudFormation looks untouched, and it can still be running while
CloudFormation looks finished. The timestamps answer a different question.

What caught it was **comparing clocks**: the stack said `10:49 UTC`, but the submissions
being debugged were logged at `15:15 UTC` the same day. A "recent" timestamp that predates
something you already know happened is not recent. Local here is **UTC+5**, and reading a
local `10:45 PM` next to a UTC `10:49` as the same moment is an easy and expensive mistake.

**Three signals that do work, in increasing strength:**

| Signal | Proves |
|---|---|
| `Deployment completed` in the redirected log | ampx thinks it finished |
| `amplify_outputs.json` mtime and contents | the outputs were regenerated |
| `aws appsync get-introspection-schema` | **what is actually deployed** |

Only the third is independent of the tool that did the deploying. After the phone fix it
returned `phone: String` with `AWSPhone` appearing zero times — which is a fact about the
running API, not a claim by the deployer.

Related: §16.28 — the same command's output never reaches a pipe, only a file.

---

## 16.34 `OPTIONAL` MFA on the pool protects nobody by itself

Setting `multifactor: { mode: 'OPTIONAL', totp: true }` on the user pool is true of
the pool and false of every account, until something lets a person enrol.

| Pool mode | What the Amplify `Authenticator` does |
|---|---|
| `REQUIRED` | forces TOTP setup at the next sign-in — no app code needed |
| `OPTIONAL` | **nothing**. Opting in happens *after* sign-in, via `setUpTOTP()` and `updateMFAPreference()`, which need a screen to be called from |

Verified against the installed `@aws-amplify/ui` core rather than assumed: it
handles the three sign-in **challenge** steps (`CONFIRM_SIGN_IN_WITH_TOTP_CODE`,
`CONTINUE_SIGN_IN_WITH_TOTP_SETUP`, `CONTINUE_SIGN_IN_WITH_MFA_SELECTION`) and offers
no post-sign-in enrolment. So "MFA is on" would have shipped as a pool setting with
every account still password-only, and nothing anywhere would have said so.

The enrolment panel in `UserMenu` exists for this reason, and `check:ui` asserts its
row and control are present because the failure is silent.

**Two things inside it that are easy to get wrong:**

- **`verifyTOTPSetup()` is not enough.** It proves the person captured the secret.
  Cognito only *challenges* at sign-in once `updateMFAPreference({ totp:
  'PREFERRED' })` has also run. The panel awaits both before showing "on".
- **Two exception names mean "wrong code".** Cognito reports a mistyped code during
  setup as `EnableSoftwareTokenMFAException`, not `CodeMismatchException`. Handle one
  and half the people who mistype see a raw exception name.

**And one found by running it, not reading it.** A headless check clicked the avatar
the instant it rendered — before `useRole` had the ID token — and
`fetchMFAPreference()` rejected locally in ~5 ms with no request sent, leaving the row
on "unknown" with no way back short of closing and reopening. A fast human does the
same thing. The status read is now gated on the identity being known, and both the
one-off check and `checkUserMenu` wait for the status to settle instead of pausing
for a fixed 450 ms — a fixed pause was racing that same round-trip.

`npm run verify:mfa` proves the whole thing end to end without a phone: it reads the
secret the panel shows and computes the TOTP code itself (RFC 6238 is twenty lines),
then confirms against Cognito — not the panel — that the method is enabled and
preferred, signs out, and checks that sign-in now stops at a challenge.

---

## 16.35 "Not the loading state" is not the same as "settled"

A headless check waited for a status pill to read **anything but `checking…`** before
reading it. That looks like the obvious condition and it is wrong.

The pill's **first** render is `unknown` — the reducer's initial state, rendered before
the effect dispatches `LOAD`. So the wait resolved on the opening frame, and the read
that followed landed on `checking…` a moment later, once the effect had run.

```
render 1:  unknown     <- wait resolves here
render 2:  checking…   <- the read lands here
render 3:  on          <- what was actually wanted
```

**What it cost.** In `verify:mfa` the value was fed to `if (status === 'on')`, which
therefore never ran, so **"Turn off" was never clicked** and the test approver was left
with `SOFTWARE_TOKEN_MFA` preferred. `check:ui`, `verify:email` and `verify:mfa` all
sign in as that account with a password, and Cognito began meeting them with a TOTP
challenge they do not answer. One wait condition in a cleanup path broke every headless
sign-in in the project, and the failure it printed — *"could not turn MFA off again"* —
pointed at Cognito rather than at itself.

**Wait for the terminal states by name**, not for the absence of a transient one:

```js
['on', 'off'].includes(text)     // settled
!/checking/i.test(text)          // true on the very first frame
```

**The second lesson is about cleanup.** Any check that mutates shared state should
restore it in a `finally`, through the most direct mechanism available — here the admin
API, not the UI it happens to be testing. Driving the UI proves the button works;
it must not also be the only thing standing between a failed run and a broken fixture.
