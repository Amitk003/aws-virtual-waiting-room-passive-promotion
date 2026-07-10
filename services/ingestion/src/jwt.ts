import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SignJWT, importPKCS8 } from 'jose';

const secretsManager = new SecretsManagerClient();

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

const KEY_ID = 'vwr-v1';

// Signs a JWT using a locally cached ECC P-256 key.
// The key is fetched from Secrets Manager once at cold start and cached
// in memory. No KMS calls happen in the hot path.
export async function signJwt(
  payload: JwtPayload,
  signingSecretId: string
): Promise<string> {
  const signingKey = await getSigningKey(signingSecretId);

  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: KEY_ID })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(signingKey);

  return token;
}
