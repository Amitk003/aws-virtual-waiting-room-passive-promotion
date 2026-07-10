/**
 * Generates an ECC P-256 key pair and stores the private key in AWS Secrets Manager.
 * Run this ONCE after the first `cdk deploy`.
 *
 * Usage: node scripts/generate-key.js <secret-name> [region]
 * Example: node scripts/generate-key.js JwtSigningSecret us-east-1
 */

import * as crypto from 'node:crypto';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretName = process.argv[2];
const region = process.argv[3] || 'us-east-1';

if (!secretName) {
  console.error('Usage: node scripts/generate-key.js <secret-name> [region]');
  process.exit(1);
}

// Generate ECC P-256 key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const secretValue = JSON.stringify({
  kid: 'vwr-v1',
  privateKey: privateKey.trim(),
  publicKey: publicKey.trim(),
});

const client = new SecretsManagerClient({ region });

await client.send(new PutSecretValueCommand({
  SecretId: secretName,
  SecretString: secretValue,
}));

console.log(`Key pair generated and stored in Secrets Manager: ${secretName}`);
console.log(`Public key:\n${publicKey}`);
