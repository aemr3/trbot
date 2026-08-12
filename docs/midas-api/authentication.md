# Authentication protocol

This reference covers initial login, device binding, token refresh, bound-device login, and restricted-device-key login. The searchable operation index and complete compressed contract catalog are described in [graphql-operations.md](graphql-operations.md).

## Identifiers and key encodings

`deviceId` and `X-User-Agent-UID` are different stable installation identifiers:

| Value | Encoding | Reuse |
| --- | --- | --- |
| `deviceId` | UUID string, including hyphens | Persist for the device binding |
| `X-User-Agent-UID` | The UUID's 16 decoded bytes encoded as unpadded Base64url | Persist for all GraphQL and SSE requests |

The unrestricted device key is RSA-2048. Export its public key as SPKI DER, encode it with standard padded Base64 without line breaks, and retain the private key as PKCS#8 PEM or an equivalent non-exportable key-store handle. Signatures use `SHA256withRSA`, meaning SHA-256 plus RSA PKCS#1 v1.5 padding, and are sent as standard padded Base64.

The exact `X-User-Agent-UID` conversion and a test vector are in [README.md](README.md#x-user-agent-uid-encoding).

All successful token-producing operations return the same non-null object:

```ts
interface TokenPair {
  access_token: string
  refresh_token: string
}

interface LoginCompleteResponseMemberV2 {
  __typename: "LoginCompleteResponseMemberV2"
  token: TokenPair
}
```

## Initial login and device binding

1. Call `loginInitializeMemberV2` without an authorization header.
2. Persist `memberUid`, `otp.referenceCode`, and `otp.expirationSeconds`.
3. Collect the SMS `verificationCode`.
4. Generate and persist the unrestricted RSA key and `deviceId` before completing the challenge.
5. Call `loginCompleteBindDeviceV2` without an authorization header.
6. Replace the stored access and refresh tokens with the returned pair.

```ts
interface LoginInitializeVariables {
  phoneNumber: string
  password: string
}

interface LoginInitializeData {
  loginInitializeMemberV2: {
    memberUid: string
    otp: {
      __typename: string
      expirationSeconds: number
      referenceCode: string
    }
  }
}

interface LoginCompleteBindDeviceVariables {
  password: string
  referenceCode: string
  verificationCode: string
  memberId: string
  unrestrictedPublicKey: string
  restrictedPublicKey?: string | null
  biometricType: BiometricType
  deviceModel: string
  deviceId: string
}

interface LoginCompleteBindDeviceData {
  loginCompleteBindDeviceV2: LoginCompleteResponseMemberV2
}
```

The binding request sends `FINGERPRINT` for `biometricType` and `null` for `restrictedPublicKey` when it binds only the unrestricted key.

## Token refresh

Call `refreshMemberTokenV2` with the current refresh token and member UID. Treat the returned token pair as a rotation: persist both values together before making further authenticated requests. The current application reads the access-token JWT `exp` claim and refreshes when fewer than 120 seconds remain.

```ts
interface RefreshMemberTokenVariables {
  refreshToken: string
  memberId: string
}

interface RefreshMemberTokenData {
  refreshMemberTokenV2: LoginCompleteResponseMemberV2
}
```

## Bound-device password login

This flow proves possession of the unrestricted private key while also sending the password:

1. Call `retrieveLoginNonce`; it has no variables and requires no bearer token.
2. Preserve `serverTimestamp` as the GraphQL `Long` returned by the server.
3. Form the exact UTF-8 byte sequence `deviceId + phoneNumber + decimal(serverTimestamp)`. There are no separators or terminators.
4. Sign those bytes with the unrestricted private key using `SHA256withRSA`.
5. Standard-Base64 encode the signature and call `deviceBindingLoginCompleteWithPasswordV2`.

```ts
interface RetrieveLoginNonceData {
  retrieveLoginNonce: { serverTimestamp: number }
}

interface BoundDevicePasswordLoginVariables {
  memberUid: string
  deviceId: string
  phoneNumber: string
  password: string
  signingDate: number
  signature: string
}

interface BoundDevicePasswordLoginData {
  deviceBindingLoginCompleteWithPasswordV2: LoginCompleteResponseMemberV2
}
```

`signingDate` must be identical to the decimal nonce used in the signed bytes.

## Restricted-device-key registration

The restricted key is a second RSA-2048 key whose private-key use requires biometric authorization. Its key policy enables SHA-256 and SHA-512 digests, RSA PKCS#1 signature padding, user authentication, and key invalidation after biometric enrollment changes.

Registration requires an existing authenticated session:

1. Generate the restricted key pair.
2. Export `restrictedPublicKey` as standard padded Base64 of SPKI DER.
3. Form `deviceId + restrictedPublicKey + biometricType` as UTF-8 with no separators. The `biometricType` is exactly `FINGERPRINT`.
4. Sign those bytes with the unrestricted private key.
5. Call `saveRestrictedPublicKey` with a bearer token.

```ts
interface SaveRestrictedPublicKeyVariables {
  memberUid: string
  deviceId: string
  restrictedPublicKey: string
  biometricType: "FINGERPRINT"
  signature: string
}

interface SaveRestrictedPublicKeyData {
  saveRestrictedPublicKey: { noField: string | null }
}
```

## Restricted-device-key login

Restricted login uses the same nonce and signed payload as bound-device password login but omits the password:

1. Call `retrieveLoginNonce`.
2. Form `deviceId + phoneNumber + decimal(serverTimestamp)` as UTF-8.
3. Obtain biometric authorization and sign with the restricted private key.
4. Call `deviceBindingLoginCompleteV2` with the same nonce as `signingDate`.

```ts
interface RestrictedDeviceLoginVariables {
  memberUid: string
  deviceId: string
  phoneNumber: string
  signingDate: number
  signature: string
}

interface RestrictedDeviceLoginData {
  deviceBindingLoginCompleteV2: LoginCompleteResponseMemberV2
}
```

## Authentication failures and recovery

Treat HTTP `401` and `403`, and GraphQL error codes `9002`, `9008`, and `9010`, as authentication failures. The application recovery order is:

1. Use an access token while it remains outside the refresh safety window.
2. Attempt refresh when a refresh token and member UID exist.
3. Attempt bound-device password login when credentials and a bound member UID exist.
4. Start initial login and require SMS verification if recovery fails.

HTTP `429` is rate limiting, not an authentication challenge. Honor `Retry-After` when present; it may be either delta-seconds or an HTTP date. Do not log passwords, tokens, private keys, signatures, or complete authentication response bodies.
