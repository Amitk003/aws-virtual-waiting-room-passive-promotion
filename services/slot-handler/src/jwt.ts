import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { jwtVerify, importSPKI, decodeProtectedHeader } from 'jose';

const secretsManager = new SecretsManagerClient();

export interface JwtPayload {
  fanId: string;
  entryTimestamp: number;
  shardId: number;
  iat: number;
  exp: number;
}

let cachedPublicKey: any = null;
let cachedKid: string = '';

async function getPublicKey(secretId: string, targetKid?: string): Promise<any> {
  // Return cached key if we have one and the token's kid matches
  if (cachedPublicKey && (!targetKid || targetKid === cachedKid)) {
    return cachedPublicKey;
  }

  const result = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretId,
  }));

  const secret = JSON.parse(result.SecretString!);
  cachedPublicKey = await importSPKI(secret.publicKey, 'ES256');
  cachedKid = secret.kid || 'vwr-v1';
  return cachedPublicKey;
}

// Verifies a JWT and returns the payload. Throws on invalid/expired tokens.
// Automatically detects key rotation by comparing the token's kid against
// the cached public key's kid. If they differ, the public key is re-fetched
// from Secrets Manager, providing zero-downtime rotation.
export async function verifyJwt(
  token: string,
  signingSecretId: string
): Promise<JwtPayload> {
  const { kid } = decodeProtectedHeader(token);
  const publicKey = await getPublicKey(signingSecretId, kid);

  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['ES256'],
  });

  return {
    fanId: String(payload.fanId),
    entryTimestamp: Number(payload.entryTimestamp),
    shardId: Number(payload.shardId),
    iat: Number(payload.iat),
    exp: Number(payload.exp),
  };
}
