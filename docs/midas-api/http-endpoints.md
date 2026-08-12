# HTTP endpoints

This file covers the common GraphQL transport plus the non-GraphQL upload endpoints. All parameters shown without `?` are required. Multipart endpoints use `multipart/form-data`; the exact filename, media type, and bytes are carried by each multipart file part.

## GraphQL router

### `POST /router-graphql`

Base URL: `https://api.getmidas.com`

Authentication: bearer token for account operations; the initial login and device-binding operations are sent without it. Checksum and Apollo headers are required as documented in [README.md](README.md#graphql-transport).

```ts
interface Input {
  operationName: string
  query: string
  variables: Record<string, unknown>
}

interface Output<T> {
  data?: T
  errors?: GraphqlError[]
}
```

The exact `variables` and `data` selections for every usable operation are in the compressed catalog described by [graphql-operations.md](graphql-operations.md#complete-contract-archive).

## Multipart uploads

Base URL: `https://api.getmidas.com`

Unless a response body is shown, a successful response is empty and maps to `void`. `OnboardingStatusResponse` fields are all nullable because Midas may return a partial progress update.

```ts
interface OnboardingStatusResponse {
  step: string | null
  action: string | null
  currentStepCount: number | null
  totalStepCount: number | null
  totalOnboardingStepCount: number | null
  completedStepCount: number | null
}

interface UploadQualifiedInvestorDocumentResponse {
  uid: string
  fileUrl: string
  uploadedAt: string
  name: string
  mimeType: string
  canUpload: boolean
  canAddDocument: boolean
}
```

### `POST /onboarding-api/v1/members/phone-number/change/{phoneNumberChangeUid}/document`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `phoneNumberChangeUid` | `string` | yes |
| query | `fileType` | `string` | yes |
| multipart | `multipartFile` | binary part | yes |

Output: empty success body (`void`).

### `POST /onboarding-api/v1/members/{memberUid}/document/upload`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| query | `fileType` | `string` | yes |
| query | `fileSubType` | `string` | yes |
| multipart | `multipartFile` | binary part | yes |

Output: empty success body (`void`).

### `POST /v1/salesforce/members/{memberUid}/case/{caseId}/content-version/upload`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| path | `caseId` | `string` | yes |
| multipart | `file` | binary part | yes |

Output: empty success body (`void`).

### `POST /onboarding-api/v1/members/{memberUid}/qualified-investor/document/upload`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| multipart | `multipartFile` | binary part | yes |

Output: `UploadQualifiedInvestorDocumentResponse`.

### `POST /identity-verification-api/v1/identity-verification/{memberUid}/document/upload`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| query | `fileSubType` | `string` | yes |
| multipart text | `documentList[0].fileType` | literal `IDENTITY_FRONT` | yes |
| multipart | `documentList[0].multipartFile` | binary part | yes |
| multipart text | `documentList[1].fileType` | literal `IDENTITY_BACK` | only with the back file |
| multipart | `documentList[1].multipartFile` | binary part | no |

Output: `OnboardingStatusResponse`.

### `POST /identity-verification-api/v1/identity-verification/{memberUid}/documents`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| query | `fileType` | `string` | yes |
| multipart | `multipartFile` | binary part | yes |

Output: empty success body (`void`).

### `POST /onboarding-api/v1/members/{memberUid}/address/document`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| query | `fileSubType` | `string` | yes |
| multipart | `addressDocument` | binary part | yes |

Output: `OnboardingStatusResponse`.

### `POST /onboarding-api/v1/members/{memberUid}/company/corporate-documents`

| Location | Name | Type | Required |
| --- | --- | --- | --- |
| path | `memberUid` | `string` | yes |
| multipart | `signatureCircular` | binary part | yes |
| multipart | `shareholderIdentities` | binary part | no |

Output: `OnboardingStatusResponse`.

## Error behavior

The non-GraphQL interfaces do not define a typed error schema. Treat non-2xx bodies as opaque unless a calling service defines a separate error contract. The GraphQL router instead reports application failures through the `errors` array, even when the HTTP response itself is successful.
