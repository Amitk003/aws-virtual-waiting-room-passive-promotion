/**
 * Rotates the JWT signing key in Secrets Manager.
 * Generates a new ECC P-256 key pair and updates the kid version.
 * The kid is read dynamically from the secret by the Ingestion Lambda,
 * so no code update or redeploy is needed.
 *
 * Usage: node scripts/rotate-key.js <secret-name> <new-kid> [region]
 * Example: node scripts/rotate-key.js JwtSigningSecret vwr-v2 us-east-1
 */

import { generateKeyPairSync } from 'node:crypto';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretName = process.argv[2];
const newKid = process.argv[3];
const region = process.argv[4] || 'us-east-1';

if (!secretName || !newKid) {
  console.error('Usage: node scripts/rotate-key.js <secret-name> <new-kid> [region]');
  console.error('Example: node scripts/rotate-key.js JwtSigningSecret vwr-v2 us-east-1');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', {
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
console.log('Ingestion Lambda will pick up the new kid on next cold start (no redeploy needed).');
