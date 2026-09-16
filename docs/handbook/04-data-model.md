# 4. Data model

← [Architecture](03-architecture.md) · [Index](README.md) · Next: [AWS resources](05-aws-resources.md)

Defined in [`amplify/data/resource.ts`](../../amplify/data/resource.ts). Five models,
five custom mutations, five receipt types.

---

## 4.1 How authorization works here

Two separate mechanisms, and it matters which is which.

**`disableOperations([...])`** removes a mutation from the **generated GraphQL schema
entirely**. It does not exist to be called — not by a user, not by a Lambda, not by any
future edit to an authorization rule.

**`allow.groups([...]).to([...])`** grants specific operations to specific Cognito groups.
The operation still exists in the schema; the caller is simply refused.

The pattern used throughout is: remove `update` and `delete` from the schema outright,
keep `create` in the schema so the Lambda can write, and grant users `read` only.

An earlier revision disabled `create` on `Approval` as well. That was self-defeating —
removing it from the schema removes it for the Lambda too, leaving nothing able to write
an approval at all. The compiler caught it.

**Schema-level function access.** `allow.resource(fn)` is declared at schema level, not
per model, because every verified example does it that way — so function data access is
assumed **API-wide**. That assumption is precisely why confidential cost data is kept
*out of the schema entirely* rather than protected by a rule.

**Authorization modes:**

```
defaultAuthorizationMode: 'userPool'     // the staff console
                          identityPool   // passed explicitly by the public form
```

There is **no API key**. An API key is a bearer credential that would have to ship in the
public site's JavaScript. The identity pool's unauthenticated role is the documented
production choice for public access and issues short-lived, scoped credentials instead.

---

## 4.2 `Assessment` — the lead

A prospect's cloud readiness assessment. **Written only by the `submit-assessment`
Lambda.** Staff read and update it.

### Authorization

```
allow.groups(['contributor', 'approver']).to(['read', 'update'])
```

**There is deliberately no `allow.guest()`.** See
[Architecture §3.2 decision 2](03-architecture.md#decision-2--public-writes-go-through-a-custom-mutation-never-a-model-rule).
No create, no delete, for anyone. A console that could create assessments would let a rep
invent a lead.

### Fields

**Reference and provenance**

| Field | Type | Notes |
|---|---|---|
| `referenceId` | string, required | `AEY-7F3K2Q`. Alphabet excludes I, O, 0, 1 so it survives being read aloud. |
| `source` | string, required | `health_site_live_form` \| `internal_console` \| `manual_entry` |
| `status` | string, required | `new` \| `needs_confirmation` \| `in_review` \| `proposed` \| `closed`. Staff set it by hand, with one exception: **emailing a proposal moves it to `proposed` automatically** (see [6.6](06-backend-functions.md#66-send-proposal-email)). `closed` is never moved automatically. |
| `submittedAt` | datetime, required | **Explicit, not the implicit `createdAt`.** Using a system field as a GSI sort key requires declaring it, so this one is owned outright. ISO-8601 sorts correctly as text — an integer would not. |
| `submitterIpHash` | string | SHA-256 of (client IP + a server-side salt). **Never the raw address.** |

**Contact**

| Field | Type |
|---|---|
| `clinicName`, `contactName`, `jobTitle`, `organizationType`, `organizationSize`, `province` | string |
| `email` | email |
| `phone` | **string, deliberately not `phone`** |

`email` is the address a proposal is sent to. There is no way to override it at send time.

`phone` was `a.phone()` until 2026-08-26, when two real leads were destroyed by it.
AppSync's `AWSPhone` scalar accepts digits with spaces or hyphens and an optional `+`
country code, and nothing else — so `(416) 555-1234` is refused. The refusal happens at
**write** time, inside the Lambda, after the visitor has gone, which means it can only
destroy a submission and can never help anyone correct one. An **optional** field took
whole leads down with it.

The value is now a plain string, normalised in `validate.ts` and never rejected: a number
that looks wrong is stored anyway and flagged as a warning. This is also more useful —
`416-555-1234 ext 22` is what a human needs in order to place the call, and any tidy-up
into a canonical format would throw the extension away.

`check:synth` now fails if any `Assessment` field uses `AWSPhone`, `AWSURL` or
`AWSIPAddress`. See [Gotchas §16.32](16-gotchas.md#1632-a-scalar-that-validates-at-write-time-can-only-destroy-a-submission).

**Scale — exact counts are authoritative**

| Field | Type | Notes |
|---|---|---|
| `providerBand`, `locationBand` | string | What the live form supplied. Provenance only. |
| `providerCountMin/Max`, `locationCountMin/Max` | integer | The band widened to an explicit range. |
| `providerCount`, `locationCount` | integer | **The authoritative values.** Pricing reads only these. |
| `patientCount` | integer | Used only to hint which of Micro/Starter fits better. |
| `countsConfirmed` | boolean, required | Pricing refuses while this is false. |

**Current infrastructure and spend** — the clinic's own figures, used for the comparison
page in the proposal.

| Field | Type |
|---|---|
| `hosting` | string — `onprem` \| `cloud` \| `mixed` |
| `monthlyItSpend`, `annualHardwareEmergency` | float |
| `downtimeHoursBand` | string — `under10` \| `10to40` \| `40to90` \| `over90` |
| `downtimeCostBand` | string — `under1000` \| `1000to2500` \| `2500to5000` \| `over5000` |

**Security and compliance posture**

| Field | Values |
|---|---|
| `mfa`, `backups`, `incidentPlan` | `yes` \| `no` \| `unsure` |
| `lastRiskAssessment` | `1yr` \| `1-2yr` \| `never` \| `unsure` |

Note `1yr` and `1-2yr` are **illegal as GraphQL enum members** (a leading digit, and a
hyphen), which is why every one of these vocabularies is stored as a validated string
rather than an enum.

**Consent (CASL / PIPEDA)**

| Field | Type | Notes |
|---|---|---|
| `consent` | boolean, required | A submission without it is rejected. Nothing is stored. |
| `consentedAt` | datetime | Set server-side at the moment of acceptance. |

**Technical discovery (staff-filled)**

| Field | Type | Notes |
|---|---|---|
| `discoveryAnswers` | json | The 20 approved questions, keyed by question id. Stored as JSON so the question set can be revised without a schema migration. |
| `customDiscoveryQuestions` | json | This clinic's **own** extra questions and categories. Per assessment by design. |

Both are keyed by question id, which is why a custom id that would shadow `q01`–`q20` is
refused: a collision silently overwrites an approved answer.

**Staff-authored proposal content**

| Field | Type | Notes |
|---|---|---|
| `migrationSchedule` | json | Timing estimates per migration phase. **Free text**, because no approved document states phase durations and the system must not imply a precision it does not have. |
| `responsibilityMatrix` | json | Which approved matrix rows to exclude, plus clinic-specific rows to add. The approved **wording** is not editable. |

**Internal**

| Field | Type |
|---|---|
| `internalNotes` | string |
| `assignedTo` | string |

### Indexes

| Index | Query field | Purpose |
|---|---|---|
| `status` sorted by `submittedAt` | `assessmentsByStatus` | Console list-by-status |
| `submitterIpHash` sorted by `submittedAt` | `assessmentsBySubmitterIpHash` | **Per-IP rate limiting.** Reusing this index avoids provisioning a throttle table whose only job is counting. |

---

## 4.3 `ProposalVersion` — an immutable priced version

### Authorization and operations

```
.identifier(['proposalId', 'versionKey'])
.disableOperations(['update'])
allow.groups(['contributor', 'approver']).to(['read'])
```

**`update` is removed from the schema.** Phase 4 records an approval against a specific
version and its `contentSha256`. If a version could be edited after approval, the approval
would silently start referring to different content — an approver would appear to have
signed off on numbers they never saw. To change a proposal, mint a new version.

**`delete` is present in the schema, but no user role holds it.** It exists only so the
`delete-proposal-version` Lambda can call it. The sole route available to the console is
the custom `discardProposalVersion` mutation, which refuses anything whose latest
decision is `approved`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `proposalId` | string, required | The assessment's `referenceId` (falling back to its id). Part of the composite key. |
| `versionKey` | string, required | **Zero-padded**: `v0004`. Part of the composite key. |
| `versionNumber` | integer, required | **Display only. Never used for ordering** — GSI sort keys compare as text, so integer 10 would sort before 2. |
| `assessmentId` | string, required | |
| `tier` | string, required | `micro` \| `starter` \| `professional` \| `enterprise` |
| `supportPlan` | string | `trainAndWalkAway` \| `essentials` \| `fullManaged` |
| `providerCount`, `locationCount` | integer, required | The exact counts this was priced from |
| `patientCount` | integer | |
| `setupTotal`, `monthlyTotal`, `annualCheckup`, `firstYearTotal` | float, required | The quoted figures |
| `priceFactor` | float, required | Fraction of list, e.g. 0.9 |
| `requiresExecutiveSignOff` | boolean, required | True below the 90% floor |
| `currency` | string, required | `CAD` |
| `priceBookVersion` | string, required | Stamped so a historical proposal stays reproducible |
| `snapshotS3Key` | string, required | The frozen client-safe JSON. **The renderer reads this and nothing else.** |
| `contentSha256` | string, required | SHA-256 of the snapshot bytes. An approval binds to this. |
| `pdfS3Key`, `pdfRenderedAt`, `pdfRenderError` | string / datetime | Declared for the renderer to populate — **but they have no write path**, see below |
| `createdBy`, `createdAt` | string / datetime, required | Taken from the request identity, never from an argument |

**About `pdfS3Key`.** These three fields exist in the schema but nothing writes them:
`render-proposal-pdf` is invoked fire-and-forget (`InvocationType: 'Event'`, so Chromium's
cold start never blocks Generate), its return value goes nowhere, and `update` is disabled
outright. Loosening immutability just to shuttle one operational field back would be the
wrong trade. The console does not need it: `proposalId` and `versionKey` are known the
moment a version exists, so it computes the same deterministic S3 path
`proposals/client/{proposalId}/{versionKey}.pdf` that `price-proposal` already uses, and
asks S3 whether the object is there yet.

### Index

| Index | Query field |
|---|---|
| `assessmentId` sorted by `createdAt` | `proposalVersionsByAssessment` |

---

## 4.4 `Approval` — an immutable decision

### Authorization and operations

```
.disableOperations(['update', 'delete'])
allow.groups(['contributor', 'approver']).to(['read'])
```

Nothing can alter or erase an approval: not a user, not a Lambda, not a future edit to an
authorization rule. `create` remains for the `decide-proposal` Lambda; users hold read
only, so a rep cannot forge a decision.

### Fields

| Field | Type | Notes |
|---|---|---|
| `proposalId`, `versionKey` | string, required | |
| `decision` | string, required | `approved` \| `rejected` |
| `reason` | string | Optional, and legitimately often blank |
| `contentSha256` | string, required | **The exact bytes approved.** |
| `decidedBy` | string, required | Cognito subject |
| `decidedByEmail` | string | Resolved from Cognito **at write time** — see §4.8 |
| `decidedByGroups` | string, required | Comma-joined, **snapshotted at decision time** |
| `decidedAt` | datetime, required | |

**Why it binds a hash.** `ProposalVersion` is already immutable, but the S3 snapshot it
points at is a separate object. Binding the hash means a swapped or edited snapshot is
detectable afterwards.

**Why it snapshots groups.** Cognito group membership is mutable. If someone is later
removed from `approver`, this record must still show that they held that role **at the
moment of decision**. Resolving membership at read time would quietly rewrite history.

**A reversal is a new record, never an edit.** The latest decision wins everywhere the
question is asked.

### Index

| Index | Query field |
|---|---|
| `proposalId` sorted by `decidedAt` | `approvalsByProposal` |

---

## 4.5 `AuditEvent` — the append-only trail

### Authorization and operations

```
.disableOperations(['update', 'delete'])
allow.groups(['contributor', 'approver']).to(['read'])
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `subjectId` | string, required | Groups related events. Usually the proposal reference. |
| `subjectType` | string, required | `assessment` \| `proposal` |
| `eventType` | string, required | See the list below |
| `actor` | string, required | Cognito subject |
| `actorEmail` | string | Resolved at write time |
| `actorGroups` | string | Comma-joined, snapshotted |
| `detail` | json | Free-form. **Never confidential data** — readable by every staff member, contributors included. |
| `occurredAt` | datetime, required | |

### Event types currently written

| Event | Written by | Meaning |
|---|---|---|
| `proposal_approved` / `proposal_rejected` | `decide-proposal` | A decision was recorded |
| `approval_denied_not_approver` | `decide-proposal` | A non-approver reached the Lambda — should be unreachable |
| `approval_refused_stale_hash` | `decide-proposal` | The version changed while the approver was reading |
| `approval_refused_snapshot_tampered` | `decide-proposal` | **The stored bytes no longer match their recorded fingerprint** |
| `proposal_version_deleted` | `delete-proposal-version` | Carries everything that was removed — this event *replaces* the row |
| `version_delete_refused_approved` | `delete-proposal-version` | Someone tried to delete an approved version |
| `version_delete_denied_not_staff` | `delete-proposal-version` | Should be unreachable |
| `proposal_email_sent` / `_blocked` / `_failed` | `send-proposal-email` | One per send attempt |
| `proposal_email_denied_not_approver` | `send-proposal-email` | Should be unreachable |

The `*_denied_*` events all carry `reachedLambdaDespiteApiRule: true`. Reaching them
would mean the API-level rule had stopped working, which is precisely the thing worth a
permanent record.

### Index

| Index | Query field |
|---|---|
| `subjectId` sorted by `occurredAt` | `auditEventsBySubject` |

---

## 4.6 `ProposalDelivery` — one send attempt

### Authorization and operations

```
.disableOperations(['update', 'delete'])
allow.groups(['contributor', 'approver']).to(['read'])
```

**Read-only for both roles.** A contributor cannot send, but must be able to see whether a
proposal has gone out — otherwise they would chase a client who already has it.

### Fields

| Field | Type | Notes |
|---|---|---|
| `proposalId`, `versionKey` | string, required | |
| `assessmentId` | string, required | Carried so the console can list deliveries for a lead without first resolving which proposals belong to it |
| `status` | string, required | `sent` \| `blocked` \| `failed` |
| `recipient` | string | **Populated even when blocked** — "who would this have gone to" is the first question anyone asks |
| `bcc` | string | |
| `subject` | string | |
| `messageId` | string | SES's own id. Present only on success. The handle for tracing a message in CloudWatch or a bounce notification. |
| `failureReason` | string | In words a human reads in the console. **Never a raw exception string.** |
| `contentSha256` | string | Fingerprint of the document actually attached |
| `sentBy` | string, required | Cognito subject |
| `sentByEmail` | string | Resolved at write time |
| `sentAt` | datetime, required | |

**Why three statuses and not a boolean.** `blocked` (we deliberately refused, nothing left
the building) must never read as `failed` (we tried and something broke). While SES is in
the sandbox, `blocked` is the **expected** outcome for a real client address, so
collapsing it into `failed` would make normal operation look like a fault.

**Why it stores `contentSha256`.** The row proves which exact bytes the client received,
not merely which version was named. `ProposalVersion` is immutable and the approval binds
to the same hash, so recording it here closes the loop.

**A second send is a second row.** Sending a revised proposal is a normal thing to do, and
"we sent them two versions" is exactly the fact somebody will need later. Overwriting
would tidy that away.

### Index

| Index | Query field |
|---|---|
| `proposalId` sorted by `sentAt` | `deliveriesByProposal` |

---

## 4.7 The five mutations

### `submitAssessment` — the single public entry point

```
arguments:      payload: json (required)
returns:        SubmitAssessmentResult { ok, referenceId, message }
authorization:  allow.guest(), allow.authenticated()
handler:        submit-assessment
```

Returns a **receipt**, never model data. Never widen this type to include assessment
content.

### `generateProposal`

```
arguments:      assessmentId, tier (required); supportPlan, priceFactor (optional)
returns:        GenerateProposalResult { ok, proposalId, versionKey, contentSha256, message }
authorization:  allow.groups(['contributor', 'approver'])
handler:        price-proposal
```

**Without this the pipeline had no middle.** The `price-proposal` Lambda existed and was
deployed, but nothing could invoke it, so no `ProposalVersion` could ever be created and
the approval panel was permanently empty. Found by asking the plain question "how do I
approve something?" and tracing the path rather than trusting that the pieces connected.

Open to both roles: drafting a priced document is normal contributor work. The Lambda
still refuses unconfirmed counts and refuses Enterprise outright, so exposing it widens
who can draft, not what may be quoted.

### `decideProposal`

```
arguments:      proposalId, versionKey, decision, expectedContentSha256 (required); reason
returns:        DecideProposalResult { ok, decision, message }
authorization:  allow.group('approver')
handler:        decide-proposal
```

**Authorization is enforced twice, deliberately.** AppSync rejects a contributor before
the Lambda is ever invoked; the Lambda then re-reads the caller's groups from the request
identity. The second check is not redundant — it is what produces the snapshot written to
`Approval.decidedByGroups`, so the rule and the recorded evidence cannot disagree.

### `discardProposalVersion`

```
arguments:      proposalId, versionKey
returns:        DiscardProposalVersionResult { ok, message }
authorization:  allow.groups(['contributor', 'approver'])
handler:        delete-proposal-version
```

**Why it is not called `deleteProposalVersion`.** That name is already taken — by the
model. Re-enabling `delete` on `ProposalVersion` auto-generates
`Mutation.deleteProposalVersion`, and declaring a custom mutation of the same name fails
the deploy outright:

```
Object type extension 'Mutation' cannot redeclare field deleteProposalVersion
```

Worth recording because nothing catches it earlier: `tsc` and the unit suite both pass,
since the collision only exists in the **synthesized GraphQL schema**. It surfaces at
`ampx sandbox` and nowhere before.

The Lambda keeps its own name (`delete-proposal-version`) — that is an AWS resource name
in a different namespace and collides with nothing.

### `sendProposalEmail`

```
arguments:      proposalId, versionKey, expectedContentSha256 (all required)
returns:        SendProposalEmailResult { ok, status, recipient, message }
authorization:  allow.group('approver')
handler:        send-proposal-email
```

**Approver only, and not for the same reason as `decideProposal`.** That one is
approver-only because approving is the privileged judgement. This is approver-only because
it is the **irreversible** one.

**Deliberately takes no recipient argument.** The address comes from the clinic's own
contact details, so a caller cannot redirect a proposal by passing a different one.

`ok: false` covers both "we refused" and "it broke", which is why `status` is also on the
result — the console needs to say "blocked, and here is why" rather than showing a generic
failure for something the system did on purpose.

---

## 4.8 The actor email problem, and how it was fixed

Every audit record used to identify its actor by a bare Cognito subject —
`0c9d1538-3001-7086-cc74-647707c16b4b approved this` — because the request carries no
email address.

**The cause, verified rather than guessed.** Amplify's data client sends the **access
token** for `authMode: 'userPool'`. This is in the installed source,
`@aws-amplify/api-graphql/dist/esm/internals/graphqlAuth.mjs`:

```js
case 'oidc':
case 'userPool': {
    token = (await amplify.Auth.fetchAuthSession()).tokens?.accessToken...
```

Decoding both tokens for a real signed-in user shows the split exactly:

```
ID token      →  sub, email, cognito:groups
ACCESS token  →  sub, cognito:groups, username     (no email)
```

Which is precisely what the data showed: group checks working, `actorEmail` always null.
Not a bug in the identity parser, not a Cognito misconfiguration — the address is simply
never sent.

**The fix.** The three audit-writing functions (`decide-proposal`,
`delete-proposal-version`, `send-proposal-email`) look the address up from Cognito
themselves, **at write time**. Same reasoning as `decidedByGroups`: an audit record must
say what was true at the moment of the act, and a user can be renamed or removed
afterwards.

**Implementation notes:**

- Uses `ListUsers` filtered on `sub`, **not** `AdminGetUser` by username. On this pool the
  username happens to equal the sub, so `AdminGetUser` would work today — but that is an
  artifact of how these users were created, not a guarantee. The subject is the only
  identifier the request actually carries.
- The filter builder **refuses** a subject containing a quote or backslash. A malformed
  Cognito filter does not error, it returns *no users*, which is indistinguishable from
  "this user is gone" and would silently reinstate the null-email behaviour.
- **Failure is never fatal.** If the lookup fails, the caller is returned unchanged with a
  null email. Losing a convenience field must not block an approval or abandon an email
  that was already sent.
- It short-circuits if the email is already present, so it silently stops making a call at
  all if Amplify ever starts sending the ID token.

**Existing records keep their UUIDs.** Append-only means they cannot be backfilled, and
that is correct.
