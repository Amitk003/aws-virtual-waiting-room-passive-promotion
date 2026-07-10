import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { jwtVerify, importSPKI } from 'jose';

const secretsManager = new SecretsManagerClient();
const KEY_CACHE_TTL_MS = 60000;

export interface JwtPayload {
  fanId: string;
  entryTimestamp: number;
  shardId: number;
  iat: number;
  exp: number;
}

let cachedKey: { key: any; kid: string; cachedAt: number } | null = null;

async function getPublicKey(secretId: string): Promise<{ key: any; kid: string }> {
  if (cachedKey && Date.now() - cachedKey.cachedAt < KEY_CACHE_TTL_MS) {
    return cachedKey;
  }

  const result = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretId,
  }));

  const secret = JSON.parse(result.SecretString!);
  const key = await importSPKI(secret.publicKey, 'ES256');
  const kid = secret.kid || 'vwr-v1';
  cachedKey = { key, kid, cachedAt: Date.now() };
  return cachedKey;
}

export async function verifyJwt(
  token: string,
  signingSecretId: string
): Promise<JwtPayload> {
  const { key } = await getPublicKey(signingSecretId);

  const { payload } = await jwtVerify(token, key, {
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
