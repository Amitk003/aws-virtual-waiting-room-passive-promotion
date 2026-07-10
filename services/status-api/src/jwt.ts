import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { jwtVerify, importSPKI } from 'jose';

const secretsManager = new SecretsManagerClient();

export interface JwtPayload {
  fanId: string;
  entryTimestamp: number;
  shardId: number;
  iat: number;
  exp: number;
}

let cachedPublicKey: any = null;

async function getPublicKey(secretId: string): Promise<any> {
  if (cachedPublicKey) return cachedPublicKey;

  const result = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretId,
  }));

  const secret = JSON.parse(result.SecretString!);
  cachedPublicKey = await importSPKI(secret.publicKey, 'ES256');
  return cachedPublicKey;
}

// Verifies a JWT and returns the payload. Throws on invalid/expired tokens.
export async function verifyJwt(
  token: string,
  signingSecretId: string
): Promise<JwtPayload> {
  const publicKey = await getPublicKey(signingSecretId);

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
