/**
 * Rotates the JWT signing key in Secrets Manager.
 * Generates a new ECC P-256 key pair and updates the kid version.
 *
 * Usage: node scripts/rotate-key.js <secret-name> <new-kid> [region]
 * Example: node scripts/rotate-key.js JwtSigningSecret vwr-v2 us-east-1
 *
 * After rotation, the kid header in new JWTs will reference the new version.
 * Both old and new keys can coexist during the transition period (JWTs
 * issued before rotation are still valid until they expire naturally).
 */

import { crypto } from 'node:crypto';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretName = process.argv[2];
const newKid = process.argv[3];
const region = process.argv[4] || 'us-east-1';

if (!secretName || !newKid) {
  console.error('Usage: node scripts/rotate-key.js <secret-name> <new-kid> [region]');
  console.error('Example: node scripts/rotate-key.js JwtSigningSecret vwr-v2 us-east-1');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const secretValue = JSON.stringify({
  kid: newKid,
  privateKey: privateKey.trim(),
  publicKey: publicKey.trim(),
});

const client = new SecretsManagerClient({ region });

await client.send(new PutSecretValueCommand({
  SecretId: secretName,
  SecretString: secretValue,
}));

console.log(`Key rotated in Secrets Manager: ${secretName}`);
console.log(`New key ID: ${newKid}`);
console.log(`\nIMPORTANT: Update the KEY_ID constant in services/ingestion/src/jwt.ts`);
console.log(`and any verifier services to match the new kid: "${newKid}"`);
