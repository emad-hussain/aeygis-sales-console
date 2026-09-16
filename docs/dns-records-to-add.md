# DNS records to add at Hostinger — `aeygis.com`

Created in SES on **2026-09-14**. Identity `aeygis.com` exists in `ca-central-1`,
account `326629581669`.

> ## ✅ DONE — DOMAIN VERIFIED 2026-09-14
>
> `VerifiedForSendingStatus: true`, `DkimStatus: SUCCESS`. All three records live on
> public resolvers. **Nothing further is needed on DNS.**
>
> ### Original note when the records were added
>
> All three are **correct in the zone**, confirmed against the authoritative
> nameservers (`helios.dns-parking.com`, `aster.dns-parking.com`). Nothing below
> needs doing again.
>
> Remaining state, and neither item is anyone's to fix:
>
> | | |
> |---|---|
> | Two records live on public resolvers, one still spreading | other people's caches |
> | SES `DkimStatus` | `PENDING` — AWS polls on its own schedule, up to 72 h |
>
> Re-run `AWS_PROFILE=aeygis npm run check:dns` until it says SES agrees.

Until AWS has seen these records the identity stays pending and **nothing can be
sent from `@aeygis.com`**.

---

## The three records

All three are **CNAME**. Nothing else needs to change.

| # | Type | Name | Points to |
|---|---|---|---|
| 1 | CNAME | `46ztkpn637zjxmthomt65c26ixsmfk2z._domainkey` | `46ztkpn637zjxmthomt65c26ixsmfk2z.dkim.amazonses.com` |
| 2 | CNAME | `nahf6roeytonhbqpjtv5z2fgaz5jfmcl._domainkey` | `nahf6roeytonhbqpjtv5z2fgaz5jfmcl.dkim.amazonses.com` |
| 3 | CNAME | `tpygh6cge6xc7njidendkjl4eke2rqtw._domainkey` | `tpygh6cge6xc7njidendkjl4eke2rqtw.dkim.amazonses.com` |

TTL: leave Hostinger's default (usually 14400). It does not matter here.

---

## ⚠ The mistake that costs an afternoon

**Hostinger appends the domain to the Name field for you.**

Enter the name **without** `.aeygis.com`:

```
✅  46ztkpn637zjxmthomt65c26ixsmfk2z._domainkey
❌  46ztkpn637zjxmthomt65c26ixsmfk2z._domainkey.aeygis.com
```

The second becomes `..._domainkey.aeygis.com.aeygis.com`, which resolves to nothing.
SES then sits at `PENDING` with no indication of why, and the natural conclusion is
that DNS is "still propagating" — so people wait days for a record that will never
work.

Two more things Hostinger's editor does that bite:

- It may **strip or add a trailing dot**. Either is fine; do not fight it.
- If a record with the same name already exists it will offer to **replace** it.
  None of these three should already exist — if one does, stop and look, because
  something else is using `_domainkey` on this domain.

---

## What NOT to change

**Do not touch the SPF record.** It currently reads:

```
v=spf1 include:_spf.google.com ~all
```

Leave it exactly as it is. Adding `include:amazonses.com` is a common instruction
and it is **wrong here**. SES sends using a default MAIL FROM under
`amazonses.com`, so SPF passes but does not *align* with `aeygis.com` — and
alignment is what DMARC checks. The include would buy nothing and would consume one
of the ten DNS lookups SPF allows. See
[AWS: custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html).

**DKIM alone satisfies DMARC.** That is what these three records are for.

**Do not touch MX or DMARC.** Google Workspace handles incoming mail for this
domain; SES only sends. The existing DMARC policy
(`v=DMARC1; p=quarantine; pct=100; rua=mailto:coo@aeygis.com`) is correct and is
exactly why DKIM has to be right before anything sends from `@aeygis.com`.

---

## After adding them

```bash
AWS_PROFILE=aeygis npm run check:dns
```

Checks all three CNAMEs against public DNS (asking 8.8.8.8 and 1.1.1.1 directly,
not the local resolver, so a stale negative cache cannot masquerade as "not
published yet") and asks SES for the current status. Read-only, no AWS writes.

`AWS_PROFILE=aeygis` is needed because the default credentials on this machine have
expired. Drop it once they are refreshed.

It asks the **authoritative nameservers** first and public resolvers second, which
is the distinction that matters. Four outcomes, only one of which is yours to act
on:

| Outcome | What it means | What to do |
|---|---|---|
| Not in the zone | Genuinely missing or mistyped | **Fix it** |
| In the zone, not on public resolvers | Correct, still spreading | Wait |
| Everywhere, SES still `PENDING` | Correct, AWS has not polled | Wait |
| Could not reach a resolver | This machine's problem | Nothing about the records |

> **Why the authoritative check is there.** The first version of this script asked
> only public resolvers, and reported one of these three correctly-added records as
> *"NOT PUBLISHED — will not fix itself by waiting"*. Every word of that was wrong:
> the record was in the zone, correct, and waiting was exactly the remedy — the
> three had simply propagated at different rates.
>
> That is worse than not checking at all, because it sends somebody to re-type a
> record that is already right, and re-typing is how a correct record becomes a
> broken one. **Absent from a resolver is not absent from the zone.**

Propagation is usually minutes on Hostinger, but AWS polls on its own schedule and
can take up to 72 hours to flip the identity to verified. The records being correct
is the part you control; the flip is not.

---

## Then, and only then

1. Confirm `aws@aeygis.com` is a real mailbox in Google Workspace.
2. Re-request SES production access — reply on the denied case `178930966200969`
   rather than resubmitting blind, now that a real domain is verified.
3. Switch `SES_FROM_ADDRESS` and redeploy. **A redeploy is required**: `backend.ts`
   scopes `ses:SendEmail` to the sending identity's ARN, so changing the address
   without deploying leaves the function unable to send at all.
4. Re-point the SNS bounce subscription — add and confirm the new address **before**
   removing the Gmail one, or there is a window with no subscriber.
5. Last of all, open `SES_ALLOWED_RECIPIENTS` to `*`. It **fails closed**: blank
   blocks everything.

Full sequence in [`email-setup.md`](email-setup.md).
