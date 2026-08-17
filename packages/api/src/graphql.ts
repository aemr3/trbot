import { createHash } from "node:crypto"

export interface GraphqlOperation<
  TData = Record<string, unknown>,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string
  type: "query" | "mutation"
  operationId: string
  document: string
  readonly __data?: TData
  readonly __variables?: TVariables
}

export function defineOperation<
  TData,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
>(name: string, type: "query" | "mutation", document: string): GraphqlOperation<TData, TVariables> {
  return {
    name,
    type,
    operationId: createHash("sha256").update(document, "utf8").digest("hex"),
    document,
  }
}

interface TokenPayload {
  access_token?: string
  refresh_token?: string
}

interface LoginResponse {
  token?: TokenPayload
}

export const authOperations = {
  retrieveLoginNonce: defineOperation<
    { retrieveLoginNonce?: { serverTimestamp?: number | string } },
    Record<string, never>
  >(
    "retrieveLoginNonce",
    "query",
    "query retrieveLoginNonce { retrieveLoginNonce { serverTimestamp } }",
  ),
  loginInitializeMemberV2: defineOperation<
    { loginInitializeMemberV2?: { otp?: { expirationSeconds?: number; referenceCode?: string }; memberUid?: string } },
    { phoneNumber: string; password: string }
  >(
    "loginInitializeMemberV2",
    "mutation",
    "mutation loginInitializeMemberV2($phoneNumber: String!, $password: String!) { loginInitializeMemberV2(input: { phoneNumber: $phoneNumber password: $password } ) { otp { __typename ...otp } memberUid } }  fragment otp on Otp { expirationSeconds referenceCode }",
  ),
  loginCompleteBindDeviceV2: defineOperation<
    { loginCompleteBindDeviceV2?: LoginResponse },
    {
      password: string
      referenceCode: string
      verificationCode: string
      memberId: string
      unrestrictedPublicKey: string
      restrictedPublicKey: string | null
      biometricType: "FINGERPRINT"
      deviceModel: string
      deviceId: string
    }
  >(
    "loginCompleteBindDeviceV2",
    "mutation",
    "mutation loginCompleteBindDeviceV2($password: String!, $referenceCode: String!, $verificationCode: String!, $memberId: String!, $unrestrictedPublicKey: String!, $restrictedPublicKey: String, $biometricType: BiometricType!, $deviceModel: String!, $deviceId: String!) { loginCompleteBindDeviceV2(input: { password: $password referenceCode: $referenceCode uid: $memberId verificationCode: $verificationCode unrestrictedPublicKey: $unrestrictedPublicKey restrictedPublicKey: $restrictedPublicKey biometricType: $biometricType deviceId: $deviceId deviceModel: $deviceModel } ) { __typename ...midasAuthWithBind } }  fragment midasAuthWithBind on LoginCompleteResponseMemberV2 { token { access_token refresh_token } }",
  ),
  deviceBindingLoginCompleteWithPasswordV2: defineOperation<
    { deviceBindingLoginCompleteWithPasswordV2?: LoginResponse },
    {
      memberUid: string
      deviceId: string
      phoneNumber: string
      password: string
      signingDate: number
      signature: string
    }
  >(
    "deviceBindingLoginCompleteWithPasswordV2",
    "mutation",
    "mutation deviceBindingLoginCompleteWithPasswordV2($memberUid: String!, $deviceId: String!, $phoneNumber: String!, $password: String!, $signingDate: Long!, $signature: String!) { deviceBindingLoginCompleteWithPasswordV2(input: { memberUid: $memberUid deviceId: $deviceId phoneNumber: $phoneNumber password: $password signingDate: $signingDate signature: $signature } ) { __typename ...midasAuthWithBind } }  fragment midasAuthWithBind on LoginCompleteResponseMemberV2 { token { access_token refresh_token } }",
  ),
  refreshMemberTokenV2: defineOperation<
    { refreshMemberTokenV2?: LoginResponse },
    { refreshToken: string; memberId: string }
  >(
    "refreshMemberTokenV2",
    "mutation",
    "mutation refreshMemberTokenV2($refreshToken: String!, $memberId: String!) { refreshMemberTokenV2(memberUid: $memberId, input: { refreshToken: $refreshToken } ) { __typename ...midasAuthWithBind } }  fragment midasAuthWithBind on LoginCompleteResponseMemberV2 { token { access_token refresh_token } }",
  ),
} as const
