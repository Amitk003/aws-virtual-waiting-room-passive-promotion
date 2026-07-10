import { KMSClient, SignCommand } from '@aws-sdk/client-kms';

const kms = new KMSClient();

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

export async function signJwt(
  payload: JwtPayload,
  keyId: string
): Promise<string> {
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyId,
  };

  const message = base64urlString(JSON.stringify(header))
    + '.'
    + base64urlString(JSON.stringify(payload));

  const result = await kms.send(new SignCommand({
    KeyId: keyId,
    Message: new TextEncoder().encode(message),
    SigningAlgorithm: 'ECDSA_SHA_256',
    MessageType: 'RAW',
  }));

  const signature = base64url(result.Signature!);
  return message + '.' + signature;
}
