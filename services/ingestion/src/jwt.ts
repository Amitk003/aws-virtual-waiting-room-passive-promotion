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
let cachedKid: string = '';

async function getSigningKey(secretId: string): Promise<{ key: any; kid: string }> {
  if (cachedSigningKey && cachedKid) {
    return { key: cachedSigningKey, kid: cachedKid };
  }

  const result = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretId,
  }));

  const secret = JSON.parse(result.SecretString!);
  cachedSigningKey = await importPKCS8(secret.privateKey, 'ES256');
  cachedKid = secret.kid || 'vwr-v1';
  return { key: cachedSigningKey, kid: cachedKid };
}

// Signs a JWT using a locally cached ECC P-256 key.
// The kid is read dynamically from the secret payload, enabling zero-code
// key rotation: just run scripts/rotate-key.js and the next cold start
// picks up the new kid automatically.
export async function signJwt(
  payload: JwtPayload,
  signingSecretId: string
): Promise<string> {
  const { key, kid } = await getSigningKey(signingSecretId);

  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(key);

  return token;
}
