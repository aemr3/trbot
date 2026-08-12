# GraphQL operation reference

This searchable index lists all 574 executable operations: 355 queries and 219 mutations. It records each operation kind, required and optional variables, and response roots. The compressed catalog described below retains every exact document, operation ID, selected response field, output type, nullability rule, alias, and fragment type condition.

A variable is **required** only when its type is non-null (`!`) and it has no default. Output nullability is relative to a present parent; the top-level `data` member can still be absent when GraphQL reports errors.

## Operation ID generation

The operation ID is the lowercase hexadecimal SHA-256 digest of the exact UTF-8 GraphQL document:

```text
operationId = lowercaseHex(SHA256(UTF8(exactGraphqlDocument)))
```

Runtime variables and their values do not participate in the operation ID. Whitespace, fragment order, aliases, arguments, and selected fields are part of the document and therefore affect the digest.

```ts
import { createHash } from "node:crypto"

const document = "query example { example { id } }"
const operationId = createHash("sha256").update(document, "utf8").digest("hex")
```

The request must send that same string in `query` and the calculated digest in `x-apollo-operation-id`. The `x-api-checksum` construction is documented in [README.md](README.md#graphql-transport).

## Type notation

- `string`, `number`, and `boolean` are JSON scalar representations.
- Named types such as `InstrumentType` are enums defined in [wire-types.md](wire-types.md).
- `object` means the field's exact members follow as child response paths.
- `Array<T>` is a JSON array. The separate list-item column records whether an element may be null.
- A response path ending in `[]` addresses each element of the preceding array.

## Index

| Operation | Kind | Required variables | Optional variables | Response roots |
| --- | --- | --- | --- | --- |
| `acceptInAppMessageContracts` | mutation | `$memberId: String!`<br>`$contractIds: [String!]!`<br>`$type: ContractGroupType!` | — | `saveNewContractGroups` |
| `acceptSubscriptionCancelOffer` | mutation | `$memberId: String!`<br>`$subscriptionPublicId: String!` | — | `acceptSubscriptionCancelOffer` |
| `accountFeatureStatus` | query | `$memberUid: String!`<br>`$feature: AccountFeatureFlowType!` | `$instrumentId: String` | `accountFeatureStatus` |
| `accountMarginHealth` | query | `$accountId: String!` | — | `accountMarginHealth` |
| `accountSummaryBaseData` | query | `$memberId: String!`<br>`$accountId: String!` | — | `accountSummaryV2` |
| `accountSummaryV2` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$isCrypto: Boolean!`<br>`$shouldFetchLatestValues: Boolean!` | `$shouldFetchPDTInfo: Boolean!`<br>`$shouldFetchInfoCard: Boolean!` | `accountSummaryV2` |
| `accountViopMarginHealthDetail` | query | `$accountId: String!` | — | `accountViopMarginHealthDetail` |
| `acknowledgeMemberNotificationAlertStatus` | mutation | `$memberId: String!` | — | `acknowledgeMemberNotificationAlertStatus` |
| `activateDividendReinvestment` | mutation | `$memberId: String!` | — | `activateDividendReinvestment` |
| `activeFeatures` | query | `$memberId: String!` | — | `activeFeatures` |
| `addNotificationToken` | mutation | `$memberId: String!`<br>`$token: String!` | `$deviceNotificationPermission: Boolean` | `addNotificationToken` |
| `addToLastInteractedWatchlist` | mutation | `$instrumentId: String!` | `$orderOperationType: OrderOperationType` | `addToLastInteractedWatchlist` |
| `addToWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$instrumentId: String!` | — | `addStockToWatchlist` |
| `adoptionSurvey` | query | `$type: AdoptionSurveyType!` | — | `adoptionSurvey` |
| `advancedChart` | query | `$instrumentUid: String!` | `$selectedIndicatorIds: [String!]`<br>`$timeRange: TimeRange`<br>`$intervalId: String` | `advancedChart` |
| `aiKapNewsPage` | query | `$listingType: ListingType!`<br>`$page: Int!`<br>`$size: Int!` | — | `aiKapNewsPage` |
| `answerConformanceTestingV2` | mutation | `$memberId: String!`<br>`$version: Int!`<br>`$answers: String!`<br>`$type: ConformanceTestQuestionType!` | — | `answerConformanceTestingV2` |
| `approveTaxStatementV2` | mutation | `$memberId: String!` | — | `approveTaxStatementV2` |
| `article` | query | `$newsId: String!` | `$cryptoCurrencySymbol: String` | `article` |
| `articlesV2` | query | `$page: Int!`<br>`$pageSize: Int!`<br>`$type: ArticleTypeFilter!` | `$instrumentId: String`<br>`$isFeatured: Boolean`<br>`$assetVertical: AssetVertical`<br>`$investmentType: InvestmentType`<br>`$cryptoCurrencySymbol: String` | `articlesV2` |
| `asset` | query | `$instrumentId: String!` | `$currency: CurrencyCode` | `asset` |
| `assetFuture` | query | `$instrumentId: String!`<br>`$memberId: String!` | — | `assetFuture` |
| `assetInstrument` | query | `$instrumentId: String!`<br>`$memberId: String!` | — | `assetInstrument` |
| `assetOption` | query | `$instrumentId: String!`<br>`$memberId: String!` | — | `assetOption` |
| `assetWarrant` | query | `$instrumentId: String!`<br>`$memberId: String!` | — | `assetWarrant` |
| `availableCredit` | query | `$accountId: String!` | — | `availableCredit` |
| `availableNGroupLimit` | query | `$accountId: String!` | — | `availableNGroupLimit` |
| `brokerageDistribution` | query | `$uid: String!` | `$brokeragePosition: BrokeragePosition`<br>`$start: Date`<br>`$end: Date` | `brokerageDistribution` |
| `brokerageDistributionSummary` | query | `$uid: String!` | — | `buyer`<br>`brokerageDistribution`<br>`seller` |
| `bullBearDetails` | query | `$instrumentId: String!` | — | `bullBearDetails` |
| `bullBearSummariesList` | query | `$instrumentId: String!` | — | `bullBearSummariesList` |
| `buyingPowerV2` | query | `$vertical: AssetVertical!`<br>`$accountUid: String!` | — | `buyingPowerV2` |
| `cancelBankTransferDeposit` | mutation | `$transferId: String!`<br>`$accountId: String!` | — | `cancelBankTransferDeposit` |
| `cancelCollateral` | mutation | `$accountUid: String!`<br>`$collateralUid: String!` | `$input: CollateralCancelRequest` | `cancelCollateral` |
| `cancelCryptoWithdraw` | mutation | `$transferId: String!`<br>`$accountId: String!` | — | `cancelCryptoWithdraw` |
| `cancelExchange` | mutation | `$memberId: String!`<br>`$exchangeId: String!` | — | `cancelExchange` |
| `cancelExercise` | mutation | `$accountId: String!`<br>`$exerciseId: String!` | — | `cancelExercise` |
| `cancelInternalMoneyTransfer` | mutation | `$memberId: String!`<br>`$transferId: String!` | — | `cancelInternalMoneyTransfer` |
| `cancelNfcSession` | mutation | `$memberId: String!`<br>`$identityVerificationUid: String!` | — | `cancelNfcSession` |
| `cancelOrder` | mutation | `$accountId: String!`<br>`$orderId: String!` | `$instrumentId: String` | `cancelOrder` |
| `cancelPositionTransferDemand` | query | `$memberId: String!`<br>`$positionTransferId: String!` | — | `cancelPositionTransferDemand` |
| `cancelWithdraw` | mutation | `$transferId: String!`<br>`$accountId: String!` | — | `cancelWithdraw` |
| `candlestickChartV2` | query | `$instrumentId: String!` | `$timeRange: TimeRange`<br>`$currency: CurrencyCode` | `candlestickChartV2` |
| `cardsV3` | query | `$memberId: String!`<br>`$placement: CardPlacement!`<br>`$isLiteModeEnabled: Boolean!` | — | `cardsV3` |
| `changeCreditLimit` | mutation | `$accountId: String!`<br>`$input: CreditLimitChangeRequest!` | — | `changeCreditLimit` |
| `chartV4` | query | `$instrumentId: String!` | `$timeRange: TimeRange`<br>`$currency: CurrencyCode` | `chartV4` |
| `checkPhoneNumberForPhoneNumberChange` | mutation | `$phoneNumberChangeUid: String!`<br>`$phoneNumber: String!` | — | `checkPhoneNumberForPhoneNumberChange` |
| `checkTokenValidity` | mutation | `$memberUid: String!` | — | `checkTokenValidity` |
| `closeAccountV2` | mutation | `$memberId: String!`<br>`$reasonId: String!` | `$explanation: String`<br>`$isConfirmed: Boolean`<br>`$donationConsensus: Boolean`<br>`$app: AccountClosureApp` | `closeAccountV2` |
| `closePosition` | mutation | `$memberId: String!`<br>`$instrumentId: String!` | — | `closePosition` |
| `collateralInfo` | query | `$accountUid: String!` | — | `collateralInfo` |
| `collateralPositions` | query | `$accountId: String!`<br>`$page: Int!`<br>`$size: Int!` | — | `collateralPositions` |
| `collateralTransferReview` | query | `$memberUid: String!`<br>`$transferDirection: TransferDirection!` | — | `collateralTransferReview` |
| `commissionLevelsV4` | query | `$memberId: String!` | `$assetVertical: AssetVertical`<br>`$investmentType: InvestmentType` | `commissionLevelsV4` |
| `completeConformanceTesting` | mutation | `$memberId: String!`<br>`$approved: Boolean!`<br>`$type: ConformanceTestQuestionType!` | — | `completeConformanceTesting` |
| `completeForgotPasswordV2` | mutation | `$phoneNumber: String!`<br>`$password: String!`<br>`$confirmPassword: String!`<br>`$confirmationCode: String!` | — | `completeForgotPasswordV2` |
| `completeFractionalPositionTransferDemand` | mutation | `$memberId: String!`<br>`$instrumentId: String!`<br>`$quantity: Float!` | — | `completeFractionalPositionTransferDemand` |
| `completeLivenessSession` | mutation | `$memberId: String!`<br>`$identityVerificationUid: String!` | — | `completeLivenessSession` |
| `completeMarginPropertyDeclaration` | mutation | `$accountId: String!`<br>`$version: Int!`<br>`$answers: String!` | — | `completeMarginPropertyDeclaration` |
| `completeMemberBlockageSession` | mutation | `$memberId: String!`<br>`$memberVerificationUid: String!` | — | `completeMemberBlockageSession` |
| `completeNfcSession` | mutation | `$memberId: String!`<br>`$identityVerificationUid: String!`<br>`$nationality: String!`<br>`$firstName: String!`<br>`$lastName: String!`<br>`$identityNumber: String!`<br>`$serialNumber: String!`<br>`$base64EncodedIdentityImage: String!`<br>`$dateOfBirth: String!`<br>`$expiryDate: String!` | — | `completeNfcSession` |
| `completePhoneNumberChangeSelfServiceSessionV2` | mutation | `$identityVerificationUid: String!` | — | `completePhoneNumberChangeSelfServiceSessionV2` |
| `completePositionTransferForAll` | mutation | `$memberId: String!`<br>`$positionTransferId: String!`<br>`$brokerId: String!` | — | `completePositionTransferRequestForAllStocks` |
| `completePositionTransferForSome` | mutation | `$memberId: String!`<br>`$positionTransferId: String!`<br>`$brokerId: String!` | — | `completePositionTransferRequestForSomeStocks` |
| `completePositionTransferInsideMidas` | mutation | `$memberId: String!`<br>`$receiverName: String!`<br>`$receiverSurname: String!`<br>`$receiverPhoneNumber: String!`<br>`$selectedPositions: [PositionTransferStockSelectionV2!]!`<br>`$phoneNumber: String!`<br>`$referenceCode: String!`<br>`$verificationCode: String!` | `$reasonType: PositionTransferReasonType`<br>`$reasonExplanation: String` | `completePositionTransferInsideMidas` |
| `completeSession` | mutation | `$memberId: String!`<br>`$identityVerificationUid: String!` | — | `completeSession` |
| `completeSimBlockageSession` | mutation | `$identityVerificationUid: String!` | — | `completeSimBlockageSession` |
| `confirmOtp` | mutation | `$memberUid: String!`<br>`$input: ConfirmOtpInput!` | — | `confirmOtp` |
| `createAlert` | mutation | `$instrumentId: String!`<br>`$targetTypeOptionKey: String!`<br>`$cooldownOptionKey: String!`<br>`$targetPrice: Float!` | `$note: String` | `createAlert` |
| `createCase` | mutation | `$memberUid: String!`<br>`$input: CreateCaseRequest!` | — | `createCase` |
| `createCryptoPriceAlert` | mutation | `$memberId: String!`<br>`$cryptoId: String!`<br>`$currencyCryptoId: String!`<br>`$targetPrice: Float!` | `$initialPrice: Float`<br>`$note: String`<br>`$frequencyUid: String` | `createCryptoPriceAlert` |
| `createLivenessSession` | mutation | `$memberId: String!` | — | `createLivenessSession` |
| `createMemberBlockageSession` | mutation | `$memberId: String!`<br>`$memberVerificationUid: String!` | — | `createMemberBlockageSession` |
| `createNfcSession` | mutation | `$memberId: String!` | — | `createNfcSession` |
| `createPasswordBindDeviceV2` | mutation | `$phoneNumber: String!`<br>`$password: String!`<br>`$confirmPassword: String!`<br>`$confirmationCode: String!`<br>`$unrestrictedPublicKey: String!`<br>`$deviceId: String!`<br>`$deviceModel: String!` | `$restrictedPublicKey: String`<br>`$biometricType: BiometricType` | `createPasswordBindDeviceV2` |
| `createPhoneNumberChangeSelfServiceSession` | mutation | `$phoneNumberChangeUid: String!` | — | `createPhoneNumberChangeSelfServiceSession` |
| `createSession` | mutation | `$memberId: String!` | — | `createSession` |
| `createSimBlockageSession` | mutation | `$memberVerificationUid: String!` | — | `createSimBlockageSession` |
| `createVideoOnboardingSession` | mutation | `$memberId: String!` | `$identityVerificationFlowType: String` | `createVideoOnboardingSession` |
| `createWatchlist` | mutation | `$memberId: String!`<br>`$iconCode: String!`<br>`$name: String!` | — | `createWatchlist` |
| `creditInstantCash` | mutation | `$accountId: String!`<br>`$t1bsmvAmount: Float!`<br>`$t1commissionAmount: Float!`<br>`$t1conversionAmount: Float!`<br>`$t2bsmvAmount: Float!`<br>`$t2commissionAmount: Float!`<br>`$t2conversionAmount: Float!`<br>`$totalCreditAmount: Float!`<br>`$isContractAccepted: Boolean!`<br>`$isMarginPaymentApproved: Boolean!` | — | `creditInstantCash` |
| `creditLimitDetail` | query | `$accountId: String!` | — | `creditLimitDetail` |
| `cryptoActiveCampaigns` | query | `$memberUid: String!` | — | `cryptoActiveCampaigns` |
| `cryptoAddWatchlistPairV2` | mutation | `$memberId: String!`<br>`$cryptoId: String!`<br>`$cryptoCurrencyId: String!` | `$watchlistId: String` | `cryptoAddWatchlistPairV2` |
| `cryptoAdvancedChart` | query | `$cryptoId: String!`<br>`$selectedIndicatorIds: [String!]!` | `$currencyCryptoId: String`<br>`$timeRange: CryptoTimeRange`<br>`$intervalId: String` | `cryptoInstrument` |
| `cryptoAmendOrder` | mutation | `$memberId: String!`<br>`$orderUid: String!`<br>`$inputType: CryptoOrderBase!`<br>`$ignoreSpread: Boolean!` | `$nominalPrice: Float`<br>`$quantity: Float`<br>`$amount: Float`<br>`$limitPrice: Float`<br>`$stopOrder: CryptoStopOrder`<br>`$takeProfitOrder: CryptoStopOrder`<br>`$stopLossOrder: CryptoStopOrder`<br>`$trailingStop: CryptoTrailingStopOrder` | `cryptoAmendOrder` |
| `cryptoAmendPreparation` | query | `$memberId: String!`<br>`$orderUid: String!` | — | `cryptoAmendPreparation` |
| `cryptoAppToAppDetailPage` | query | `$memberId: String!` | `$sourcePage: String` | `cryptoAppToAppDetailPage` |
| `cryptoBalanceStatus` | query | `$memberId: String!`<br>`$currencyCryptoId: String!` | — | `cryptoBalanceStatus` |
| `cryptoCancelOrder` | mutation | `$memberId: String!`<br>`$orderId: String!` | — | `cryptoCancelOrder` |
| `cryptoCancelWaitingOrders` | mutation | `$memberId: String!`<br>`$items: [CryptoCancelOrderInput!]!` | — | `cryptoCancelWaitingOrders` |
| `cryptoCancelWithdraw` | mutation | `$memberId: String!`<br>`$transferId: String!` | — | `cryptoCancelWithdraw` |
| `cryptoCandlestickChart` | query | `$leftSymbol: String!`<br>`$rightSymbol: String!` | `$period: CryptoTimeRange` | `cryptoChart` |
| `cryptoCashBalanceDetail` | query | `$memberId: String!`<br>`$cryptoId: String!`<br>`$cryptoCurrencyId: String!` | — | `cryptoCashBalanceDetail` |
| `cryptoCategoriesV2` | query | — | `$priceSourcePage: String`<br>`$labelId: String` | `cryptoCategoriesV2` |
| `cryptoCategory` | query | `$categoryType: String!`<br>`$shouldFetchPriceChangeInfo: Boolean!`<br>`$source: String!` | `$highlightTypeId: String`<br>`$filterTypeId: String`<br>`$page: Int`<br>`$size: Int`<br>`$priceSourcePage: String` | `cryptoCategory` |
| `cryptoChart` | query | `$leftSymbol: String!`<br>`$rightSymbol: String!` | `$period: CryptoTimeRange`<br>`$sourcePage: String` | `cryptoChart` |
| `cryptoChip` | query | `$memberId: String!` | — | `cryptoChip` |
| `cryptoCommissionDetails` | query | `$memberId: String!` | — | `cryptoCommissionDetails` |
| `cryptoConvertDustPositions` | mutation | `$memberId: String!`<br>`$conversionInputs: [CryptoDustConversionInput!]!` | — | `cryptoConvertDustPositions` |
| `cryptoCreateSavedPhoneNumber` | mutation | `$memberId: String!`<br>`$phoneNumber: String!` | — | `cryptoCreateSavedPhoneNumber` |
| `cryptoCreateSavedWalletAddress` | mutation | `$memberId: String!`<br>`$networkId: String!`<br>`$address: String!`<br>`$owner: CryptoTravelRuleFormOwner!`<br>`$ownerPlatform: String!`<br>`$isUpsert: Boolean!` | `$tag: String`<br>`$ownerName: String`<br>`$ownerAddress: String` | `cryptoCreateSavedWalletAddress` |
| `cryptoCreateWatchlist` | mutation | `$memberId: String!`<br>`$iconCode: String!`<br>`$name: String!` | `$cryptoId: String`<br>`$cryptoCurrencyId: String` | `cryptoCreateWatchlist` |
| `cryptoCreateWatchlistFromReference` | mutation | `$memberId: String!`<br>`$referenceId: String!`<br>`$iconCode: String!`<br>`$name: String!` | — | `cryptoCreateWatchlistFromReference` |
| `cryptoDeleteSavedPhoneNumber` | mutation | `$memberId: String!`<br>`$phoneNumberId: String!` | — | `cryptoDeleteSavedPhoneNumber` |
| `cryptoDeleteSavedWalletAddress` | mutation | `$memberId: String!`<br>`$addressId: String!` | — | `cryptoDeleteSavedWalletAddress` |
| `cryptoDeleteWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!` | — | `cryptoDeleteWatchlist` |
| `cryptoDeposit` | query | `$memberId: String!`<br>`$assetId: String!` | — | `cryptoDeposit` |
| `cryptoDepositBoostCongratsPage` | query | `$memberId: String!` | `$campaignKey: String` | `cryptoDepositBoostCongratsPage` |
| `cryptoDepositBoostDetailPage` | query | `$memberId: String!` | `$campaignKey: String` | `cryptoDepositBoostDetailPage` |
| `cryptoDepositBoostWelcomePage` | query | `$memberId: String!` | `$sourcePage: String`<br>`$campaignKey: String` | `cryptoDepositBoostWelcomePage` |
| `cryptoDustConversionReview` | query | `$memberId: String!`<br>`$conversionInputs: [CryptoDustConversionInput!]!` | — | `cryptoDustConversionReview` |
| `cryptoDustPositions` | query | `$memberId: String!` | `$cryptoId: String` | `cryptoDustPositions` |
| `cryptoHighlightsList` | query | — | `$typeList: [CryptoHighlightSectionTypePair!]`<br>`$filterTypeId: String`<br>`$page: Int`<br>`$size: Int`<br>`$priceSourcePage: String` | `cryptoHighlightsList` |
| `cryptoHighlightsV3` | query | `$source: String!` | `$memberId: String`<br>`$highlightTypeId: String`<br>`$highlightSectionId: CryptoHighlightSectionID`<br>`$filterTypeId: String`<br>`$page: Int`<br>`$size: Int`<br>`$priceSourcePage: String` | `cryptoHighlightsV3` |
| `cryptoIndex` | query | `$indexType: CryptoIndexType!` | `$timeRange: CryptoTimeRange`<br>`$timeFrameId: Int` | `cryptoIndex` |
| `cryptoIndexes` | query | — | — | `cryptoIndexes` |
| `cryptoIndicator` | query | `$cryptoId: String!`<br>`$currencyCryptoId: String!`<br>`$indicatorId: String!` | `$timeRange: CryptoTimeRange`<br>`$intervalId: String` | `cryptoIndicator` |
| `cryptoInstrument` | query | `$memberId: String!`<br>`$cryptoId: String!` | `$currencySymbol: CryptoCashCurrency`<br>`$currencyCryptoId: String`<br>`$priceSourcePage: String` | `cryptoInstrument` |
| `cryptoInstrumentCardDetail` | query | `$cryptoId: String!` | — | `cryptoInstrumentCardDetail` |
| `cryptoInstrumentRecentTransactionsV2` | query | `$memberId: String!`<br>`$cryptoId: String!` | — | `cryptoInstrumentRecentTransactionsV2` |
| `cryptoInstrumentStatistics` | query | `$cryptoId: String!` | `$currencyCryptoId: String` | `cryptoInstrument` |
| `cryptoInstrumentTransactionsV2` | query | `$memberId: String!`<br>`$cryptoId: String!`<br>`$page: Int!`<br>`$size: Int!` | — | `cryptoInstrumentTransactionsV2` |
| `cryptoInstrumentWaitingOrders` | query | `$memberId: String!`<br>`$instrumentUid: String!`<br>`$currencyUid: String!`<br>`$orderSide: String!` | `$excludeOrderId: String` | `cryptoInstrumentWaitingOrders` |
| `cryptoInstrumentWaitingTransactionsV2` | query | `$memberId: String!`<br>`$cryptoId: String!`<br>`$sourcePage: String!` | `$page: Int`<br>`$size: Int` | `cryptoInstrumentWaitingTransactionsV2` |
| `cryptoInternalAssetTransferPlace` | mutation | `$memberId: String!`<br>`$instrumentUid: String!`<br>`$accountId: String!`<br>`$phoneNumberId: String!`<br>`$quantity: String!`<br>`$transferDescription: String!`<br>`$signature: String!`<br>`$signatureVersion: Int!`<br>`$signingDate: Long!`<br>`$deviceId: String!` | `$depositBoostPenaltyId: String`<br>`$emailOTPRefCode: String`<br>`$smsOTPRefCode: String`<br>`$passwordRefCode: String`<br>`$initialWithdrawalBlockageId: String` | `cryptoInternalAssetTransferPlace` |
| `cryptoInternalAssetTransferPrepare` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$instrumentUid: String!` | `$priceSourcePage: String` | `cryptoInternalAssetTransferPrepare` |
| `cryptoInternalAssetTransferReview` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$quantity: String!`<br>`$cryptoId: String!`<br>`$phoneNumberId: String!` | — | `cryptoInternalAssetTransferReview` |
| `cryptoInternalTransferSavedPhoneNumbers` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$instrumentUid: String!` | — | `cryptoInternalAssetTransferPrepare` |
| `cryptoMovePosition` | mutation | `$memberId: String!`<br>`$cryptoId: String!`<br>`$to: Int!` | `$cryptoType: String` | `cryptoMovePosition` |
| `cryptoMoveWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$to: Int!` | — | `cryptoMoveWatchlist` |
| `cryptoMoveWatchlistPairV2` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$cryptoId: String!`<br>`$cryptoCurrencyId: String!`<br>`$to: Int!` | — | `cryptoMoveWatchlistPairV2` |
| `cryptoOrderPreparation` | query | `$memberId: String!`<br>`$tradingPairId: String!`<br>`$transactionType: CryptoOrderSide!` | `$orderType: CryptoOrderType` | `cryptoOrderPreparation` |
| `cryptoOrderPreparationQuickSelect` | query | `$memberId: String!`<br>`$orderSide: CryptoOrderSide!`<br>`$isDefi: Boolean!` | — | `cryptoOrderPreparationQuickSelect` |
| `cryptoOverviewCashBalances` | query | `$memberId: String!` | — | `cryptoOverview` |
| `cryptoOverviewPositions` | query | `$memberId: String!`<br>`$displayPairCurrencySymbol: CryptoCashCurrency!` | `$priceSourcePage: String`<br>`$a2aSegment: String` | `cryptoOverview` |
| `cryptoPlaceOrder` | mutation | `$memberId: String!`<br>`$tradingPairId: String!`<br>`$orderSide: CryptoOrderSide!`<br>`$orderType: CryptoOrderType!`<br>`$inputType: CryptoOrderBase!`<br>`$ignoreSpread: Boolean!` | `$nominalPrice: Float`<br>`$nominalPriceStr: String`<br>`$quantity: Float`<br>`$quantityStr: String`<br>`$amount: Float`<br>`$amountStr: String`<br>`$limitPrice: Float`<br>`$stopOrder: CryptoStopOrder`<br>`$takeProfitOrder: CryptoStopOrder`<br>`$stopLossOrder: CryptoStopOrder`<br>`$trailingStop: CryptoTrailingStopOrder`<br>`$idempotencyKey: String`<br>`$signature: String`<br>`$signatureVersion: Int`<br>`$signingDate: Long`<br>`$deviceId: String` | `cryptoPlaceOrder` |
| `cryptoPosition` | query | `$memberId: String!`<br>`$cryptoId: String!` | `$currencyCryptoId: String`<br>`$a2aSegment: String` | `cryptoPosition` |
| `cryptoPostOrderQuickSelectInstruments` | query | `$memberId: String!`<br>`$currencyUid: String!` | — | `cryptoPostOrderQuickSelectInstruments` |
| `cryptoPrepareRefundAddress` | query | `$memberId: String!`<br>`$transferId: String!` | — | `cryptoPrepareRefundAddress` |
| `CryptoPriceAlertFrequencyOptions` | query | — | — | `cryptoPriceAlertsFrequencyOptions` |
| `cryptoPriceAlertsExecuted` | query | `$size: Int!` | `$cryptoId: String`<br>`$cursor: String`<br>`$priceSourcePage: String` | `cryptoPriceAlertsExecuted` |
| `cryptoPriceAlertsWaiting` | query | `$size: Int!` | `$cryptoId: String`<br>`$cursor: String`<br>`$priceSourcePage: String` | `cryptoPriceAlertsWaiting` |
| `cryptoPriceAlertUpdateStatus` | mutation | `$memberId: String!`<br>`$alertId: String!`<br>`$isActive: Boolean!` | — | `cryptoPriceAlertUpdateStatus` |
| `cryptoPriceAlertUpdateV2` | mutation | `$memberId: String!`<br>`$alertUid: String!` | `$targetPrice: Float`<br>`$initialPrice: Float`<br>`$note: String`<br>`$frequencyUid: String`<br>`$priceSourcePage: String` | `cryptoPriceAlertUpdateV2` |
| `cryptoProfitLoss` | query | `$memberUid: String!`<br>`$chartType: CryptoProfitLossChartType!` | `$timeRange: String`<br>`$currency: CryptoCashCurrency` | `cryptoProfitLoss` |
| `cryptoRemoveWatchlistPairV2` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$cryptoId: String!`<br>`$cryptoCurrencyId: String!` | — | `cryptoRemoveWatchlistPairV2` |
| `cryptoRetrieveContract` | query | `$contractType: String!` | — | `cryptoRetrieveContract` |
| `cryptoRetrieveContractDetail` | query | `$contractType: String!` | — | `cryptoRetrieveContract` |
| `cryptoRetrieveSystemStatus` | query | — | — | `cryptoRetrieveSystemStatus` |
| `cryptoReviewRefundAddress` | query | `$memberUid: String!`<br>`$transferUid: String!`<br>`$body: CryptoReviewRefundAddressInput!` | — | `cryptoReviewRefundAddress` |
| `cryptoSaveContract` | mutation | `$memberId: String!`<br>`$accountId: String!`<br>`$contractType: String!` | — | `cryptoSaveContract` |
| `cryptoStakingActivate` | mutation | `$memberId: String!`<br>`$accountId: String!` | — | `cryptoStakingActivate` |
| `cryptoStakingAssetDetail` | query | `$memberId: String!`<br>`$assetId: String!`<br>`$currencySymbol: CryptoCashCurrency!` | — | `cryptoStakingAssetDetail` |
| `cryptoStakingCancel` | mutation | `$memberId: String!`<br>`$referenceId: String!` | — | `cryptoStakingCancel` |
| `cryptoStakingDetailV2` | query | `$memberId: String!`<br>`$currencySymbol: CryptoCashCurrency!` | — | `cryptoStakingDetailV2` |
| `cryptoStakingPlace` | mutation | `$memberId: String!`<br>`$accountId: String!`<br>`$assetId: String!`<br>`$side: CryptoStakingSide!`<br>`$quantity: Float!` | — | `cryptoStakingPlace` |
| `cryptoStakingPrepare` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$assetId: String!`<br>`$side: CryptoStakingSide!` | `$priceSourcePage: String` | `cryptoStakingPrepare` |
| `cryptoStakingToggle` | mutation | `$memberId: String!`<br>`$accountId: String!`<br>`$isActive: Boolean!` | — | `cryptoStakingToggle` |
| `cryptoStakingWaitingActions` | query | `$memberId: String!` | `$assetId: String` | `cryptoStakingWaitingActions` |
| `cryptoStakingWelcomePage` | query | — | `$source: String` | `cryptoStakingWelcomePage` |
| `cryptoSubmitRefundAddress` | mutation | `$memberUid: String!`<br>`$transferUid: String!`<br>`$body: CryptoSubmitRefundAddressInput!` | — | `cryptoSubmitRefundAddress` |
| `cryptoSystemMaintenance` | query | — | — | `cryptoSystemMaintenance` |
| `cryptoTransactionDetail` | query | `$memberId: String!`<br>`$transactionId: String!` | `$accountId: String` | `cryptoTransactionDetail` |
| `cryptoTransactionFiltersV2` | query | — | — | `cryptoTransactionFiltersV2` |
| `cryptoTransactionsV2` | query | `$memberId: String!`<br>`$filters: [String!]!`<br>`$page: Int!`<br>`$size: Int!` | — | `cryptoTransactionsV2` |
| `cryptoTransferAssetsV2` | query | `$memberId: String!`<br>`$cryptoId: String!`<br>`$side: CryptoTransferSide!` | — | `cryptoTransferAssetsV2` |
| `cryptoTransferInstruments` | query | `$side: CryptoTransferSide!`<br>`$isInternal: Boolean!` | — | `cryptoTransferInstrumentsV2` |
| `cryptoTravelRuleForm` | query | `$memberId: String!`<br>`$transferUid: String!` | — | `cryptoTravelRuleForm` |
| `cryptoUpdateWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$iconCode: String!`<br>`$name: String!` | — | `cryptoUpdateWatchlist` |
| `cryptoValidateWalletAddress` | query | `$address: String!`<br>`$symbol: String!`<br>`$networkName: String!`<br>`$networkId: String!`<br>`$source: String!`<br>`$memberId: String!`<br>`$cryptoId: String!` | `$tag: String` | `cryptoValidateWalletAddress` |
| `cryptoWaitingTransactionsV2` | query | `$memberId: String!` | — | `cryptoWaitingTransactionsV2` |
| `cryptoWatchlistReferenceLink` | query | `$memberId: String!`<br>`$watchlistId: String!` | — | `cryptoWatchlistReferenceLink` |
| `cryptoWatchlists` | query | `$memberId: String!` | `$cryptoId: String`<br>`$cryptoCurrencyId: String` | `cryptoWatchlists` |
| `cryptoWatchlistV2` | query | `$memberId: String!`<br>`$watchlistId: String!`<br>`$page: Int!`<br>`$size: Int!`<br>`$shouldFetchPeriods: Boolean!` | `$period: String`<br>`$sourcePage: String`<br>`$priceSourcePage: String`<br>`$isFromShareLink: Boolean` | `cryptoWatchlistV2` |
| `cryptoWithdrawBlockage` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$cryptoId: String!` | — | `cryptoWithdrawBlockage` |
| `cryptoWithdrawNetworks` | query | `$memberId: String!`<br>`$cryptoId: String!` | — | `cryptoWithdrawNetworks` |
| `cryptoWithdrawPlace` | mutation | `$memberId: String!`<br>`$networkId: String!`<br>`$accountId: String!`<br>`$addressId: String!`<br>`$quantityStr: String!`<br>`$transferDescription: String!`<br>`$signature: String!`<br>`$signatureVersion: Int!`<br>`$signingDate: Long!`<br>`$deviceId: String!` | `$depositBoostPenaltyId: String`<br>`$emailOTPRefCode: String`<br>`$smsOTPRefCode: String`<br>`$passwordRefCode: String`<br>`$initialWithdrawalBlockageId: String` | `cryptoWithdrawPlace` |
| `cryptoWithdrawPrepare` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$networkId: String!` | `$priceSourcePage: String` | `cryptoWithdrawPrepare` |
| `cryptoWithdrawReview` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$quantity: Float!`<br>`$networkId: String!`<br>`$addressId: String!` | — | `cryptoWithdrawReview` |
| `cryptoWithdrawSavedAddresses` | query | `$memberId: String!`<br>`$accountId: String!`<br>`$networkId: String!` | — | `cryptoWithdrawPrepare` |
| `custodyNotPresentForKycOption` | mutation | `$memberId: String!` | — | `custodyNotPresentForKycOption` |
| `dayTradeOrderHistory` | query | `$accountId: String!`<br>`$dayTradeId: String!` | — | `dayTradeOrderHistory` |
| `dayTradeOrders` | query | `$accountId: String!` | — | `dayTradeOrders` |
| `decideDepositRouting` | mutation | `$accountUid: String!`<br>`$depositUid: String!`<br>`$input: DepositRoutingDecisionRequest!` | — | `decideDepositRouting` |
| `deleteAlert` | mutation | `$instrumentId: String!`<br>`$alertId: String!` | — | `deleteAlert` |
| `deleteCryptoPriceAlert` | mutation | `$memberId: String!`<br>`$priceAlertId: String!` | — | `deleteCryptoPriceAlert` |
| `deleteScreener` | mutation | `$id: String!` | — | `deleteScreener` |
| `deleteWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!` | — | `deleteWatchlist` |
| `deleteWithdrawalBankAccountByMemberUid` | mutation | `$memberId: String!`<br>`$bankAccountId: String!`<br>`$currency: CurrencyCode!` | — | `deleteWithdrawalBankAccountByMemberUid` |
| `depositRoutingOptions` | query | `$accountUid: String!`<br>`$depositUid: String!` | — | `depositRoutingOptions` |
| `detailPageV3` | query | `$id: String!`<br>`$memberId: String!`<br>`$accountId: String!`<br>`$transactionDetailType: String!` | — | `detailPageV3` |
| `deviceBindingAuthenticationWithPassword` | mutation | `$memberUid: String!`<br>`$deviceId: String!`<br>`$phoneNumber: String!`<br>`$password: String!`<br>`$signingDate: Long!`<br>`$signature: String!`<br>`$type: DeviceBindingAuthenticationType!` | — | `deviceBindingAuthenticationWithPassword` |
| `deviceBindingLoginCompleteV2` | mutation | `$memberUid: String!`<br>`$deviceId: String!`<br>`$phoneNumber: String!`<br>`$signingDate: Long!`<br>`$signature: String!` | — | `deviceBindingLoginCompleteV2` |
| `deviceBindingLoginCompleteWithPasswordV2` | mutation | `$memberUid: String!`<br>`$deviceId: String!`<br>`$phoneNumber: String!`<br>`$password: String!`<br>`$signingDate: Long!`<br>`$signature: String!` | — | `deviceBindingLoginCompleteWithPasswordV2` |
| `discoverListDetail` | query | `$page: Int!`<br>`$size: Int!`<br>`$discoverListUid: String!` | — | `discoverListDetail` |
| `discoverListPageable` | query | `$discoverCategory: DiscoverCategory!` | `$tag: DiscoverTagEnum` | `discoverListPageable` |
| `discoverySearchInitialState` | query | — | `$watchlistId: String` | `discoverySearchInitialState` |
| `dismissCard` | mutation | `$memberId: String!`<br>`$cardId: String!` | — | `dismissCard` |
| `dismissFeatureRecommendations` | mutation | `$type: FeatureRecommendationType!` | — | `dismissFeatureRecommendation` |
| `dismissMarginCard` | mutation | `$memberUid: String!`<br>`$cardId: String!` | — | `dismissMarginCard` |
| `dripDiscoverLists` | query | — | `$categoryId: String` | `dripDiscoverLists` |
| `emailChangeConfirm` | mutation | `$memberUid: String!`<br>`$emailChangeUid: String!`<br>`$input: EmailVerificationConfirmInput!` | — | `emailChangeConfirm` |
| `emailChangeInitialize` | mutation | `$memberUid: String!`<br>`$input: EmailChangeInitializeInput!` | — | `emailChangeInitialize` |
| `emailChangeInitializeWithPassword` | mutation | `$memberUid: String!`<br>`$input: EmailChangeInitializeWithPasswordInput!` | — | `emailChangeInitializeWithPassword` |
| `emailChangeResendOtp` | mutation | `$memberUid: String!`<br>`$emailChangeUid: String!`<br>`$referenceCode: String!` | — | `emailChangeResendOtp` |
| `emailChangeSendOtp` | mutation | `$memberUid: String!`<br>`$emailChangeUid: String!`<br>`$input: EmailChangeSendOtpInput!` | — | `emailChangeSendOtp` |
| `emailVerificationConfirm` | mutation | `$memberUid: String!`<br>`$input: EmailVerificationConfirmInput!` | — | `emailVerificationConfirm` |
| `emailVerificationInitialize` | mutation | `$memberUid: String!` | — | `emailVerificationInitialize` |
| `emailVerificationResendOtp` | mutation | `$memberUid: String!`<br>`$referenceCode: String!` | — | `emailVerificationResendOtp` |
| `enrollToCampaign` | mutation | `$memberId: String!`<br>`$campaignId: String!` | — | `enrollToCampaign` |
| `exchangeRatesV2` | query | — | `$rateExpandList: [ExchangeRateExpandType!]` | `exchangeRatesV2` |
| `exchangeSummaryV3` | query | `$memberId: String!`<br>`$fxRateId: String!`<br>`$amount: Float!`<br>`$fxPair: CurrencyPair!`<br>`$fxType: ExchangeOperationType!` | — | `exchangeSummaryV3` |
| `exchangeV3` | mutation | `$memberId: String!`<br>`$fxRateId: String!`<br>`$amount: Float!`<br>`$fxPair: CurrencyPair!`<br>`$fxType: ExchangeOperationType!` | — | `exchangeV3` |
| `exercisePreparation` | query | `$optionId: String!`<br>`$accountId: String!` | — | `exercisePreparation` |
| `expireQualifiedInvestorDocument` | mutation | `$memberUid: String!`<br>`$docUid: String!` | — | `expireQualifiedInvestorDocument` |
| `exploreScreenersV2` | query | `$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!` | — | `exploreScreenersV2` |
| `finalizeQualifiedInvestorDocumentUpload` | mutation | `$memberUid: String!` | — | `finalizeQualifiedInvestorDocumentUpload` |
| `footerAgreements` | query | `$genericGroupKey: FooterAgreementsGenericGroupKey!` | — | `footerAgreements` |
| `footerAgreementsForMember` | query | `$memberId: String!`<br>`$genericGroupKey: FooterAgreementsGenericGroupKey!` | — | `footerAgreementsForMember` |
| `futureDetail` | query | `$instrumentUid: String!` | — | `futureDetail` |
| `futurePicker` | query | `$instrumentUid: String!` | — | `futurePicker` |
| `getActiveProAnalysis` | query | `$instrumentUid: String!`<br>`$advancedTool: AdvancedTool!` | `$startDate: Date`<br>`$endDate: Date` | `getActiveProAnalysisV2` |
| `getAdvancedChartInstrumentInfo` | query | `$instrumentId: String!`<br>`$memberId: String!` | — | `instrument` |
| `getAlertOptions` | query | `$instrumentId: String!` | `$targetTypeOptionKey: String`<br>`$cooldownOptionKey: String` | `getAlertOptions` |
| `getAlertsByInvestmentType` | query | `$size: Int!` | `$investmentType: InvestmentType`<br>`$cursor: String` | `getAlertsByInvestmentType` |
| `getApartments` | query | `$memberId: String!`<br>`$buildingId: String!` | — | `apartment` |
| `getArticlesBatch` | query | `$articleIds: [String!]!` | `$instrumentIds: [String!]`<br>`$cryptoInstrumentIds: [String!]`<br>`$cryptoCurrencySymbol: String` | `getArticlesBatch` |
| `getBuildings` | query | `$memberId: String!`<br>`$streetId: String!` | — | `building` |
| `getCampaignHeroBanner` | query | `$memberId: String!` | — | `getCampaignHeroBanner` |
| `getCardDetail` | query | `$uid: String!` | — | `getCardDetail` |
| `getChips` | query | — | — | `meV7` |
| `getCities` | query | `$memberId: String!` | — | `cityV2` |
| `getCommunicationPermissions` | query | — | — | `meV7` |
| `getDistricts` | query | `$memberId: String!`<br>`$cityId: String!` | — | `districtV2` |
| `getExecutedAlertsByInvestmentType` | query | `$size: Int!` | `$investmentType: InvestmentType`<br>`$cursor: String` | `getExecutedAlertsByInvestmentType` |
| `getExploreList` | query | `$exploreListId: String!`<br>`$page: Int!`<br>`$pageSize: Int!` | — | `exploreList` |
| `getFeatureRecommendations` | query | `$type: FeatureRecommendationType!` | — | `getFeatureRecommendations` |
| `getFeedbackDetailSuggestions` | query | — | — | `getFeedbackDetailSuggestions` |
| `getInAppMessageContracts` | query | `$memberId: String!`<br>`$type: ContractGroupType!` | — | `newContractGroupV2` |
| `getInstrument` | query | `$instrumentId: String!` | — | `instrument` |
| `getInstrumentAlertsByInvestmentType` | query | `$investmentType: InvestmentType!`<br>`$instrumentId: String!`<br>`$size: Int!` | `$cursor: String` | `getInstrumentAlertsByInvestmentType` |
| `getInstrumentExecutedAlertsByInvestmentType` | query | `$instrumentId: String!`<br>`$size: Int!` | `$investmentType: InvestmentType`<br>`$cursor: String` | `getInstrumentExecutedAlertsByInvestmentType` |
| `getInstrumentMaintenanceMode` | query | `$instrumentId: String!` | — | `instrument` |
| `getMarketIndices` | query | — | — | `marketDetailedSummary` |
| `getMemberContract` | query | `$memberId: String!`<br>`$contractId: String!` | — | `memberContract` |
| `getMemberContracts` | query | `$memberId: String!` | — | `memberContracts` |
| `getMemberForms` | query | `$memberId: String!` | — | `memberRiskForms` |
| `getMemberNotificationAlertStatus` | query | `$memberId: String!` | — | `getMemberNotificationAlertStatus` |
| `getMemberNotificationGroupDetails` | query | `$memberId: String!`<br>`$groupId: String!`<br>`$size: Int!` | `$cursor: Long` | `getMemberNotificationGroupDetails` |
| `getMemberNotificationSetting` | query | `$memberId: String!` | — | `getMemberNotificationSetting` |
| `getMemberNotificationSettingDetail` | query | `$memberId: String!`<br>`$categoryKey: String!` | — | `getMemberNotificationSettingDetail` |
| `getMemberPushNotificationsV2` | query | `$memberId: String!`<br>`$size: Int!` | `$cursor: Long` | `getMemberPushNotificationsV2` |
| `getNeighborhoods` | query | `$memberId: String!`<br>`$districtId: String!` | — | `neighborhoodV2` |
| `getOrder` | query | `$accountId: String!`<br>`$orderId: String!` | — | `orderV2` |
| `getPabStocks` | query | `$stockUid: String!` | — | `getPabStocks` |
| `getPaidAdvancedToolsResult` | query | `$instrumentId: String!` | — | `instrument` |
| `getPendingBuyOrders` | query | `$accountId: String!` | — | `accountSummaryV2` |
| `getPositionTransferBrokers` | query | `$memberId: String!` | — | `positionTransferRequestSupport` |
| `getPositionTransferOutForm` | query | `$memberId: String!`<br>`$positionTransferType: PositionTransferType!`<br>`$receiverName: String!`<br>`$receiverSurname: String!`<br>`$receiverAccountNo: String!`<br>`$selectedPositions: [PositionTransferStockSelectionV2!]!` | `$receiverTckn: String`<br>`$receiverBrokerName: String`<br>`$receiverBrokerCode: String` | `memberContractForPositionTransferV3` |
| `getPositionTransferStepsData` | query | `$memberId: String!` | — | `positionTransferInfo` |
| `getRecommendations` | query | `$memberId: String!` | `$offset: String` | `getRecommendations` |
| `getReconciliation` | query | `$memberId: String!` | — | `retrieveReconciliationForDeepLink` |
| `getSalesforceCustomerIdentityToken` | query | `$memberUid: String!` | — | `getSalesforceCustomerIdentityToken` |
| `getSearchItems` | query | — | `$instrumentIds: [String!]`<br>`$instrumentListIds: [String!]`<br>`$cryptoPairs: [CryptoPairSearchRequest!]`<br>`$watchlistId: String` | `getSearchItems` |
| `getStatements` | query | `$accountId: String!`<br>`$page: Int!`<br>`$pageSize: Int!` | — | `retrieveStatements` |
| `getStory` | query | `$memberUid: String!`<br>`$type: StoryType!` | `$uid: String` | `getStory` |
| `getStreets` | query | `$memberId: String!`<br>`$neighborhoodId: String!` | — | `street` |
| `getSupportCategories` | query | — | — | `getSupportCategories` |
| `getTargetingCard` | query | `$memberId: String!`<br>`$placement: CardPlacement!` | — | `getTargetingCard` |
| `getTransferablePositions` | query | `$memberId: String!` | — | `positionsAvailableForTransfer` |
| `getTrInterestIncomeInfo` | query | `$accountId: String!` | — | `accountSummaryV2` |
| `getWatchlistIconSections` | query | — | — | `retrieveIconCategories` |
| `getWatchlistRecommendations` | query | `$shouldFetchCryptoExtras: Boolean!` | `$watchlistId: String`<br>`$type: String`<br>`$source: String` | `getWatchlistRecommendations` |
| `giveMasterpassCardConsent` | mutation | `$request: GiveMasterpassCardConsentRequest!` | — | `giveMasterpassCardConsent` |
| `grantReward` | mutation | `$memberId: String!`<br>`$campaignKey: CampaignKey!` | — | `grantReward` |
| `groupedContractsV4` | query | `$memberId: String!` | — | `groupedContractsV4` |
| `highlightsV3` | query | `$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!`<br>`$isExpanded: Boolean!` | `$categoryId: String` | `highlightsV3` |
| `inAppMessages` | query | `$memberId: String!` | — | `inAppMessages` |
| `incomeFields` | query | — | — | `incomeFields` |
| `indicator` | query | `$instrumentId: String!`<br>`$indicatorId: String!` | `$timeRange: TimeRange`<br>`$intervalId: String` | `indicator` |
| `initializeForgotPasswordV3` | mutation | `$phoneNumber: String!`<br>`$identityNumber: String!`<br>`$birthDate: Date!` | — | `initializeForgotPasswordV3` |
| `initializePhoneNumberChange` | mutation | `$currentPhoneNumber: String!`<br>`$identityNumber: String!`<br>`$birthDate: Date!` | — | `initializePhoneNumberChange` |
| `initializePhoneNumberChangeAccountRecovery` | mutation | `$memberUid: String!`<br>`$currentPhoneNumber: String!`<br>`$identityNumber: String!`<br>`$birthDate: Date!` | — | `initializePhoneNumberChangeAccountRecovery` |
| `initializeSimBlockage` | mutation | `$memberUid: String!` | — | `initializeSimBlockage` |
| `initializeSimBlockageWithIdentity` | mutation | `$phoneNumber: String!`<br>`$identityNumber: String!`<br>`$birthDate: Date!` | — | `initializeSimBlockageWithIdentity` |
| `initializeSimBlockageWithPassword` | mutation | `$phoneNumber: String!`<br>`$password: String!` | — | `initializeSimBlockageWithPassword` |
| `initiateSignatoryDeliveries` | mutation | `$memberUid: String!`<br>`$input: InitiateContractDeliveryRequest!` | — | `initiateSignatoryDeliveries` |
| `initMasterpass` | mutation | `$memberId: String!` | — | `initMasterpass` |
| `initPositionTransfer` | mutation | `$memberId: String!` | — | `initPositionTransferRequest` |
| `initPositionTransferOut` | mutation | `$memberId: String!`<br>`$phoneNumber: String!` | — | `initializePositionTransferOtp` |
| `instrumentBaseData` | query | `$instrumentId: String!`<br>`$isConverted: Boolean!` | `$currency: CurrencyCode` | `instrument` |
| `instrumentCircuitBreaker` | query | `$instrumentId: String!` | — | `instrument` |
| `instrumentThemeDetailV2` | query | `$id: String!`<br>`$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!` | `$order: InstrumentItemListingOrderType`<br>`$timeRange: TimeRange`<br>`$page: Int`<br>`$size: Int` | `instrumentThemeDetailV2` |
| `instrumentThemesV2` | query | `$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!` | — | `instrumentThemesV2` |
| `instrumentTradePriceV2Decoupled` | query | `$instrumentId: String!` | — | `instrument` |
| `ipoCenter` | query | — | `$country: Country`<br>`$ipoType: IpoType` | `ipoCenter`<br>`ipoCenterArticles` |
| `ipoInfoPages` | query | — | — | `ipoInfoPages` |
| `iposV2` | query | `$assetVertical: AssetVertical!` | — | `iposV2` |
| `latestMarketOutlookInfo` | query | — | — | `retrieveLatestMarketOutlookInfo` |
| `livenessConsentGroupedContracts` | query | `$memberId: String!` | — | `livenessConsentGroupedContracts` |
| `loginCompleteBindDeviceV2` | mutation | `$password: String!`<br>`$referenceCode: String!`<br>`$verificationCode: String!`<br>`$memberId: String!`<br>`$unrestrictedPublicKey: String!`<br>`$biometricType: BiometricType!`<br>`$deviceModel: String!`<br>`$deviceId: String!` | `$restrictedPublicKey: String` | `loginCompleteBindDeviceV2` |
| `loginInitializeMemberV2` | mutation | `$phoneNumber: String!`<br>`$password: String!` | — | `loginInitializeMemberV2` |
| `logoutMember` | mutation | `$memberId: String!` | — | `logoutMember` |
| `marginCreditInfoV2` | query | `$instrumentId: String!`<br>`$country: Country!` | — | `marginCreditInfoV2` |
| `marginDetails` | query | `$accountId: String!` | — | `marginDetails` |
| `marginInfo` | query | `$accountId: String!` | — | `marginInfo` |
| `marginInterestDetails` | query | `$accountId: String!` | — | `marginInterestDetails` |
| `marginInterestRateCalculator` | query | `$accountId: String!` | `$currency: CurrencyCode` | `marginInterestRateCalculator` |
| `marginInterestRateLevels` | query | `$accountId: String!` | — | `marginInterestRateLevels` |
| `marginInterestRateLevelsForLottie` | query | — | — | `marginInterestRateLevelsForLottie` |
| `marginInvestmentV3` | query | `$accountId: String!` | — | `marginInvestmentV3` |
| `marginOnboardingEntry` | query | `$accountId: String!` | `$source: MarginOnboardingSource`<br>`$currency: CurrencyCode` | `marginOnboardingEntry` |
| `marginOnboardingFlow` | query | — | `$source: MarginOnboardingSource`<br>`$currency: CurrencyCode` | `marginOnboardingFlow` |
| `marginPropertyDeclarationQuestions` | query | `$accountId: String!` | — | `marginPropertyDeclarationQuestions` |
| `marginStateCards` | query | `$memberId: String!` | — | `marginStateCards` |
| `markAllPushNotificationsAsReadV2` | mutation | `$memberId: String!` | `$groupId: String` | `markAllPushNotificationsAsReadV2` |
| `marketCalendar` | query | `$countryCode: String!` | — | `marketCalendar` |
| `marketOutlook` | query | `$uid: String!` | — | `retrieveMarketOutlook` |
| `markPushNotificationAsRead` | mutation | `$memberId: String!`<br>`$notificationUid: String!` | — | `markPushNotificationAsRead` |
| `memberCommissionDetailsV3` | query | `$memberId: String!` | — | `memberCommissionDetailsV3` |
| `memberContractForInsideMidas` | query | `$memberId: String!`<br>`$receiverName: String!`<br>`$receiverSurname: String!`<br>`$receiverPhoneNumber: String!`<br>`$selectedPositions: [PositionTransferStockSelectionV2!]!` | — | `memberContractForInsideMidas` |
| `memberFeatures` | query | `$memberUid: String!` | — | `memberFeatures` |
| `memberIdentityVerificationStep` | query | `$memberId: String!` | `$identityVerificationFlowType: String` | `memberIdentityVerificationStep` |
| `memberInvestmentTypesV2` | query | `$memberId: String!` | — | `memberInvestmentTypesV2` |
| `meV7` | query | — | — | `meV7` |
| `meV7AfterTokenRefresh` | query | — | — | `meV7` |
| `midasDepositBankAccountsV4` | query | `$memberId: String!`<br>`$platform: MidasPlatform!`<br>`$currency: CurrencyCode!` | — | `midasDepositBankAccountsV4` |
| `midasWithdrawalBanks` | query | `$currency: CurrencyCode!`<br>`$platform: MidasPlatform!` | — | `midasWithdrawalBanks` |
| `moveInWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$instrumentId: String!`<br>`$to: Int!` | — | `relocateStockInsideWatchlist` |
| `moveList` | mutation | `$listId: String!`<br>`$to: Int!` | — | `moveList` |
| `movePosition` | mutation | `$accountId: String!`<br>`$instrumentId: String!`<br>`$to: Int!` | — | `movePosition` |
| `movingInstrumentNewsPage` | query | `$category: InstrumentCategory!`<br>`$page: Int!`<br>`$pageSize: Int!` | — | `movingInstrumentNewsPage` |
| `movingInstrumentNewsUnique` | query | `$category: InstrumentCategory!` | — | `movingInstrumentNewsUnique` |
| `onboardingFlowV3` | query | `$memberId: String!` | `$memberType: MemberType` | `onboardingFlowV3` |
| `onboardingFlowV4` | query | `$memberId: String!` | `$memberType: MemberType` | `onboardingFlowV4` |
| `optionActivePriceAlert` | query | `$optionId: String!`<br>`$memberId: String!` | — | `optionPreview` |
| `optionChain` | query | `$instrumentId: String!` | `$optionType: OptionType`<br>`$selectedColumnIds: [String!]`<br>`$expiryDate: Date`<br>`$orderType: OptionOrderType` | `optionChain` |
| `optionPositionsDetails` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `optionPositionsDetails` |
| `optionPreview` | query | `$optionId: String!` | `$orderType: OptionOrderType` | `optionPreview` |
| `optionSimulateMyReturns` | query | `$optionUid: String!` | `$orderType: OptionOrderType` | `optionSimulateMyReturns` |
| `optionStrategyBuilder` | query | `$instrumentId: String!` | — | `optionStrategyBuilder` |
| `overviewPositionsV2` | query | `$memberId: String!`<br>`$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!` | — | `overviewPositionsV2` |
| `overviewV7` | query | `$memberId: String!`<br>`$currencyCode: CurrencyCode!` | `$period: ProfitLossTimeRange` | `overviewV7` |
| `overwriteTravelRuleForm` | mutation | `$memberUid: String!`<br>`$transferUid: String!`<br>`$form: CryptoTravelRuleFormInput!` | — | `overwriteTravelRuleForm` |
| `pendingDepositsSummary` | query | `$accountId: String!` | — | `pendingDepositsSummary` |
| `pendingSettlementTransactions` | query | `$accountId: String!` | — | `pendingSettlementTransactions` |
| `performance` | query | `$instrumentId: String!` | `$timeRange: TimeRange` | `performance` |
| `placeExercise` | mutation | `$accountId: String!`<br>`$optionId: String!`<br>`$quantity: Float!` | `$underlyingInstrumentPrice: Float` | `placeExercise` |
| `placeOrder` | mutation | `$instrumentId: String!`<br>`$accountId: String!`<br>`$orderSide: OrderSide!`<br>`$orderType: OrderType!` | `$quantity: Float`<br>`$notional: Float`<br>`$price: Float`<br>`$stopPrice: Float`<br>`$limitPrice: Float`<br>`$profitPrice: Float`<br>`$profitRate: Float`<br>`$lossPrice: Float`<br>`$lossRate: Float`<br>`$isProfitByRatio: Boolean`<br>`$isLossByRatio: Boolean`<br>`$timeInForce: TimeInForce`<br>`$agreementType: String`<br>`$shouldPlaceInExtendedHours: Boolean`<br>`$endingDate: Date`<br>`$investmentType: InvestmentType`<br>`$positionIntent: PositionIntent` | `placeOrderV2` |
| `positionTransferDemandPreperation` | query | `$memberId: String!`<br>`$positionTransferType: PositionTransferType!` | `$instrumentId: String` | `positionTransferDemandPreparation` |
| `positionTransferReasons` | query | — | — | `positionTransferReasons` |
| `prepareConversion` | query | `$couponId: String!`<br>`$accountId: String!` | — | `rightPreparation` |
| `prepareOrder` | query | `$instrumentId: String!`<br>`$accountId: String!`<br>`$orderSide: OrderSide!` | `$orderId: String`<br>`$orderType: OrderType`<br>`$positionIntent: PositionIntent` | `orderPreparationV2` |
| `prepareUpdateMarginLimit` | query | `$accountId: String!` | — | `prepareUpdateMarginLimit` |
| `preRegistrationGroupedContracts` | query | — | — | `preRegistrationGroupedContracts` |
| `profitLossV2` | query | `$memberId: String!`<br>`$currency: CurrencyCode!` | `$timeRange: PortfolioPerformanceTimeRange`<br>`$chartType: PortfolioPerformanceChartType` | `profitLossV2` |
| `putMembersNotificationSettingCategoryOption` | mutation | `$memberId: String!`<br>`$categoryKey: String!`<br>`$status: Boolean!` | — | `putMembersNotificationSettingCategoryOption` |
| `putMembersNotificationSettingCategorySectionOption` | mutation | `$memberId: String!`<br>`$categoryKey: String!`<br>`$sectionKey: String!`<br>`$optionKey: String!` | — | `putMembersNotificationSettingCategorySectionOption` |
| `qualifiedInvestorDocumentReview` | query | `$memberUid: String!` | — | `qualifiedInvestorDocumentReview` |
| `realizedOrder` | query | `$memberId: String!`<br>`$orderId: String!` | — | `realizedOrder` |
| `recordTimeIntervalSuggestion` | mutation | `$timeSpan: TimeSpan!`<br>`$multiplier: Int!`<br>`$timeRange: TimeRange!` | — | `recordTimeIntervalSuggestion` |
| `refreshMemberTokenV2` | mutation | `$refreshToken: String!`<br>`$memberId: String!` | — | `refreshMemberTokenV2` |
| `registerMemberV7` | mutation | `$phoneNumber: String!`<br>`$referenceCode: String!`<br>`$verificationCode: String!` | `$groupKeys: [String]` | `registerMemberV7` |
| `rememberLater` | mutation | `$memberId: String!`<br>`$identityVerificationUid: String!` | — | `rememberLater` |
| `removeFromWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$instrumentId: String!` | — | `removeStockFromWatchlist` |
| `removePdtRestriction` | mutation | `$accountId: String!` | — | `removePdtRestriction` |
| `resendCodeV2` | mutation | `$phoneNumber: String!`<br>`$referenceCode: String!`<br>`$verificationType: VerificationType!` | — | `resendCodeV2` |
| `resendCreditReportPin` | mutation | `$memberUid: String!` | — | `resendCreditReportPin` |
| `resendOtp` | mutation | `$memberUid: String!`<br>`$input: ResendOtpInput!` | — | `resendOtp` |
| `resendOtpCode` | mutation | `$phoneNumberChangeUid: String!`<br>`$phoneNumber: String!`<br>`$referenceCode: String!` | — | `resendOtpCode` |
| `resendPositionTransferOutCode` | mutation | `$phoneNumber: String!`<br>`$referenceCode: String!` | — | `resendCodeV2` |
| `resetPasswordV5` | mutation | `$password: String!`<br>`$confirmPassword: String!`<br>`$confirmationCode: String!`<br>`$memberId: String!` | — | `resetPasswordV5` |
| `retrieveAccountCashDetail` | query | `$memberId: String!`<br>`$currency: CurrencyCode!`<br>`$platform: MidasPlatform!` | — | `retrieveAccountCashDetail` |
| `retrieveAccountClosureConfirmation` | query | `$memberUid: String!` | `$app: AccountClosureApp` | `retrieveAccountClosureConfirmation` |
| `retrieveAccountClosureMidasPro` | query | `$memberUid: String!` | — | `retrieveAccountClosureMidasPro` |
| `retrieveAccountClosurePrivileges` | query | `$memberId: String!` | `$app: AccountClosureApp` | `retrieveAccountClosurePrivileges` |
| `retrieveAccountClosureReasonsV2` | query | `$memberId: String!` | — | `retrieveAccountClosureReasonsV2` |
| `retrieveAccountClosureSteps` | query | `$memberUid: String!` | — | `retrieveAccountClosureSteps` |
| `retrieveAccountClosureValidationsV2` | query | `$memberUid: String!` | `$app: AccountClosureApp` | `retrieveAccountClosureValidationsV2` |
| `retrieveAnsweredConformanceRiskProducts` | mutation | `$memberId: String!` | — | `retrieveAnsweredConformanceRiskProducts` |
| `retrieveBarcodeFeatureStatus` | query | `$memberUid: String!` | — | `retrieveBarcodeFeatureStatus` |
| `retrieveCampaignSubDetail` | query | `$memberId: String!`<br>`$campaignId: String!`<br>`$detailId: String!` | — | `retrieveCampaignSubDetail` |
| `retrieveCities` | query | — | — | `retrieveCities` |
| `retrieveCompanyFinancialInformationV2` | query | — | — | `retrieveCompanyFinancialInformationV2` |
| `retrieveConformanceTestingQuestions` | query | `$memberId: String!`<br>`$version: Int!`<br>`$type: ConformanceTestQuestionType!` | — | `retrieveConformanceTestingQuestions` |
| `retrieveContractContent` | query | `$memberId: String!`<br>`$contractTemplateType: ContractTemplateType!` | — | `retrieveContractContent` |
| `retrieveContractGroupApprovalStatus` | query | `$memberUid: String!`<br>`$groupKey: String!`<br>`$input: ContractGroupApprovalStatusRequest!` | — | `retrieveContractGroupApprovalStatus` |
| `retrieveContractPage` | query | `$memberId: String!`<br>`$groupKey: String!` | — | `retrieveContractPage` |
| `retrieveContractPageInfo` | query | `$memberId: String!`<br>`$contractType: ContractType!` | — | `retrieveContractPageInfo` |
| `retrieveContractSign` | query | `$memberId: String!` | — | `retrieveContractSign` |
| `retrieveContractSignatories` | query | `$memberUid: String!` | — | `retrieveContractSignatories` |
| `retrieveCorporateDeliveryInfo` | query | `$memberId: String!` | — | `retrieveCorporateDeliveryInfo` |
| `retrieveCountries` | query | — | `$filter: CountryFilter` | `retrieveCountries` |
| `retrieveCountryCallingCodes` | query | `$callingCodeFilterType: CallingCodeFilterType!` | — | `retrieveCountryCallingCodes` |
| `retrieveCustomerSupportArticle` | query | `$articleId: String!` | — | `retrieveCustomerSupportArticle` |
| `retrieveCustomerSupportItems` | query | `$categoryId: String!` | — | `retrieveCustomerSupportItems` |
| `retrieveDevices` | query | `$memberUid: String!` | — | `retrieveDevices` |
| `retrieveDigestDetail` | query | `$digestUid: String!` | — | `retrieveDigestDetail` |
| `retrieveDigestDetailOfInstrument` | query | `$instrumentUid: String!` | — | `retrieveDigestDetailOfInstrument` |
| `retrieveDigestSummaryOfInstrument` | query | `$instrumentId: String!` | — | `retrieveDigestSummaryOfInstrument` |
| `retrieveDividendReinvestmentPreferences` | query | `$memberId: String!` | — | `retrieveDividendReinvestmentPreferences` |
| `retrieveDynamicLists` | query | — | — | `retrieveDynamicLists` |
| `retrieveExchangeAccountCashDetail` | query | `$memberId: String!`<br>`$currency: CurrencyCode!` | — | `retrieveExchangeAccountCashDetail` |
| `retrieveFeatureOnboardingFlow` | query | `$memberId: String!`<br>`$type: FeatureOnboardingFlowType!` | — | `retrieveFeatureOnboardingFlow` |
| `retrieveFeatureOnboardingStatus` | query | `$memberId: String!`<br>`$type: FeatureOnboardingFlowType!` | — | `retrieveFeatureOnboardingStatus` |
| `retrieveFxComplianceMessage` | query | `$memberId: String!` | — | `retrieveFxComplianceMessage` |
| `retrieveGroupedContracts` | mutation | `$memberId: String!`<br>`$groupKeys: [String!]!` | — | `retrieveGroupedContracts` |
| `retrieveIdentityType` | query | `$memberUid: String!` | — | `retrieveIdentityType` |
| `retrieveInitialSignatory` | query | `$memberId: String!` | — | `retrieveInitialSignatory` |
| `retrieveInstantCashParamsV2` | query | `$accountId: String!` | — | `retrieveInstantCashParamsV2` |
| `retrieveInstrumentListItemsV3` | query | `$uid: String!` | `$page: Int`<br>`$size: Int`<br>`$timeRange: String`<br>`$vertical: String`<br>`$display: String` | `retrieveInstrumentListItemsV3` |
| `retrieveInstrumentListItemsV4` | query | `$uid: String!` | `$page: Int`<br>`$size: Int`<br>`$vertical: String`<br>`$display: String`<br>`$timeRange: String`<br>`$sortType: String` | `retrieveInstrumentListItemsV4` |
| `retrieveInterestBadgeInfo` | query | `$memberId: String!` | — | `retrieveInterestBadgeInfo` |
| `retrieveInterestIntro` | query | `$memberUid: String!`<br>`$currency: CurrencyCode!` | — | `retrieveInterestIntro` |
| `retrieveInterestPreInfo` | query | `$memberUid: String!` | `$showContract: Boolean`<br>`$currency: CurrencyCode` | `retrieveInterestPreInfo` |
| `retrieveLatestPendingDepositDescription` | query | `$memberUid: String!` | — | `retrieveLatestPendingDepositDescription` |
| `retrieveListsMetadata` | query | — | — | `retrieveListsMetadata` |
| `retrieveLoginNonce` | query | — | — | `retrieveLoginNonce` |
| `retrieveMajorShareholderStatus` | query | `$memberId: String!` | — | `retrieveMajorShareholderStatus` |
| `retrieveMaskedAddress` | query | `$memberId: String!` | — | `retrieveMaskedAddress` |
| `retrieveMemberAwardDeliveryInfoPage` | query | `$memberId: String!`<br>`$campaignId: String!` | — | `retrieveMemberAwardDeliveryInfoPage` |
| `retrieveMemberBasicInfo` | query | `$memberId: String!` | — | `retrieveMemberBasicInfo` |
| `retrieveMemberCampaignActivities` | query | `$memberId: String!`<br>`$campaignId: String!` | `$pageToken: String` | `retrieveMemberCampaignActivities` |
| `retrieveMemberCampaignPage` | query | `$memberId: String!`<br>`$campaignId: String!` | `$action: String` | `retrieveMemberCampaignPage` |
| `retrieveMemberCampaignsByPlacement` | query | `$memberUid: String!` | `$placement: String`<br>`$isOnboardingCompleted: Boolean` | `retrieveMemberCampaignsByPlacement` |
| `retrieveMemberCampaignsV2` | query | `$memberId: String!` | — | `retrieveMemberCampaignsV2` |
| `retrieveMemberInterestIncomeDetailV4` | query | `$memberId: String!` | `$currency: CurrencyCode` | `retrieveMemberInterestIncomeDetailV4` |
| `retrieveMemberMidasProSubscriptionOverviewV2` | query | `$memberId: String!` | `$aiEligible: Boolean` | `retrieveMemberMidasProSubscriptionOverviewV2` |
| `retrieveMemberWithdrawalAccountsCashDetail` | query | `$memberId: String!` | — | `retrieveMemberWithdrawalAccountsCashDetail` |
| `retrieveOnboardingNFCStatus` | query | `$memberUid: String!` | — | `retrieveOnboardingNFCStatus` |
| `retrieveOnboardingProgress` | query | `$memberUid: String!` | — | `retrieveOnboardingProgress` |
| `retrieveOnboardingRecommendation` | query | `$memberUid: String!` | — | `retrieveOnboardingRecommendation` |
| `retrieveOnboardingTimeline` | query | `$memberUid: String!` | — | `retrieveOnboardingTimeline` |
| `retrievePhoneNumberChange` | mutation | `$phoneNumberChangeUid: String!` | — | `retrievePhoneNumberChange` |
| `retrieveProfile` | query | `$memberId: String!` | — | `retrieveProfile` |
| `retrieveReservationAvailableDates` | query | `$memberId: String!`<br>`$address: String!` | — | `retrieveReservationAvailableDates` |
| `retrieveReservationDateFeatureStatus` | query | `$memberId: String!` | — | `retrieveReservationDateFeatureStatus` |
| `retrieveRestrictedAnswerKeys` | query | `$memberUid: String!` | — | `retrieveRestrictedAnswerKeys` |
| `retrieveSelfServiceStep` | query | `$memberVerificationUid: String!` | — | `retrieveSelfServiceStep` |
| `retrieveSimBlockage` | mutation | `$memberUid: String!` | — | `retrieveSimBlockage` |
| `retrieveSimBlockageVerificationStep` | mutation | `$memberVerificationUid: String!` | — | `retrieveSimBlockageVerificationStep` |
| `retrieveSubscriptionCancelOffer` | query | `$memberId: String!`<br>`$subscriptionPublicId: String!` | — | `retrieveSubscriptionCancelOffer` |
| `retrieveSubscriptionCancelStep` | query | `$memberId: String!`<br>`$subscriptionPublicId: String!` | — | `retrieveSubscriptionCancelStep` |
| `retrieveSubscriptionCancelSurvey` | query | `$memberId: String!`<br>`$subscriptionPublicId: String!` | — | `retrieveSubscriptionCancelSurvey` |
| `retrieveSubscriptionCheckoutSummary` | query | `$memberId: String!`<br>`$subscriptionPublicId: String!` | — | `retrieveSubscriptionCheckoutSummary` |
| `retrieveSystemStatusV2` | query | — | — | `retrieveSystemStatusV2` |
| `retrieveTaxApprovalStatus` | query | `$memberId: String!` | — | `retrieveTaxApprovalStatus` |
| `retrieveTaxOffices` | query | `$cityId: Int!` | — | `retrieveTaxOffices` |
| `retrieveUsdInterestContracts` | query | `$memberId: String!` | — | `retrieveUsdInterestContracts` |
| `retrieveVerificationRequiredBlockage` | query | `$memberUid: String!`<br>`$blockageType: BlockageType!` | — | `retrieveVerificationRequiredBlockage` |
| `retrieveWatchlistsInfo` | query | `$memberId: String!` | — | `retrieveWatchlistsInfo` |
| `reviewInternalMoneyTransfer` | query | `$memberId: String!`<br>`$senderAccountId: String!`<br>`$receiverAccountId: String!`<br>`$amount: Float!` | `$currency: CurrencyCode` | `reviewInternalMoneyTransfer` |
| `saveCompanyFinancialInformationV2` | mutation | `$memberId: String!`<br>`$liquidAssetsKey: Int!`<br>`$annualTurnoverKey: Int!`<br>`$totalRegisteredAssetsKey: Int!`<br>`$sourceOfIncome: String!`<br>`$accountUsagePurpose: String!` | — | `saveCompanyFinancialInformationV2` |
| `saveCompanySignatories` | mutation | `$memberId: String!`<br>`$signatories: [SignatoryRequest!]!` | — | `saveCompanySignatories` |
| `saveContractGroupsV2` | mutation | `$memberId: String!`<br>`$contractIds: [String!]!` | — | `saveContractGroupsV2` |
| `saveContractSignatory` | mutation | `$memberUid: String!`<br>`$input: SignatoryRequest!` | — | `saveContractSignatory` |
| `saveCorporateInformation` | mutation | `$memberId: String!`<br>`$email: String!`<br>`$vkn: String!`<br>`$hasForeignTaxLiability: Boolean!`<br>`$hasMajorShareholder: Boolean!` | — | `saveCorporateInformation` |
| `saveCustodianIdentityInformation` | mutation | `$memberId: String!`<br>`$nationalId: String!`<br>`$dateOfBirth: Date!` | — | `saveCustodianIdentityInformation` |
| `saveGroupedContracts` | mutation | `$memberId: String!`<br>`$groupKeys: [String!]!`<br>`$isAccepted: Boolean!` | — | `saveGroupedContracts` |
| `saveIdentityInformationV3` | mutation | `$memberId: String!`<br>`$nationalId: String!`<br>`$dateOfBirth: Date!` | `$firstName: String`<br>`$lastName: String`<br>`$memberType: MemberType` | `saveIdentityInformationV3` |
| `saveLivenessConsentContracts` | mutation | `$memberId: String!`<br>`$groupKeys: [String!]!` | — | `saveLivenessConsentContracts` |
| `saveLivenessConsentContractsByFlowUid` | mutation | `$consentVerificationFlowType: ConsentVerificationFlowType!`<br>`$flowUid: String!`<br>`$groupKeys: [String!]!` | — | `saveLivenessConsentContractsByFlowUid` |
| `saveOnboardingContractSignatory` | mutation | `$memberId: String!`<br>`$addressDetails: AddressDetails!` | `$reservationDate: Date` | `saveOnboardingContractSignatory` |
| `savePersonalInformationV3` | mutation | `$memberId: String!`<br>`$email: String!` | `$professionKey: String`<br>`$monthlyIncomeKey: String`<br>`$sourceOfIncomeKey: String`<br>`$addressDetails: AddressDetails` | `savePersonalInformationV3` |
| `saveRequestValidationPublicKey` | mutation | `$memberUid: String!`<br>`$deviceId: String!`<br>`$publicKey: String!`<br>`$keyScope: KeyScope!`<br>`$signingDate: Long!`<br>`$signature: String!` | — | `saveRequestValidationPublicKey` |
| `saveRestrictedPublicKey` | mutation | `$memberUid: String!`<br>`$deviceId: String!`<br>`$restrictedPublicKey: String!`<br>`$biometricType: BiometricType!`<br>`$signature: String!` | — | `saveRestrictedPublicKey` |
| `saveScreenerV2` | mutation | `$name: String!`<br>`$iconCode: String!`<br>`$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!`<br>`$selectedColumns: [ScreenerColumnInput!]!` | `$sortBy: String`<br>`$sortDirection: String`<br>`$selectedFilterItems: [ScreenerFilterItemInput!]` | `saveScreenerV2` |
| `saveSoleProprietorshipInformation` | mutation | `$memberId: String!`<br>`$email: String!`<br>`$taxOfficeUid: String!`<br>`$companyAddress: AddressDetails!` | — | `saveSoleProprietorshipInformation` |
| `screenerAllFiltersV2` | query | `$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!` | — | `screenerAllFiltersV2` |
| `screenerFilterDetail` | query | `$id: String!` | — | `screenerFilterDetail` |
| `screenerRetrieveCountV2` | query | — | `$assetVertical: AssetVertical`<br>`$investmentType: InvestmentType`<br>`$selectedFilters: [ScreenerResultInputItem!]` | `screenerRetrieveCountV2` |
| `screenerRetrieveResultV2` | query | — | `$pitId: String`<br>`$searchAfter: String`<br>`$sortBy: String`<br>`$sortDirection: String`<br>`$assetVertical: AssetVertical`<br>`$investmentType: InvestmentType`<br>`$filters: [ScreenerResultInputItem!]`<br>`$columns: [ScreenerColumnInput!]` | `screenerRetrieveResultV2` |
| `screenerRetrieveV2` | query | — | `$id: String`<br>`$assetVertical: AssetVertical`<br>`$sectorId: String`<br>`$investmentType: InvestmentType` | `screenerRetrieveV2` |
| `searchAddress` | query | `$memberId: String!`<br>`$text: String!` | — | `searchAddress` |
| `searchByAdvancedTools` | query | `$query: String!`<br>`$tool: DiscoveryAdvancedTool!`<br>`$page: Int!`<br>`$size: Int!` | `$watchlistId: String` | `searchByAdvancedTools` |
| `searchCustomerSupportItems` | query | `$input: SearchCustomerSupportItemRequest!` | — | `searchCustomerSupportItems` |
| `searchInitialState` | query | — | `$watchlistId: String`<br>`$type: String`<br>`$source: String` | `searchInitialState` |
| `searchV4` | query | `$query: String!`<br>`$searchItemTypes: [SearchItemType!]!`<br>`$page: Int!`<br>`$size: Int!`<br>`$shouldFetchListResults: Boolean!` | `$assetVertical: AssetVertical`<br>`$watchlistId: String`<br>`$searchRequestId: String`<br>`$selectedFilter: String` | `searchV4` |
| `searchWatchlistsForStock` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `searchWatchlistsForStock` |
| `selectAward` | mutation | `$memberUid: String!`<br>`$campaignUid: String!`<br>`$input: CampaignAwardSelectionRequest!` | — | `selectAward` |
| `selfServiceWebLink` | query | `$memberId: String!` | — | `selfServiceWebLink` |
| `sendCompanyCorporateDocumentsUploadFormEmail` | mutation | `$memberId: String!` | — | `sendCompanyCorporateDocumentsUploadFormEmail` |
| `sendOtp` | mutation | `$memberUid: String!`<br>`$input: SendOtpInput!` | — | `sendOtp` |
| `sendPartnerLinkApproval` | mutation | `$memberId: String!`<br>`$iamId: String!`<br>`$approveStatus: PartnerMemberApproveStatus!` | — | `approvePartnerMemberLink` |
| `sendYieldConsent` | mutation | `$memberId: String!`<br>`$currency: CurrencyCode!`<br>`$consent: InterestConsent!` | `$signUsdInterestContract: Boolean` | `saveInterestConsentV3` |
| `setAccountMargin` | mutation | `$accountId: String!`<br>`$input: AccountMarginRequest!` | — | `setAccountMargin` |
| `setCommunicationPermissions` | mutation | `$memberId: String!`<br>`$communicationPermission: Boolean!`<br>`$emailPermission: Boolean!`<br>`$smsPermission: Boolean!`<br>`$callPermission: Boolean!` | — | `saveCommunicationConsent` |
| `setEmailAddress` | mutation | `$memberId: String!`<br>`$email: String!` | — | `saveEmail` |
| `setInAppMessageAsRead` | mutation | `$memberId: String!`<br>`$iamId: String!` | — | `markInAppMessageAsRead` |
| `setNGroupLimit` | mutation | `$accountId: String!`<br>`$input: TrMarginNGroupLimitRequest!` | — | `setNGroupLimit` |
| `setReconciliation` | mutation | `$memberId: String!`<br>`$reconciliationId: String!`<br>`$isAccepted: Boolean!` | — | `respondReconciliation` |
| `settlementAnalysis` | query | `$uid: String!` | `$settlementType: SettlementType`<br>`$start: Date`<br>`$end: Date` | `settlementAnalysis` |
| `settlementAnalysisSummary` | query | `$uid: String!` | — | `settlementAnalysis` |
| `shareRealizedOrder` | mutation | `$accountId: String!`<br>`$orderId: String!` | — | `shareRealizedOrder` |
| `signUsdInterestContract` | mutation | `$memberId: String!`<br>`$signActionType: SignActionType!` | — | `signUsdInterestContracts` |
| `startBalanceBasedSubscription` | mutation | `$request: StartBalanceBasedSubscriptionRequest!` | — | `startBalanceBasedSubscription` |
| `startCardBasedSubscription` | mutation | `$request: StartCardBasedSubscriptionRequest!` | — | `startCardBasedSubscription` |
| `startLoggedInMemberPhoneNumberChange` | mutation | `$memberUid: String!` | — | `startLoggedInMemberPhoneNumberChange` |
| `stockDetailOptionPositions` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `stockDetailOptionPositions` |
| `stockDetailPosition` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `stockDetailPosition` |
| `stockDetailViopFuturePositions` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `stockDetailViopFuturePositions` |
| `stockDetailWarrantPositionBreakdown` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `stockDetailWarrantPositionBreakdown` |
| `submitCampaignAwardDeliveryInfo` | mutation | `$memberUid: String!`<br>`$campaignUid: String!` | `$input: CampaignAwardDeliverySubmitRequest` | `submitCampaignAwardDeliveryInfo` |
| `submitSubscriptionCancelSurvey` | mutation | `$request: SubmitSubscriptionCancelSurveyRequest!` | — | `submitSubscriptionCancelSurvey` |
| `submitSurveyResponse` | mutation | `$type: AdoptionSurveyType!`<br>`$selectedOptions: [SelectedOption!]!` | — | `submitSurveyResponse` |
| `submitTravelRuleForm` | mutation | `$memberUid: String!`<br>`$transferUid: String!`<br>`$form: CryptoTravelRuleFormInput!` | — | `submitTravelRuleForm` |
| `subscribeDynamicList` | mutation | `$listId: String!` | — | `subscribeDynamicList` |
| `syncMarketingInformation` | mutation | `$memberId: String!`<br>`$appsflyerId: String!` | `$advertisingId: String` | `syncMarketingInformation` |
| `taxDetail` | query | `$memberUid: String!`<br>`$taxPageType: TaxPageType!`<br>`$uid: String!` | `$cursor: String`<br>`$size: Int` | `taxDetail` |
| `taxDividendStockDetail` | query | `$memberUid: String!`<br>`$transactionUid: String!` | — | `taxDividendStockDetail` |
| `taxOverview` | query | `$memberUid: String!` | — | `taxOverview` |
| `taxPeriodDetail` | query | `$memberUid: String!`<br>`$year: Int!` | — | `taxPeriodDetail` |
| `timeIntervalSuggestionEnabled` | query | — | — | `timeIntervalSuggestionEnabled` |
| `totalMarginCreditDetails` | query | `$accountId: String!` | `$isNGroupLimit: Boolean` | `totalMarginCreditDetails` |
| `tradeStateInfo` | query | `$accountId: String!` | `$type: String` | `accountSummaryV2` |
| `tradingHoursV2` | query | — | `$countryCode: String` | `tradingHoursV2` |
| `tradingTrendsV2` | query | `$uid: String!` | `$trendType: TradingTrendType` | `tradingTrendsV2` |
| `transactionHistory` | query | `$memberId: String!`<br>`$selectedFilterPath: [String!]!`<br>`$status: TransactionStatus!`<br>`$page: Int!`<br>`$size: Int!` | — | `transactionHistory` |
| `transactionHistoryFilterTree` | query | — | — | `transactionHistoryFilterTree` |
| `transactionHistoryForInvestmentType` | query | `$memberId: String!`<br>`$status: TransactionStatus!`<br>`$page: Int!`<br>`$size: Int!`<br>`$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!` | — | `transactionHistoryForInvestmentType` |
| `transactionHistoryForStock` | query | `$memberId: String!`<br>`$status: TransactionStatus!`<br>`$instrumentId: String!`<br>`$page: Int!`<br>`$size: Int!` | — | `transactionHistoryForStock` |
| `transferCollateral` | mutation | `$accountUid: String!`<br>`$input: CollateralTransferRequest!` | — | `transferCollateral` |
| `transferMoneyBetweenMemberAccountsV2` | mutation | `$memberId: String!`<br>`$senderAccountId: String!`<br>`$receiverAccountId: String!`<br>`$amount: Float!` | `$currency: CurrencyCode`<br>`$cryptoDepositBoostWithdrawalPenaltyId: String` | `transferMoneyBetweenMemberAccountsV2` |
| `triggerCorporateSignatoriesDelivery` | mutation | `$memberId: String!`<br>`$signatoryUid: String!` | `$addressDetails: AddressDetails`<br>`$reservationDate: Date` | `triggerCorporateSignatoriesDelivery` |
| `triggerOnboardingSignatoryDelivery` | mutation | `$memberId: String!`<br>`$addressDetails: AddressDetails!` | `$reservationDate: Date` | `triggerOnboardingSignatoryDelivery` |
| `unbindDevice` | mutation | `$memberId: String!`<br>`$requestedDeviceId: String!`<br>`$deviceId: String!` | — | `unbindDevice` |
| `unlinkMasterpass` | mutation | `$memberId: String!` | — | `unlinkMasterpass` |
| `unsubscribeDynamicList` | mutation | `$listId: String!` | — | `unsubscribeDynamicList` |
| `upcomingDividendsV2` | query | `$assetVertical: AssetVertical!` | — | `upcomingDividendsV2` |
| `upcomingEarningsV2` | query | `$assetVertical: AssetVertical!` | — | `upcomingEarningsV2` |
| `upcomingListing` | query | `$instrumentId: String!` | — | `upcomingListing` |
| `updateAccountOwnershipConfirmation` | mutation | `$memberUid: String!`<br>`$blockageUid: String!` | — | `updateAccountOwnershipConfirmation` |
| `updateAlert` | mutation | `$alertId: String!`<br>`$instrumentId: String!`<br>`$targetTypeOptionKey: String!`<br>`$cooldownOptionKey: String!`<br>`$targetPrice: Float!` | `$note: String` | `updateAlert` |
| `updateAlertStatus` | mutation | `$instrumentId: String!`<br>`$alertId: String!`<br>`$status: AlertStatus!` | — | `updateAlertStatus` |
| `updateByCardDetailAction` | mutation | `$uid: String!` | `$actionType: String` | `updateByCardDetailAction` |
| `updateContractSignatory` | mutation | `$memberUid: String!`<br>`$input: UpdateContractSignatoryRequest!` | — | `updateContractSignatory` |
| `updateContractStatus` | mutation | `$memberId: String!`<br>`$contractTemplateType: ContractTemplateType!`<br>`$status: ContractStatus!` | — | `updateContractStatus` |
| `updateDigestFeedbackState` | mutation | `$digestUid: String!`<br>`$state: DigestFeedbackState!` | — | `updateDigestFeedbackState` |
| `updateInstrumentDividendReinvestmentPreference` | mutation | `$input: ChangeMemberInstrumentDividendReinvestmentPreferenceRequest!`<br>`$memberId: String!` | — | `updateInstrumentDividendReinvestmentPreference` |
| `updateMarginLimitContract` | query | `$accountId: String!`<br>`$newCreditLimit: Float!` | — | `updateMarginLimitContract` |
| `updateMemberDividendReinvestmentPreference` | mutation | `$input: ChangeMemberDividendReinvestmentPreferenceRequest!`<br>`$memberId: String!` | — | `updateMemberDividendReinvestmentPreference` |
| `updateMemberInLiveChat` | mutation | `$memberId: String!`<br>`$isMemberInLiveChat: Boolean!` | — | `memberInLiveChat` |
| `updateMemberSubscriptionPaymentMethod` | mutation | `$request: UpdateMemberSubscriptionPaymentMethodRequest!` | — | `updateMemberSubscriptionPaymentMethod` |
| `updateMemberSubscriptionRenewal` | mutation | `$request: UpdateMemberSubscriptionRenewalRequest!` | — | `updateMemberSubscriptionRenewal` |
| `updateNGroupMultiplier` | mutation | `$accountId: String!`<br>`$input: UpdateNGroupMultiplierRequest!` | — | `updateNGroupMultiplier` |
| `updateOrder` | mutation | `$accountId: String!`<br>`$orderId: String!`<br>`$quantity: Float!` | `$instrumentId: String`<br>`$price: Float`<br>`$limitPrice: Float`<br>`$stopPrice: Float` | `updateOrder` |
| `updateProAnalysisFeedbackState` | mutation | `$input: UpdateProAnalysisFeedbackStateInput!` | — | `updateProAnalysisFeedbackState` |
| `updateScreenerMetadata` | mutation | `$id: String!`<br>`$name: String!`<br>`$iconCode: String!` | — | `updateScreenerMetadata` |
| `updateScreenerV2` | mutation | `$id: String!`<br>`$name: String!`<br>`$iconCode: String!`<br>`$assetVertical: AssetVertical!`<br>`$investmentType: InvestmentType!`<br>`$sortBy: String!`<br>`$sortDirection: String!`<br>`$selectedColumns: [ScreenerColumnInput!]!` | `$selectedFilterItems: [ScreenerFilterItemInput!]` | `updateScreenerV2` |
| `updateWatchlist` | mutation | `$memberId: String!`<br>`$watchlistId: String!`<br>`$iconCode: String!`<br>`$name: String!` | — | `updateWatchlist` |
| `uploadDocumentBarcode` | mutation | `$memberUid: String!`<br>`$barcode: String!`<br>`$fileSubType: DocumentFileSubType!`<br>`$fileType: MemberDocumentFileType!` | — | `uploadDocumentBarcode` |
| `uploadOnboardingAddressDocumentBarcode` | mutation | `$memberUid: String!`<br>`$barcode: String!`<br>`$fileSubType: DocumentFileSubType!` | — | `uploadOnboardingAddressDocumentBarcode` |
| `userCampaignJourneyInfo` | query | `$memberId: String!`<br>`$campaingKey: CampaignKey!` | — | `userCampaignJourneyInfo` |
| `useRight` | mutation | `$couponId: String!`<br>`$accountId: String!`<br>`$quantity: Float!`<br>`$isRiskForEquityAccepted: Boolean!`<br>`$isRiskForNominalAccepted: Boolean!` | `$riskFormId: Int`<br>`$riskFormVersion: Int` | `useRight` |
| `validateOtp` | mutation | `$phoneNumberChangeUid: String!`<br>`$referenceCode: String!`<br>`$verificationCode: String!` | — | `validateOtp` |
| `validatePhoneNumberV2` | mutation | `$phoneNumber: String!` | — | `validatePhoneNumberV2` |
| `verifyCreditReportPin` | mutation | `$memberUid: String!`<br>`$pin: String!` | — | `verifyCreditReportPin` |
| `verifyCurrentPassword` | mutation | `$currentPassword: String!`<br>`$memberId: String!` | — | `verifyCurrentPassword` |
| `verifyForgotPasswordOTP` | mutation | `$phoneNumber: String!`<br>`$referenceCode: String!`<br>`$verificationCode: String!` | — | `verifyForgotPasswordOTP` |
| `verifyPositionTransferOutCode` | mutation | `$memberId: String!`<br>`$positionTransferType: PositionTransferType!`<br>`$receiverName: String!`<br>`$receiverSurname: String!`<br>`$receiverAccountNo: String!`<br>`$selectedPositions: [PositionTransferStockSelectionV2!]!`<br>`$phoneNumber: String!`<br>`$referenceCode: String!`<br>`$verificationCode: String!` | `$receiverTckn: String`<br>`$receiverBrokerName: String`<br>`$receiverBrokerCode: String`<br>`$reasonType: PositionTransferReasonType`<br>`$reasonExplanation: String` | `completePositionTransferV3` |
| `viopMaintenanceStatus` | query | — | — | `viopMaintenanceStatus` |
| `viopOverviewPositions` | query | `$accountId: String!` | — | `viopOverviewPositions` |
| `viopRealizedProfitLoss` | query | `$accountId: String!` | `$period: ViopProfitLossTimeRange` | `viopRealizedProfitLoss` |
| `warrantBasicBuilder` | query | `$instrumentId: String!` | — | `warrantBasicBuilder` |
| `warrantBasicBuilderCount` | query | `$instrumentId: String!`<br>`$warrantType: WarrantType!` | `$filterIds: [String!]` | `warrantBasicBuilderCount` |
| `warrantChain` | query | `$instrumentId: String!` | `$warrantType: WarrantType`<br>`$selectedColumnIds: [String!]`<br>`$expiryDate: Date` | `warrantChain` |
| `warrantChainFromBasicBuilder` | query | `$instrumentId: String!`<br>`$warrantType: WarrantType!` | `$selectedFilterItems: [String!]`<br>`$selectedColumnIds: [String!]`<br>`$expiryDate: Date` | `warrantChainFromBasicBuilder` |
| `warrantPositionChainBreakdown` | query | `$memberId: String!`<br>`$instrumentId: String!` | — | `warrantPositionChainBreakdown` |
| `warrantSimulateMyReturns` | query | `$warrantUid: String!` | `$orderType: WarrantOrderType` | `warrantSimulateMyReturn` |
| `watchlistPosition` | query | `$assetUid: String!` | — | `watchlistPosition` |
| `withdrawalBankAccountsByMemberUid` | query | `$memberId: String!`<br>`$currency: CurrencyCode!` | — | `withdrawalBankAccountsByMemberUid` |
| `withdrawalReview` | query | `$accountId: String!`<br>`$iban: String!`<br>`$amount: Float!`<br>`$shouldSaveIban: Boolean!`<br>`$platform: MidasPlatform!`<br>`$shouldSendToCustodian: Boolean!` | — | `withdrawalReview` |
| `withdrawV2` | mutation | `$accountId: String!`<br>`$iban: String!`<br>`$amount: Float!`<br>`$shouldSaveIban: Boolean!`<br>`$platform: MidasPlatform!`<br>`$shouldSendToCustodian: Boolean!` | `$etaUid: String`<br>`$cryptoDepositBoostWithdrawalPenaltyId: String` | `withdrawV2` |

## Complete contract archive

[graphql-operations.json.gz](graphql-operations.json.gz) is the canonical complete catalog. It is gzip-compressed to avoid duplicating more than 100 MB of highly repetitive generated text in the working tree. Decompression reproduces the exact JSON catalog; no contract data is omitted.

Inspect one operation without creating an intermediate file:

```sh
gzip -dc docs/midas-api/graphql-operations.json.gz \
  | jq ".operations[] | select(.name == \"retrieveLoginNonce\")"
```

Validate the catalog and operation count:

```sh
gzip -dc docs/midas-api/graphql-operations.json.gz \
  | jq ".counts"
```

Each object in `operations` contains `name`, `type`, `operationId`, the exact `document`, `variables`, `responseRoots`, and `responseFields`. Each response-field entry records its path, JSON type, field nullability, list-item nullability when applicable, alias when applicable, and fragment type conditions when applicable.
