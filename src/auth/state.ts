export interface AuthState {
  accountKey: string
  memberUid: string | null
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: number | null
  deviceId: string
  userAgentUid: string
  privateKeyPem: string
  publicKeyBase64: string
  loginReferenceCode: string | null
  createdAt: number
  updatedAt: number
}
