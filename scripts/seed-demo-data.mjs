/**
 * Seeds a few realistic assessments so the console has something to show.
 *
 * IMPORTANT: this writes through the REAL public path — the guest-authorized
 * `submitAssessment` mutation, SigV4-signed exactly as an anonymous browser would.
 * It does not insert into DynamoDB directly. So seeding also exercises validation,
 * the honeypot, consent enforcement and band widening, and anything it produces is
 * something the live form could genuinely produce.
 *
 * The four records deliberately cover the interesting states:
 *
 *   1. bands only            -> lands as `needs_confirmation`; cannot be priced yet
 *   2. Micro/Starter overlap -> exact counts, TWO tiers apply, staff must choose
 *   3. Professional + extras -> per-unit scaling on setup and monthly
 *   4. Enterprise            -> pricing refuses; discovery call required
 *
 * All use @aeygis-test.invalid (a reserved TLD, so no mail can ever be delivered)
 * and are removed by `npm run cleanup:tests`.
 *
 * Run:  npm run seed:demo
 */
import { readFileSync } from 'node:fs';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { AwsClient } from 'aws4fetch';

const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url)));
const REGION = outputs.data.aws_region;
const ENDPOINT = outputs.data.url;
const POOL = outputs.auth.identity_pool_id;

const MUTATION = `mutation S($payload: AWSJSON!) {
  submitAssessment(payload: $payload) { ok referenceId message }
}`;

/** Realistic Ontario clinic shapes, one per interesting pricing state. */
const SEEDS = [
  {
    label: 'bands only -> needs_confirmation',
    payload: {
      clinicName: 'Riverside Family Practice',
      contactName: 'Alison Kerr',
      jobTitle: 'Practice Manager',
      email: 'riverside@aeygis-test.invalid',
      phone: '+1 416 555 0142',
      organizationType: 'Family Health Team',
      organizationSize: '12 staff',
      province: 'Ontario',
      // The live form sends BANDS, not numbers. This is the realistic default.
      providers: '3-15',
      locations: '2-5',
      hosting: 'onprem',
      monthlyItSpend: 4200,
      annualHardwareEmergency: 18000,
      downtimeHoursBand: '10to40',
      downtimeCostBand: '1000to2500',
      mfa: 'no',
      backups: 'unsure',
      incidentPlan: 'no',
      lastRiskAssessment: 'never',
      consent: true,
    },
  },
  {
    label: 'Micro/Starter overlap -> two tiers apply',
    payload: {
      clinicName: 'Bayview Solo Clinic',
      contactName: 'Dr. Priya Raman',
      jobTitle: 'Physician / Owner',
      email: 'bayview@aeygis-test.invalid',
      organizationType: 'Solo practice',
      organizationSize: '5 staff',
      province: 'Ontario',
      providerCount: 1,
      locationCount: 1,
      patientCount: 2600,
      hosting: 'onprem',
      monthlyItSpend: 900,
      annualHardwareEmergency: 4000,
      downtimeHoursBand: 'under10',
      downtimeCostBand: 'under1000',
      mfa: 'yes',
      backups: 'yes',
      incidentPlan: 'no',
      lastRiskAssessment: '1-2yr',
      consent: true,
    },
  },
  {
    label: 'Professional with per-unit scaling',
    payload: {
      clinicName: 'Lakeshore Medical Group',
      contactName: 'Marcus Bell',
      jobTitle: 'Director of Operations',
      email: 'lakeshore@aeygis-test.invalid',
      organizationType: 'Multi-site group practice',
      organizationSize: '40 staff',
      province: 'Ontario',
      providerCount: 10,
      locationCount: 6,
      patientCount: 38000,
      hosting: 'mixed',
      monthlyItSpend: 11500,
      annualHardwareEmergency: 60000,
      downtimeHoursBand: '40to90',
      downtimeCostBand: '2500to5000',
      mfa: 'no',
      backups: 'no',
      incidentPlan: 'unsure',
      lastRiskAssessment: 'never',
      consent: true,
    },
  },
  {
    label: 'Enterprise -> pricing refuses, discovery call required',
    payload: {
      clinicName: 'Northern Ontario Health Network',
      contactName: 'Sandra Oyelaran',
      jobTitle: 'CIO',
      email: 'northern@aeygis-test.invalid',
      organizationType: 'Regional health network',
      organizationSize: '400 staff',
      province: 'Ontario',
      providerCount: 22,
      locationCount: 11,
      patientCount: 210000,
      hosting: 'cloud',
      monthlyItSpend: 74000,
      annualHardwareEmergency: 250000,
      downtimeHoursBand: 'over90',
      downtimeCostBand: 'over5000',
      mfa: 'yes',
      backups: 'yes',
      incidentPlan: 'yes',
      lastRiskAssessment: '1yr',
      consent: true,
    },
  },
];

console.log(`Region:   ${REGION}`);
console.log(`Endpoint: ${ENDPOINT}\n`);

const cognito = new CognitoIdentityClient({ region: REGION });
const { IdentityId } = await cognito.send(new GetIdCommand({ IdentityPoolId: POOL }));
const { Credentials } = await cognito.send(
  new GetCredentialsForIdentityCommand({ IdentityId }),
);

const aws = new AwsClient({
  accessKeyId: Credentials.AccessKeyId,
  secretAccessKey: Credentials.SecretKey,
  sessionToken: Credentials.SessionToken,
  service: 'appsync',
  region: REGION,
});

let created = 0;
for (const seed of SEEDS) {
  const response = await aws.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: MUTATION,
      variables: { payload: JSON.stringify(seed.payload) },
    }),
  });
  const body = await response.json().catch(() => ({}));
  const result = body?.data?.submitAssessment;

  if (result?.ok) {
    console.log(`  created  ${result.referenceId}  ${seed.payload.clinicName}`);
    console.log(`           ${seed.label}`);
    created += 1;
  } else {
    console.error(`  FAILED   ${seed.payload.clinicName}: ${result?.message ?? JSON.stringify(body)}`);
  }
}

console.log(`\nSeeded ${created}/${SEEDS.length} assessment(s).`);
console.log('Remove them with: npm run cleanup:tests');
