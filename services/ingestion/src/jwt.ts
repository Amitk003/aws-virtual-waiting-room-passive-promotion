import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SignJWT, importPKCS8 } from 'jose';

const kms = new KMSClient();
const secretsManager = new SecretsManagerClient();

function base64url(input: Uint8Array): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlString(input: string): string {
  return base64url(new TextEncoder().encode(input));
}

export interface JwtPayload {
  fanId: string;
  entryTimestamp: number;
  shardId: number;
  exp: number;
  iat: number;
}

let cachedSigningKey: any = null;

async function getSigningKey(secretId: string): Promise<any> {
  if (cachedSigningKey) return cachedSigningKey;

  const result = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretId,
  }));

  const secret = JSON.parse(result.SecretString!);
  cachedSigningKey = await importPKCS8(secret.privateKey, 'ES256');
  return cachedSigningKey;
}

// Public key ID used as the JWT 'kid' header value
let cachedKid: string | null = null;

async function getKeyId(keyId: string): Promise<string> {
  if (cachedKid) return cachedKid;

  const result = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  // Use the truncated key ARN as a stable key ID
  cachedKid = keyId.split('/').pop() || keyId;
  return cachedKid;
}

// Sign a JWT using a local ECC P-256 key (loaded from Secrets Manager)
// This avoids KMS API throttling at scale - the key is cached in Lambda
// memory after the first cold-start fetch.
export async function signJwt(
  payload: JwtPayload,
  signingSecretId: string,
  kmsKeyId: string
): Promise<string> {
  const kid = await getKeyId(kmsKeyId);
  const signingKey = await getSigningKey(signingSecretId);

  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(signingKey);

  return token;
}
