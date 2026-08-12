# Midas wire types

This file defines all 48 GraphQL input objects and all 440 GraphQL enums in the Midas contract, plus its scalar encodings and shared HTTP request and response envelopes. SSE payload types are defined with their routes in [sse-streams.md](sse-streams.md), and operation-specific GraphQL response selections are retained in the [complete operation catalog](graphql-operations.md#complete-contract-archive).

For GraphQL input objects, a required property must be present and non-null. A property marked with `?` may be omitted or sent as `null`.

## Scalars

| GraphQL scalar | JSON representation |
| --- | --- |
| `Boolean` | `boolean` |
| `Date` | calendar-date string in `YYYY-MM-DD` form |
| `DateTime` | ISO 8601 date-time string |
| `Float` | JSON number |
| `ID` | JSON string |
| `Int` | signed 32-bit JSON integer |
| `Long` | signed 64-bit JSON integer |
| `String` | JSON string |

## GraphQL input objects

```ts
interface AccountMarginRequest {
  isMarginEnabled: boolean
  requestSource?: RequestSource | null
}

interface AddressDetails {
  cityId: string
  districtId: string
  detail: string
}

interface CampaignAwardDeliverySubmitRequest {
  recipientFirstName?: string | null
  recipientLastName?: string | null
  recipientPhoneNumber?: string | null
  cityId?: number | null
  districtId?: number | null
  addressDetail?: string | null
}

interface CampaignAwardSelectionRequest {
  confirmed: boolean
  detailId: string
}

interface ChangeMemberDividendReinvestmentPreferenceRequest {
  activate: boolean
}

interface ChangeMemberInstrumentDividendReinvestmentPreferenceRequest {
  memberDividendInstruments: MemberDividendInstrument[]
}

interface MemberDividendInstrument {
  uid: string
  isDividendReinvestmentActive: boolean
}

interface CollateralCancelRequest {
  acceptCreditCloseNotice?: boolean | null
}

interface CollateralTransferRequest {
  transferDirection: TransferDirection
  amount: number
}

interface ConfirmOtpInput {
  verificationChannel: OtpVerificationChannel
  verificationType: OtpVerificationType
  referenceCode: string
  verificationCode: string
}

interface ContractGroupApprovalStatusRequest {
  assumeMissingContractAccepted: boolean
}

interface CreateCaseRequest {
  subject: string
  description: string
  tags?: Array<string | null> | null
}

interface CreditLimitChangeRequest {
  newCreditLimit: number
}

interface CryptoCancelOrderInput {
  orderUid: string
}

interface CryptoDustConversionInput {
  instrumentUid: string
  quantity: number
}

interface CryptoHighlightSectionTypePair {
  section: CryptoHighlightSectionID
  type: string
}

interface CryptoPairSearchRequest {
  leftInstrumentUid?: string | null
  rightInstrumentUid?: string | null
  pairUid?: string | null
}

interface CryptoReviewRefundAddressInput {
  refundAddress: string
  tag?: string | null
}

interface CryptoStopOrder {
  stopPrice: number
  limitPrice?: number | null
}

interface CryptoSubmitRefundAddressInput {
  refundAddress: string
  tag?: string | null
}

interface CryptoTrailingStopOrder {
  stopPrice: number
  trailPercentage: number
}

interface CryptoTravelRuleFormInput {
  formUid?: string | null
  owner?: CryptoTravelRuleFormOwner | null
  ownerPlatform?: string | null
  ownerName?: string | null
  ownerAddress?: string | null
  transferDescription: string
  assetSource?: string | null
  occupation?: string | null
  income?: string | null
}

interface DepositRoutingDecisionRequest {
  decision: string
}

interface EmailChangeInitializeInput {
  deviceId: string
  phoneNumber: string
  signingDate: number
  signature: string
}

interface EmailChangeInitializeWithPasswordInput {
  deviceId: string
  phoneNumber: string
  signingDate: number
  signature: string
  password: string
}

interface EmailChangeSendOtpInput {
  email: string
}

interface EmailVerificationConfirmInput {
  referenceCode: string
  verificationCode: string
}

interface GiveMasterpassCardConsentRequest {
  memberUid: string
  cardAlias: string
  contractAccepted: boolean
}

interface InitiateContractDeliveryRequest {
  creditAmount: number
  contractSignatoryUidList: string[]
}

interface PositionTransferStockSelectionV2 {
  symbol?: string | null
  quantity?: number | null
}

interface ResendOtpInput {
  verificationChannel: OtpVerificationChannel
  verificationType: OtpVerificationType
  referenceCode: string
}

interface ScreenerColumnInput {
  id: string
  field: string
}

interface ScreenerFilterItemInput {
  uid: string
  filterId: string
  filterName: string
  isCustom: boolean
  name: string
  timeRange?: string | null
  field: string
  queryType: string
  values: ScreenerFilterValueInput[]
}

interface ScreenerFilterValueInput {
  key: string
  value: string
  placeholder?: string | null
}

interface ScreenerResultInputItem {
  timeRange?: string | null
  field: string
  queryType: string
  values: ScreenerFilterValueInput[]
}

interface SearchCustomerSupportItemRequest {
  query: string
}

interface SelectedOption {
  questionId: AdoptionQuestionType
  optionId: string
}

interface SendOtpInput {
  verificationChannel: OtpVerificationChannel
  verificationType: OtpVerificationType
}

interface SignatoryRequest {
  selfSignatory: boolean
  firstName: string
  lastName: string
  email: string
  phoneNumber: string
  identityNumber: string
  addressDetail: AddressDetails
  reservationDate?: string | null
}

interface StartBalanceBasedSubscriptionRequest {
  memberUid: string
  subscriptionPackageUid: string
  renewal: boolean
  contractAccepted: boolean
  paymentToken: string
}

interface StartCardBasedSubscriptionRequest {
  memberUid: string
  subscriptionPackageUid: string
  renewal: boolean
  contractAccepted: boolean
  cardIdentifier: string
  paymentToken: string
}

interface SubmitSubscriptionCancelSurveyRequest {
  memberUid: string
  subscriptionPublicId: string
  key: string
  feedback?: string | null
}

interface TrMarginNGroupLimitRequest {
  isNGroupEnabled: boolean
  requestSource?: RequestSource | null
}

interface UpdateContractSignatoryRequest {
  signatoryUid: string
  firstName: string
  lastName: string
  email: string
  phoneNumber: string
  addressDetail: AddressDetails
}

interface UpdateMemberSubscriptionPaymentMethodRequest {
  memberUid: string
  memberSubscriptionUid: string
  paymentMethod: PaymentMethod
  cardIdentifier?: string | null
}

interface UpdateMemberSubscriptionRenewalRequest {
  memberUid: string
  accountId?: string | null
  subscriptionPackageUid?: string | null
  memberSubscriptionUid?: string | null
  renewal: boolean
}

interface UpdateNGroupMultiplierRequest {
  multiplier: string
}

interface UpdateProAnalysisFeedbackStateInput {
  analysisUid: string
  state: ProAnalysisFeedbackState
  detail?: string | null
}
```

## GraphQL enums

These are all 440 enum types and their accepted wire values in the Midas GraphQL contract.

```ts
type ABGroup =
  | "A"
  | "B"

type AccountClosureApp = "CRYPTO"

type AccountClosureReasonAction =
  | "EXPECTATIONS"
  | "PHONE_NUMBER_CHANGE"
  | "OTHER"

type AccountClosureStepName =
  | "APPLICATION_SELECTION"
  | "PRIVILEGES"
  | "MIDAS_PRO_INFO"
  | "VALIDATIONS"
  | "REASONS"
  | "FINAL_CONFIRMATION"

type AccountFeatureApprovalStatus =
  | "FEATURE_HUB_REQUIRED"
  | "KYC_FAILED"
  | "KYC_WAITING"
  | "FEATURE_WAITING"
  | "COMPLETED"

type AccountFeatureFlowType =
  | "OPTIONS"
  | "WARRANT"

type AccountStatus =
  | "FAILED"
  | "SUBMITTED"
  | "SUSPENDED"
  | "ACTIVE"
  | "PASSIVE_COMPLIANCE"
  | "ACCOUNT_RESTRICTED"

type ActivationStatus =
  | "ELIGIBLE"
  | "NOT_ELIGIBLE_CUSTODIAN"
  | "NOT_ELIGIBLE_IDENTITY"

type AdoptionQuestionType =
  | "FUTURE_SELECTION"
  | "DIRECTION"
  | "PRICE_RANGE_UP"
  | "PRICE_RANGE_DOWN"

type AdoptionSurveyType = "FUTURE"

type AdvancedTool =
  | "INSTANT_BROKERAGE_DISTRIBUTION"
  | "TR_DEPTH"
  | "SETTLEMENT"
  | "ADVANCED_CHART"
  | "CANDLESTICK_CHART"

type AlertStatus =
  | "ACTIVE"
  | "INACTIVE"

type AlertTargetType =
  | "TRADE"
  | "MARK"
  | "ASK"
  | "BID"

type AlertTriggerType =
  | "ONCE"
  | "RECURRING"

type Alignment =
  | "LEFT"
  | "CENTER"

type ArticleType =
  | "MIDAS_NEWS"
  | "KAP_NEWS"

type ArticleTypeFilter =
  | "MIDAS_NEWS"
  | "KAP_NEWS"
  | "ALL"

type AssetSessionEligibility =
  | "EXTENDED"
  | "REGULAR_ONLY"
  | "OVERNIGHT"

type AssetStatus =
  | "INACTIVE"
  | "ACTIVE"
  | "PENDING"
  | "CLOSED"
  | "LISTING"

type AssetSubType =
  | "STOCK"
  | "INDEX"
  | "ETF"
  | "COUPON"
  | "PARITY"
  | "COMMODITY_CERTIFICATE"
  | "IPO"
  | "MUTUAL_FUND"

type AssetVertical =
  | "US"
  | "TR"
  | "EU"
  | "CRYPTO"

type BadgeType =
  | "INFO"
  | "WARNING"

type BiometricType = "FINGERPRINT"

type BlockageType = "THIRD_PARTY_USAGE"

type BookBuildingType =
  | "FIXED_PRICE"
  | "PRICE_RANGE"

type BrokeragePosition =
  | "BUYER"
  | "SELLER"

type ButtonRedirection =
  | "DETAIL"
  | "ONBOARDING"
  | "REFERRAL"
  | "CLAIM_STOCK_REWARD"
  | "CONTACT_US"
  | "EXPLORE_LISTS"
  | "DELIVERY_ADDRESS"
  | "DELIVERY_STATUS"
  | "DEPOSIT_USD"
  | "DEPOSIT_TRY"
  | "FX_SELL"
  | "DEPOSIT_MONEY"
  | "VIDEO_ONBOARDING"
  | "VIDEO_ONBOARDING_BLOCKER"
  | "CONFORMANCE_TEST"
  | "INSTRUMENT_DETAIL"
  | "DEEPLINK"
  | "UNKNOWN"
  | "STORE"

type BuyingPowerItemSign =
  | "PLUS"
  | "MINUS"
  | "EQUAL"

type CalendarActionType =
  | "SELECT"
  | "CALENDAR"

type CallingCodeFilterType =
  | "ALL"
  | "MOST_POPULAR"

type CampaignKey =
  | "FUND_WELCOME"
  | "FUND_PAYBACK"

type CampaignProgressSituation =
  | "INFO"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CardBackground =
  | "GREY"
  | "RED"
  | "YELLOW"
  | "BLUE"
  | "LILAC"
  | "MIDAS_BLUE"
  | "TURQUOISE"
  | "LIGHT_PURPLE"
  | "DARK_RED"
  | "GREEN"

type CardPattern =
  | "NONE"
  | "CIRCLES"
  | "LINES"

type CardPlacement =
  | "OVERVIEW"
  | "STOCK_DETAIL"
  | "SUPPORT"
  | "PROFILE"
  | "COMPLETE_ONBOARDING"
  | "REFERRAL"
  | "VIDEO_ONBOARDING"
  | "EXPLORE"
  | "MENU"
  | "CRYPTO_OVERVIEW"
  | "CRYPTO_MENU"
  | "US_OPTIONS_COMMUNITY"
  | "EXPLORE_US"
  | "EXPLORE_TR"
  | "EXPLORE_TR_FUNDS"
  | "EXPLORE_CRYPTO"
  | "EXPLORE_EU"
  | "BUYING_POWER_TR"
  | "BUYING_POWER_US"
  | "BUYING_POWER_EU"
  | "ACCOUNT_SUMMARY_TR"
  | "ACCOUNT_SUMMARY_US"
  | "ACCOUNT_SUMMARY_EU"
  | "OVERVIEW_BIST"
  | "OVERVIEW_US"
  | "OVERVIEW_WARRANT"
  | "OVERVIEW_EU"
  | "OVERVIEW_OPTIONS"
  | "OVERVIEW_FUTURES"
  | "OVERVIEW_MUTUAL_FUND"
  | "EU_ONBOARDING_HUB"

type CardTextTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CardType =
  | "ACTIONABLE"
  | "INFORMATIVE"
  | "PROFILE"
  | "CHIP"

type CertificateBaseItemType =
  | "GOLD"
  | "REAL_ESTATE"

type CertificateUnitType =
  | "GRAM"
  | "QUANTITY"

type ChipType =
  | "ADR"
  | "RESTRICTION"
  | "PARITY"
  | "LEVERAGED"
  | "PTP"
  | "IPO"

type CircuitBreakerStateType =
  | "STOCK_BASED_CIRCUIT_BREAKER"
  | "INDEX_BASED_CIRCUIT_BREAKER"

type ClientFeature =
  | "EXPLORE_US"
  | "EXPLORE_TR"
  | "FX"
  | "WATCHLIST_RATE_APP"
  | "US_EXTENDED_HOURS"
  | "LIVE_CHAT"
  | "NEW_ORDER_FLOW"
  | "US_INTEREST_INCOME_RELEASE"
  | "CHATBOT"
  | "TR_INVESTMENT_FUNDS"
  | "NOTIFICATION_CENTER"
  | "TR_INSTANT_CASH"
  | "TRADE_CAMPAIGN_FUND_WELCOME"
  | "TRADE_CAMPAIGN_FUND_PAYBACK"
  | "CRYPTO_LIMIT_ORDER"
  | "CRYPTO_USD_TRADING"
  | "CRYPTO_WITHDRAWAL"
  | "CRYPTO_ASSET_TRANSFER_BETWEEN_MEMBERS"
  | "CRYPTO_DEPOSIT_BOOST_CAMPAIGN"
  | "CRYPTO_DEPOSIT_BOOST_CAMPAIGN_TAGS"
  | "FIRST_TX_RECOMMENDATION"
  | "US_MARGIN"
  | "TR_MARGIN"
  | "INTENT_DETECTION_ENABLED"
  | "MOVING_INSTRUMENT_NEWS"
  | "MARKET_EXCHANGE_SPREAD_ENABLED"
  | "CANDLESTICK_CHART"
  | "CRYPTO_STOP_ORDER"
  | "CRYPTO_CANDLESTICK"
  | "CRYPTO_ADVANCED_CHART_FEATURE"
  | "CHATBOT_GENERATIVE_AI"
  | "PROFIT_LOSS"
  | "ADVANCED_CHART"
  | "CHART_TIME_INTERVAL_SUGGESTION_ENABLED"
  | "MIDAS_PRO_RELEASE"
  | "SAVE_SCREENER_ENABLED"
  | "EXPANDABLE_WATCHLIST_ENABLED"
  | "SUBSCRIPTION_MIDAS_PRO_RELEASE"
  | "OPTION_ENABLED"
  | "INVESTMENT_CAMPAIGNS"
  | "TR_WARRANT"
  | "TR_VIOP_RELEASE"
  | "MIDAS_PRO_AI_ENABLED"
  | "CRYPTO_EXPANDABLE_WATCHLIST_ENABLED"
  | "NATIVE_CHAT"
  | "NATIVE_CHAT_INVESTMENT"
  | "CRYPTO_PORTFOLIO_VALUE_CHART"
  | "CRYPTO_PERFORMANCE_GRAPH_ENABLED"
  | "BULL_BEAR_INSIGHTS_ENABLED"
  | "CRYPTO_TRAILING_STOP_ORDER"
  | "SALESFORCE_MAINTENANCE"
  | "OPTIONS_RECOMMENDATION"
  | "MEMBER_FULL_STORY"
  | "EU_MARKETS_ENABLED"
  | "OVERNIGHT_TRADING_ENABLED"
  | "MONEY_TRANSFER_REDESIGN_RELEASE"
  | "MONEY_TRANSFER_ITERATIONS"
  | "MONEY_TRANSFER_CURRENCY_SELECTION"
  | "CRYPTO_MEMBER_FULL_STORY"
  | "FX_REDESIGN_RELEASE"
  | "APP_STORE_RATING_ENABLED"
  | "APP_STORE_RATING_STOCK_DETAIL_ENABLED"
  | "OPTIONS_PRICE_ALERT_ENABLED"
  | "WARRANT_PRICE_ALERT_ENABLED"
  | "UNIFIED_DISCOVERY_PAGE_ENABLED"
  | "UNIFIED_DISCOVERY_PAGE_ENABLED_V2"
  | "EMONEY"
  | "ONBOARDING_REDESIGN_RELEASE"
  | "MULTIPLE_ACCOUNTS_ENABLED"
  | "ASSET_CONTRACT_RESTRUCTURE_ENABLED"
  | "OVERVIEW_HERO_VISIBILITY"
  | "OVERVIEW_ONBOARDING_TIMELINE_VISIBILITY"
  | "OVERVIEW_ONBOARDING_HERO_AND_TIMELINE_VISIBILITY"
  | "OVERVIEW_CHARTS_ENABLED"

type CollateralStatus =
  | "SAFE"
  | "BALANCED"
  | "RISKY"
  | "MARGIN_CALL"
  | "COLLATERAL_DEFICIT"

type Color =
  | "RED"
  | "ORANGE"
  | "BLACK"

type ColorCode =
  | "GREEN"
  | "ORANGE"
  | "RED"
  | "GRAY"
  | "MIDAS_BLUE"

type ConformanceTestAction =
  | "RESTRICTED"
  | "PARTIALLY_ALLOWED"
  | "ALLOWED"

type ConformanceTestGroupType =
  | "MULTIPLE_QUESTION"
  | "SINGLE_QUESTION"

type ConformanceTestQuestionType =
  | "OPTIONS"
  | "INVESTMENT"
  | "MULTIPLE_CHOICE"

type ConsentVerificationFlowType =
  | "ONBOARDING"
  | "PHONE_NUMBER_CHANGE"
  | "MEMBER_SIM_BLOCKAGE_VERIFICATION"

type ContentDisplayType =
  | "LIST"
  | "STEP"
  | "PAGE"

type ContractGroupType =
  | "IN_APP"
  | "CRYPTO"

type ContractStatus =
  | "ACCEPTED"
  | "DECLINED"

type ContractTemplateType = "COMMERCIAL_AGREEMENT"

type ContractType =
  | "DIVIDEND_REINVESTMENT"
  | "FUND_PAYBACK"
  | "FUND_PAYBACK_INFO"

type Country =
  | "US"
  | "TR"
  | "FR"
  | "DE"
  | "BE"
  | "IT"
  | "IE"
  | "PT"
  | "NL"
  | "AT"
  | "ES"

type CountryFilter =
  | "ONBOARDING"
  | "ALL"

type CreditStar =
  | "ONE_STAR"
  | "TWO_STAR"
  | "THREE_STAR"

type CryptoAccountStatus =
  | "PASSIVE"
  | "INITIAL"
  | "WAITING_LEDGER"
  | "WAITING_MKK_REGISTRATION"
  | "SUSPENDED"
  | "ACTIVE"
  | "PASSIVE_COMPLIANCE"
  | "ACCOUNT_RESTRICTED"

type CryptoActionType = "COPY"

type CryptoButtonSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CryptoButtonStyle =
  | "FILLED"
  | "TINTED"
  | "GHOST"
  | "OUTLINED"
  | "DANGER"

type CryptoCashCurrency =
  | "USD"
  | "TRY"

type CryptoChartType =
  | "LINE"
  | "CANDLESTICK"
  | "ADVANCED"

type CryptoChipAction =
  | "DETAIL"
  | "DISMISS"

type CryptoHighlightSectionID =
  | "CRYPTO"
  | "DEFI"

type CryptoIndexType =
  | "MARKET_CAP"
  | "FEAR_AND_GREED"
  | "ALTCOIN_SEASON"
  | "BTC_DOMINANCE"

type CryptoIndicatorType =
  | "MA"
  | "RSI"
  | "MACD"
  | "BOLL"
  | "IC"
  | "SUPERTREND"

type CryptoInstrumentDisplayCardStyle =
  | "TINTED"
  | "OUTLINED"

type CryptoInstrumentIndicatorGraphColor =
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH1"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH2"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH3"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH4"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH5"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH6"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH7"
  | "INSTRUMENT_INDICATOR_GRAPH_COLOR_GRAPH8"

type CryptoInternalTransferSuccessAction =
  | "TRANSACTION_DETAIL"
  | "WAITING_TRANSACTIONS"

type CryptoListDetailTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListDetailTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CryptoListDetailTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type CryptoListDetailTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListDetailTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type CryptoListImageType =
  | "ICON"
  | "SYMBOL"
  | "LOGO"

type CryptoListInfoHorizontalSize =
  | "MEDIUM"
  | "LARGE"

type CryptoListInfoHorizontalTitleSubDescriptionSituation =
  | "DEFAULT"
  | "EMPHASIZED"

type CryptoListInfoHorizontalTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CryptoListInfoHorizontalTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type CryptoListInfoHorizontalTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListInfoHorizontalTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type CryptoListInfoVerticalSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CryptoListNavigateTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CryptoListNavigateTrailingTagSize =
  | "SMALL"
  | "XSMALL"
  | "XXSMALL"

type CryptoListTitleSubDescriptionTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListTitleSupporterTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListToggleSize =
  | "SMALL"
  | "MEDIUM"

type CryptoListToggleType =
  | "CHECKBOX"
  | "RADIOBOX"
  | "SWITCH"
  | "BOOKMARK"
  | "PLUS"

type CryptoListTrailingDescriptionTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListTrailingIconSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "INFO"
  | "DISABLED"

type CryptoListTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoListTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type CryptoMessageCardSituation =
  | "NEUTRAL"
  | "INFO"
  | "WARNING"
  | "DANGER"
  | "SUCCESS"

type CryptoMessageCardSize =
  | "SMALL"
  | "LARGE"

type CryptoMessageCardType =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CryptoMoneyTransferType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "INTERNAL_TRANSFER"

type CryptoOrderBase =
  | "AMOUNT_BASED"
  | "QUANTITY_BASED"

type CryptoOrderSide =
  | "BUY"
  | "SELL"

type CryptoOrderStatus =
  | "INITIALIZED"
  | "BROKER_INITIALIZED"
  | "STOP_INITIALIZED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELED"
  | "EXPIRED"

type CryptoOrderSuccessAction =
  | "TRANSACTION_DETAIL"
  | "WAITING_TRANSACTIONS"
  | "TPSL"
  | "PLACE_NEW_ORDER"

type CryptoOrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "TPSL"
  | "TRAILING_STOP"
  | "STOP_LIMIT"
  | "TPSL_LIMIT"

type CryptoOTPType =
  | "SMS"
  | "EMAIL"

type CryptoProfitLossChartType =
  | "TIME_WEIGHTED_RETURN"
  | "ASSET_FLOW"

type CryptoSectionCardSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CryptoSectionTitleSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"
  | "INFO"

type CryptoSectionTitleSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CryptoSectionTitleType =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"
  | "XLARGE"

type CryptoSheetMessageSituation =
  | "NEUTRAL"
  | "WARNING"
  | "DANGER"
  | "SUCCESS"
  | "INFO"

type CryptoStakingActionStatus =
  | "RECEIVED"
  | "IN_PROGRESS"
  | "WAITING_CANCEL"
  | "REJECTED"
  | "CANCELED"
  | "COMPLETED"

type CryptoStakingAssetDetailButtonAction = "BUY"

type CryptoStakingCardAction = "ACTIVATE_FLEX_STAKING"

type CryptoStakingSide =
  | "LOCK"
  | "UNLOCK"

type CryptoStakingSuccessAction = "TRANSACTION_DETAIL"

type CryptoSystemStatusType =
  | "ACTIVE"
  | "PASSIVE"

type CryptoTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CryptoTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type CryptoTargetingCardSize =
  | "XSMALL_STACK"
  | "XSMALL"
  | "SMALL"
  | "MEDIUM"

type CryptoTextButtonSize =
  | "SMALL"
  | "MEDIUM"

type CryptoTextButtonType =
  | "NEUTRAL"
  | "MIDAS_BLUE"
  | "DISABLED"

type CryptoTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CryptoTimeLineItemState =
  | "PASSIVE"
  | "UNCHECKED"
  | "CHECKED"
  | "CANCELLED"
  | "ACTIVE"
  | "WARNING"

type CryptoTimeRange =
  | "HOUR"
  | "INTRADAY"
  | "DAY"
  | "WEEK"
  | "MONTH"
  | "THREE_MONTH"
  | "YEAR"
  | "FIVE_YEAR"
  | "ALL_TIME"

type CryptoToastSituation =
  | "INFO"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type CryptoTransactionStatus =
  | "WAITING"
  | "SUCCESS"
  | "FAILED"
  | "REJECTED"
  | "CANCELED"
  | "EXPIRED"
  | "PARTIALLY_FILLED"
  | "PARTIALLY_CANCELED"
  | "PARTIALLY_EXPIRED"

type CryptoTransactionType =
  | "ORDER"
  | "MONEY_TRANSFER"
  | "CRYPTO_TRANSFER"
  | "REWARD"
  | "FIAT_REWARD"
  | "CRYPTO_STAKING"
  | "DUST_CONVERSION"
  | "CONVERSION"
  | "STAKING_ACTION"

type CryptoTransferSide =
  | "WITHDRAW"
  | "DEPOSIT"

type CryptoTravelRuleFormOwner =
  | "MYSELF"
  | "OTHER"

type CryptoType =
  | "CRYPTO"
  | "DEFI"

type CryptoWithdrawPrepareSectionCardAction = "SHOW_GOVERNMENT_LIMIT_SHEET"

type CryptoWithdrawSuccessAction =
  | "TRANSACTION_DETAIL"
  | "WAITING_TRANSACTIONS"

type CSHButtonSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CSHButtonStyle =
  | "FILLED"
  | "TINTED"
  | "GHOST"
  | "OUTLINED"
  | "DANGER"
  | "BRAND"

type CSHCampaignCardStyleType =
  | "OUTLINED"
  | "TINTED"

type CSHCardImageSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CSHCardImageTrailingSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHCardImageType =
  | "RIGHT"
  | "LEFT"
  | "HERO"

type CSHListBulletImageType =
  | "LOGO"
  | "ICON"
  | "SYMBOL"

type CSHListBulletSubDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"
  | "DISABLED"

type CSHListBulletSupporterTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"
  | "DISABLED"

type CSHListDetailTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHListDetailTrailingDescriptionSituation =
  | "DISABLED"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type CSHListImageType =
  | "ICON"
  | "SYMBOL"
  | "LOGO"

type CSHListInfoHorizontalTitleSubDescriptionSituation =
  | "DEFAULT"
  | "EMPHASIZED"

type CSHListInfoHorizontalTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CSHListInfoHorizontalTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type CSHListInfoHorizontalTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHListInfoHorizontalTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type CSHListInstrumentTitleSubDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHListInstrumentTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHListInstrumentTrailingSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHListInstrumentTrailingSize =
  | "SMALL"
  | "MEDIUM"

type CSHListNavigateTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHListNavigateTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type CSHListSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type CSHListTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CSHListToggleSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type CSHListToggleType =
  | "CHECKBOX"
  | "RADIOBOX"
  | "SWITCH"

type CSHListTrailingDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type CSHMessageCardSize =
  | "SMALL"
  | "LARGE"

type CSHMessageCardType =
  | "NEUTRAL"
  | "INFO"
  | "WARNING"
  | "DANGER"
  | "SUCCESS"

type CSHSheetMessageType =
  | "NEUTRAL"
  | "INFO"
  | "WARNING"
  | "DANGER"
  | "SUCCESS"

type CSHTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type CSHTagSize =
  | "XXSMALL"
  | "XSMALL"
  | "SMALL"

type CSHTargetingCardSize =
  | "XSMALL_STACK"
  | "XSMALL"
  | "SMALL"
  | "MEDIUM"

type CSHTargetingCardStyleType =
  | "OUTLINED"
  | "TINTED"

type CSHTextButtonSize =
  | "SMALL"
  | "MEDIUM"

type CSHTextButtonType =
  | "NEUTRAL"
  | "MIDAS_BLUE"
  | "DISABLED"

type CSHTimeLineItemState =
  | "ACTIVE"
  | "PASSIVE"
  | "UNCHECKED"
  | "CHECKED"
  | "CANCELLED"

type CSHToastSituation =
  | "INFO"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type CurrencyCode =
  | "USD"
  | "TRY"
  | "EUR"

type CurrencyPair =
  | "USD_TRY"
  | "EUR_TRY"
  | "EUR_USD"

type CustomerSupportItemType = "ARTICLE"

type DepositBankAccountStatus =
  | "ACTIVE"
  | "DELAYED"
  | "MAINTENANCE"

type DetailPageActionType =
  | "CANCEL"
  | "SETTINGS"
  | "UPDATE"
  | "DEEPLINK"
  | "DECIDE_DEPOSIT_ROUTING"
  | "CANCEL_DEPOSIT_ROUTING_TO_VIOP_COLLATERAL"

type DetailPageHeaderActionType = "SHOW"

type DeviceBindingAuthenticationType =
  | "CRYPTO_ASSET_WITHDRAW"
  | "CRYPTO_INTERNAL_ASSET_TRANSFER"

type DigestDirection =
  | "BUY"
  | "SELL"
  | "HOLD"

type DigestFeedbackState =
  | "POSITIVE"
  | "NEGATIVE"

type DiscoverCategory =
  | "BIST"
  | "US"
  | "TEFAS_FUND"
  | "CRYPTO"
  | "EU"
  | "US_OPTIONS"
  | "US_OPTIONS_BY_UNDERLYING"
  | "FUTURES"

type DiscoverListColumnKeyType =
  | "STOCK_PRICE"
  | "DAILY_CHANGE"
  | "WEEKLY_CHANGE"
  | "THREE_MONTH_CHANGE"
  | "YEARLY_CHANGE"
  | "DELTA"
  | "VOLUME"
  | "CUSTOM"

type DiscoverTagEnum =
  | "ANALYST_SELECTIONS"
  | "SUCCESSFUL_PORTFOLIOS"

type DiscoverTagSize =
  | "XSMALL"
  | "SMALL"

type DiscoveryAdvancedTool =
  | "INSTANT_BROKERAGE_DISTRIBUTION"
  | "TR_DEPTH"
  | "SETTLEMENT"
  | "ADVANCED_CHART"
  | "CANDLESTICK_CHART"
  | "PRICE_ALERT"
  | "CRYPTO_ADVANCED_CHART"
  | "OPTIONS"

type DiscoveryButtonSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type DiscoveryButtonStyle =
  | "FILLED"
  | "TINTED"
  | "GHOST"
  | "OUTLINED"
  | "DANGER"
  | "BRAND"

type DiscoveryChipFilterSize =
  | "medium"
  | "small"

type DiscoveryListDetailTitleSubDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type DiscoveryListDetailTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type DiscoveryListDetailTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type DiscoveryListDetailTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type DiscoveryListDetailTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type DiscoveryListDetailTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type DiscoveryListToggleIconSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type DiscoveryListToggleSize =
  | "SMALL"
  | "MEDIUM"

type DiscoveryListToggleTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type DiscoveryListToggleType =
  | "CHECKBOX"
  | "RADIOBOX"
  | "SWITCH"
  | "BOOKMARK"
  | "PLUS"

type DiscoveryTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type DiscoveryTagSize =
  | "XXSMALL"
  | "XSMALL"
  | "SMALL"

type DiscoveryTargetingCardSize =
  | "XSMALL"
  | "SMALL"
  | "MEDIUM"

type DiscoveryTargetingCardStyleType =
  | "OUTLINED"
  | "TINTED"

type DiscoveryTextButtonSize =
  | "SMALL"
  | "MEDIUM"

type DiscoveryToastSituation =
  | "INFO"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type DiscoveryValueSitutation =
  | "SUCCESS"
  | "DANGER"
  | "NEUTRAL"

type DividendReinvestmentStatus =
  | "PENDING"
  | "COMPLETED"
  | "UNSUCCESSFUL"

type DividendStatus =
  | "PENDING"
  | "COMPLETED"
  | "DELETED"
  | "UNKNOWN"
  | "PENDING_DIVIDEND_REINVESTMENT"

type DocumentFileSubType =
  | "RESIDENCE_CERTIFICATE"
  | "UTILITY_BILL"

type ExchangeOperationType =
  | "BUY"
  | "SELL"

type ExchangeRateExpandType =
  | "VOLUME_BASED_OFFER"
  | "MARKET_AVERAGE_SPREAD"
  | "MULTI_CURRENCY"

type ExerciseAction =
  | "DETAIL"
  | "PENDING_TRANSACTION"

type ExerciseStatus =
  | "PENDING"
  | "REJECTED"
  | "APPROVED"
  | "CANCELLED"

type ExerciseValidationStatus =
  | "ELIGIBLE"
  | "OTM"
  | "NOT_ENOUGH_BUYING_POWER"
  | "NOT_ENOUGH_UNDERLYING_ASSET"

type ExploreListColumnKeyType =
  | "STOCK_PRICE"
  | "DIVIDEND_YIELD"
  | "PRICE_EARNING"
  | "INDUSTRY_COMPARING"
  | "WEEKLY_CHANGE"
  | "MARKET_CAP"
  | "UPSIDE_POTENTIAL"

type FeatureApprovalStatus =
  | "FEATURE_HUB_REQUIRED"
  | "KYC_FAILED"
  | "KYC_WAITING"
  | "FEATURE_WAITING"
  | "COMPLETED"

type FeatureOnboardingFlowType =
  | "OPTIONS"
  | "WARRANT"
  | "CORPORATE_MARGIN"
  | "VIOP_ACCOUNT"
  | "VIOP_ADOPTION"
  | "EMONEY_ONBOARDING"

type FeatureRecommendationType = "OPTIONS"

type FileStatus =
  | "DECLINED"
  | "WAITING_REVIEW"
  | "ACCEPTED"

type FileType =
  | "IDENTITY_FRONT"
  | "IDENTITY_BACK"
  | "PROOF_ADDRESS"
  | "SELFIE"

type FooterAgreementsGenericGroupKey =
  | "CONSENT_LIVENESS"
  | "PRE_REGISTRATION"
  | "EXPLICIT_CONSENT_FORM"

type IdentityType =
  | "TC"
  | "TCKK"
  | "BLUE_CARD"
  | "NEW_BLUE_CARD"
  | "TEMPORARY_BLUE_CARD"
  | "TEMPORARY_CARD"
  | "FOREIGN_CITIZEN"
  | "INVALID"
  | "NONE"

type IndicatorType =
  | "SMA"
  | "EMA"
  | "RSI"
  | "MACD"
  | "BOLL"

type InfoBoxSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type InsightType =
  | "BULL"
  | "BEAR"

type InstantCashFlowType =
  | "T1"
  | "T2"

type InstrumentActivityType =
  | "ORDER"
  | "DIVIDEND_PAYMENT"
  | "NON_TRADE"

type InstrumentCategory =
  | "BIST"
  | "US"
  | "EU"

type InstrumentIndicatorGraphColor =
  | "GRAPH1"
  | "GRAPH2"
  | "GRAPH3"
  | "GRAPH4"
  | "GRAPH5"
  | "GRAPH6"
  | "GRAPH7"
  | "GRAPH8"

type InstrumentItemListingOrderType =
  | "HIGHEST_VALUE"
  | "PORTFOLIO_SIZE"
  | "INVESTOR_COUNT"

type InstrumentThemeReputation =
  | "VERY_REPUTABLE"
  | "REPUTABLE"
  | "REGULAR"

type InstrumentThemeTagStyle = "BLUE"

type InstrumentType =
  | "STOCK"
  | "INDEX"
  | "ETF"
  | "COUPON"
  | "PARITY"
  | "COMMODITY_CERTIFICATE"
  | "IPO"
  | "MUTUAL_FUND"
  | "CRYPTO"
  | "OPTIONS"
  | "WARRANT"
  | "FUTURES"

type InterestConsent =
  | "DISABLE"
  | "ENABLE"
  | "MIDAS_ONLY"
  | "DISABLED_INITIALLY"

type InterestIncomeStatus =
  | "ENABLED"
  | "DISABLED"
  | "DISABLED_INITIALLY"

type InterestIncomeSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type InvestmentType =
  | "MARKET_INSTRUMENTS"
  | "INVESTMENT_FUNDS"
  | "CRYPTO_INSTRUMENTS"
  | "OPTIONS"
  | "WARRANT"
  | "FUTURES"

type IpoInfoExternalState =
  | "WAITING"
  | "ACTIVE"
  | "EXPIRED"
  | "RESULTED"
  | "OTHER"

type IpoType =
  | "UPCOMING"
  | "PAST"

type JournalStatus =
  | "IN_PROGRESS"
  | "SUCCESS"
  | "CANCELED"
  | "CANCEL_REQUESTED"

type JournalType =
  | "DEPOSIT"
  | "WITHDRAWAL"

type KeyScope = "HIGH_RISK_TRANSACTION"

type ListDetailTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type ListDetailTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type ListDetailTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type ListDetailTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type ListDetailTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type ListInfoHorizontalTitleSubDescriptionSituation =
  | "DEFAULT"
  | "EMPHASIZED"

type ListInfoHorizontalTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type ListInfoHorizontalTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type ListInfoHorizontalTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type ListInfoHorizontalTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type ListInfoVerticalSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type ListingType =
  | "ALL"
  | "PERSONALIZED"

type ListInstrumentTitleSubDescriptionType =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type ListInstrumentTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type ListInstrumentTrailingDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type ListInstrumentTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type ListInstrumentTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type MarginActionFlow =
  | "HOW_TO_USE"
  | "ACTIVATION"

type MarginHealthState =
  | "GOOD"
  | "MODERATE"
  | "BAD"
  | "MARGIN_CALL"
  | "LOW_EQUITY"
  | "LOW_EQUITY_WITH_NO_CREDIT"
  | "LOW_EQUITY_WITH_CREDIT"
  | "CRITICAL_LEVEL"
  | "CRITICAL_LEVEL_BALANCE_IMPROVED"
  | "MARGIN_CALL_BALANCE_IMPROVED"
  | "DAY_TRADE_MARGIN_CALL"
  | "FREEZE"

type MarginOnboardingSource =
  | "HOW_TO_USE"
  | "BUYING_POWER"
  | "N_GROUP"
  | "CASH"

type MarginPropertyDeclarationQuestionType = "MULTIPLE_CHOICE"

type MarketDataChipFilterSize =
  | "medium"
  | "small"

type MarketDataListInstrumentTitleSubDescriptionType =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type MarketDataListInstrumentTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type MarketDataListInstrumentTrailingDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type MarketDataListInstrumentTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type MarketDataListInstrumentTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type MarketDataListNavigateTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type MarketDataListNavigateTrailingTagSize =
  | "SMALL"
  | "XSMALL"
  | "XXSMALL"

type MarketDataListToggleSize =
  | "SMALL"
  | "MEDIUM"

type MarketDataListToggleType =
  | "CHECKBOX"
  | "RADIOBOX"
  | "SWITCH"
  | "BOOKMARK"
  | "PLUS"

type MarketDataMDSSegmentItemSize =
  | "small"
  | "xsmall"

type MarketDataMDSSegmentSize =
  | "small"
  | "xsmall"

type MarketDataPriceAlertStatus =
  | "ACTIVE"
  | "EXECUTED"
  | "INACTIVE"

type MarketDataPriceAlertTriggerType =
  | "ONCE"
  | "RECURRING"

type MarketDataToastLinkSize =
  | "SMALL"
  | "MEDIUM"

type MarketDataToastSituation =
  | "INFO"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type MarketOutlookPredictionDirection =
  | "POSITIVE"
  | "NEGATIVE"

type MemberBankAccountIbanOwner =
  | "SELF"
  | "CUSTODIAN"

type MemberDividendReinvestmentStatus =
  | "ENABLED"
  | "DISABLED"
  | "DISABLED_INITIALLY"

type MemberDocumentFileType = "PROOF_ADDRESS"

type MemberMidasProSubscriptionOverviewStoryPageHeaderIconSize =
  | "SMALL"
  | "MEDIUM"

type MemberMidasProSubscriptionOverviewStoryPageVideoUrlType =
  | "LOCAL"
  | "REMOTE"

type MemberSubscriptionStatus =
  | "NO_SUBSCRIPTION"
  | "ACTIVE"
  | "CANCELLED"
  | "RENEWAL_PENDING"

type MemberType =
  | "CUSTODIAL"
  | "SOLE_PROPRIETORSHIP"
  | "CORPORATE"
  | "NON_TCKK_PERSONAL"

type MemberVerificationStep =
  | "OCR"
  | "B2B_OCR"
  | "NFC"
  | "LIVENESS"
  | "WAITING_RESULT"
  | "COMPLETED"
  | "VIDEO_ONBOARDING"

type MessageCardType =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type MessageType =
  | "STANDARD"
  | "FREE_TRADE"
  | "BIST"
  | "TR_POSITION_TRANSFER"
  | "PARTNER_LINK_IAM"
  | "CONTRACT"
  | "ONBOARDING_COMPLETED_VERIFICATION_REQUIRED"
  | "ONBOARDING_COMPLETED_TRANSFER_MONEY"

type MidasPlatform =
  | "INVESTMENT"
  | "CRYPTO"

type NewsDisplayType =
  | "DEFAULT"
  | "HERO_NEWS"

type NotificationCategorySource =
  | "MAIN"
  | "CRYPTO"

type NotificationDisplayType =
  | "READ"
  | "UNREAD"
  | "UNREAD_STACK"

type ONBChipSize =
  | "XXSMALL"
  | "XSMALL"
  | "SMALL"

type ONBListInfoHorizontalTrailingTextSituation = "NEUTRAL"

type ONBMessageCardSize =
  | "SMALL"
  | "LARGE"

type OnboardingFlowItemStatus =
  | "INITIAL"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "WARNING"

type OnboardingStatus =
  | "INITIAL"
  | "IN_PROGRESS"
  | "COMPLETED"

type OnboardingStep =
  | "IDENTITY_VERIFICATION"
  | "ADDRESS_VERIFICATION"
  | "PERSONAL_INFORMATION"
  | "AGREEMENTS_DISCLOSURES"
  | "DOCUMENT_UPLOAD"
  | "CUSTODIAN_IDENTITY_VERIFICATION"
  | "SELF_SERVICE_WEB"
  | "DELIVERY_ADDRESS"
  | "WAITING_APPROVAL"
  | "CONTRACT_DELIVERY"
  | "ONBOARDING_COMPLETED"
  | "VIDEO_ONBOARDING"
  | "AGENT_CALL_COMPLETED"
  | "SELF_SERVICE"
  | "SOLE_PROPRIETORSHIP_INFORMATION"
  | "CORPORATE_INFORMATION"
  | "COMPANY_FINANCIAL_INFORMATION"
  | "SOLE_PROPRIETORSHIP_INFORMATION_REVIEW"
  | "CORPORATE_SIGNATORY_MEMBER_INFORMATION"
  | "CORPORATE_DOCUMENTS_UPLOAD"
  | "CORPORATE_INFORMATION_REVIEW"
  | "CORPORATE_CONTRACT_DELIVERY"
  | "CORPORATE_SIGNATORIES_WAITING"
  | "CORPORATE_WAITING_APPROVAL"
  | "ADDRESS_DOCUMENT_UPLOAD"
  | "MEMBER_TAX_INFORMATION"
  | "CONTRACT_SIGNATORY_INFORMATION"
  | "DOCUMENT_REVIEW"
  | "ADDRESS_DOCUMENT_REVIEW"
  | "CONTRACT_SIGNATORY_WAITING"
  | "DOCUMENTS_APPROVAL_REVIEW"

type OnboardingStepAction =
  | "INFO_REQUIRED"
  | "CUSTODIAN"
  | "FAILED"
  | "CUSTODIAN_FAILED"
  | "CUSTODIAN_OPTION"
  | "CUSTODIAN_SELF_SERVICE"
  | "MEMBER_TYPE_CHANGE"
  | "ONBOARDING_HUB"
  | "CASH_DEPOSIT"

type ONBSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type ONBTargetingCardSize =
  | "XSMALL_STACK"
  | "XSMALL"
  | "SMALL"
  | "MEDIUM"

type OptionColumnSituation =
  | "SUCCESS"
  | "DANGER"

type OptionOrderType =
  | "BUY"
  | "SELL"

type OptionStyle =
  | "AMERICAN"
  | "EUROPEAN"

type OptionType =
  | "CALL"
  | "PUT"

type OptionValueSituation =
  | "NEUTRAL"
  | "SUCCESS"
  | "DANGER"

type OrderAction =
  | "EMIR_DETAY"
  | "BEKLEYEN_ISLEMLER"
  | "TPSL"
  | "NEW_ORDER"

type OrderBase =
  | "AMOUNT_BASED"
  | "QUANTITY_BASED"

type OrderGuidanceAction =
  | "LIMIT_ORDER"
  | "NO_ACTION"

type OrderInfoType =
  | "INFO"
  | "WARNING"

type OrderOperationType =
  | "BUY"
  | "SELL"

type OrderSide =
  | "BUY"
  | "SELL"

type OrderStatus =
  | "PENDING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "PENDING_CANCEL"
  | "PARTIALLY_CANCELED"
  | "PARTIALLY_EXPIRED"

type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "IPO"
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TAKE_PROFIT_AND_STOP_LOSS"
  | "DEMAND"
  | "TRAILING_STOP"
  | "MARKET_TO_LIMIT"

type OrderUpdateStatus =
  | "REJECTED"
  | "PENDING"
  | "ACCEPTED"

type OtpVerificationChannel =
  | "SMS"
  | "EMAIL"

type OtpVerificationType =
  | "CRYPTO_ASSET_WITHDRAW"
  | "CRYPTO_INTERNAL_ASSET_TRANSFER"

type OverviewInstrumentListItemType =
  | "DISCOVER_WEEKLY"
  | "WATCHLIST"
  | "DYNAMIC_LIST"
  | "SCREENER"
  | "OPTIONS_WATCHLIST"
  | "WARRANT_WATCHLIST"
  | "OPTIONS_SCREENER"
  | "WARRANT_SCREENER"
  | "FUTURE_SCREENER"

type OverviewInstrumentListItemTypeV2 =
  | "WEEKLY_RECOMMENDATION_LIST"
  | "WATCHLIST"
  | "DYNAMIC_LIST"
  | "OPTIONS_WATCHLIST"
  | "WARRANT_WATCHLIST"

type OverviewPositionsSubDescriptionSituation =
  | "NEUTRAL"
  | "SUCCESS"
  | "WARNING"
  | "DANGER"

type OverviewQuickActionType =
  | "BUY"
  | "SELL"

type PartnerMemberApproveStatus =
  | "REJECTED"
  | "APPROVED"

type PaymentMethod =
  | "CASH_BALANCE"
  | "MASTERPASS"
  | "IAP_APPLE"

type PDPButtonSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type PDPButtonStyle =
  | "FILLED"
  | "TINTED"
  | "GHOST"
  | "OUTLINED"
  | "DANGER"
  | "BRAND"

type PDPListDetailTitleSubDescriptionSituation =
  | "DEFAULT"
  | "EMPHASIZED"

type PDPListDetailTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type PDPListDetailTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type PDPListDetailTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type PDPListDetailTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type PDPListDetailTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type PDPListNavigateTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type PDPListNavigateTrailingTagSize =
  | "SMALL"
  | "XSMALL"
  | "XXSMALL"

type PDPListToggleSize =
  | "SMALL"
  | "MEDIUM"

type PDPListToggleType =
  | "CHECKBOX"
  | "RADIOBOX"
  | "SWITCH"
  | "BOOKMARK"
  | "PLUS"

type PDPTextButtonSize =
  | "SMALL"
  | "MEDIUM"

type PDPTextButtonType =
  | "NEUTRAL"
  | "MIDAS_BLUE"
  | "DISABLED"

type PdtResponseType =
  | "INFO"
  | "SUCCESS"
  | "WARNING"
  | "ERROR"

type PDTType =
  | "LIMITED_DAY_TRADE"
  | "UNLIMITED_DAY_TRADE"
  | "RESTRICTED_DAY_TRADE"
  | "ALREADY_REMOVED_RESTRICTED_DAY_TRADE"

type PhoneNumberChangeStep =
  | "IDENTITY_CHECK"
  | "PHONE_NUMBER_SELF_SERVICE"
  | "SELFIE_UPLOAD"
  | "NEW_PHONE_NUMBER_VALIDATION"
  | "OTP"
  | "OTP_VERIFIED"
  | "WAITING_APPROVAL"
  | "PASSWORD_CHECK"
  | "WAITING_SELF_SERVICE_APPROVAL"
  | "SELF_SERVICE_FAILED"
  | "PHONE_NUMBER_CHANGE_SUCCESSFUL"

type PhoneNumberChangeType =
  | "MEMBER"
  | "IDENTITY_VERIFIED"
  | "PRE_MEMBER"
  | "LOGGED_IN_MEMBER"
  | "CUSTODIAN_MEMBER"

type PortfolioPerformanceChartType =
  | "TIME_WEIGHTED_RETURN"
  | "ASSET_FLOW"

type PortfolioPerformanceTimeRange =
  | "INTRADAY"
  | "WEEK"
  | "MONTH"
  | "THREE_MONTH"
  | "SIX_MONTH"
  | "YTD"
  | "YEAR"
  | "ALL_TIME"

type PositionInfoChipType =
  | "ODD_LOT"
  | "FRACTIONAL"
  | "FRACTIONAL_FALSE"

type PositionIntent =
  | "BUY_TO_OPEN"
  | "BUY_TO_CLOSE"
  | "SELL_TO_OPEN"
  | "SELL_TO_CLOSE"

type PositionTransferDemandStatus =
  | "REJECTED"
  | "PENDING"
  | "COMPLETED"
  | "CANCELED"

type PositionTransferInfoActionType =
  | "WHATSAPP"
  | "CUSTOMER_SUPPORT"
  | "DOWNLOAD_FORM"
  | "BROKERAGE_HOUSE"

type PositionTransferReasonType =
  | "COLLECT_INVESTMENTS_IN_ONE_PLACE"
  | "PERSONAL_NEEDS"
  | "HIGH_COMMISSION"
  | "TEMPORARY_REASON"
  | "DIFFICULTIES_ON_APP"
  | "OTHER_REASONS"

type PositionTransferType =
  | "TO_MIDAS"
  | "FROM_MIDAS"
  | "INSIDE_MIDAS"
  | "FRACTIONAL"

type PreferenceStatus =
  | "ENABLED"
  | "DISABLED"
  | "DISABLED_INITIALLY"

type PriceAlertType =
  | "CROSSING_UP"
  | "CROSSING_DOWN"

type ProAnalysisContentType =
  | "TRUST"
  | "TITLE"
  | "BODY"

type ProAnalysisFeedbackState =
  | "NEUTRAL"
  | "LIKE"
  | "DISLIKE"

type ProAnalysisTradingSessionStatus =
  | "OPEN"
  | "CLOSE"
  | "PRE_HOURS"
  | "AFTER_HOURS"

type ProfitLossTimeRange =
  | "DAY"
  | "WEEK"
  | "MONTH"
  | "THREE_MONTH"
  | "SIX_MONTH"
  | "YEAR"
  | "THREE_YEAR"
  | "YEAR_TO_DATE"
  | "FIVE_YEAR"
  | "ALL_TIME"

type PromotionCardPlacement =
  | "BIST"
  | "US"
  | "EU"
  | "MUTUAL_FUND"
  | "OPTIONS"
  | "WARRANT"
  | "FUTURES"

type QualifiedInvestorDocumentReviewStatus =
  | "INITIAL"
  | "IN_REVIEW"
  | "ACCEPTED"
  | "REJECTED"
  | "SUSPICIOUS_REJECTED"

type RequestSource =
  | "CHAT_BOT"
  | "BACKEND"
  | "BUYING_POWER_PROMOTION"

type RightUsageStatus =
  | "FAILED"
  | "CANCELED"
  | "SUCCEEDED"

type RiskType =
  | "LOWEST"
  | "LOW"
  | "HIGH"
  | "HIGHEST"

type ScreenerInstrumentSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type SearchItemType =
  | "MARKET_INSTRUMENTS"
  | "INVESTMENT_FUNDS"
  | "CRYPTO_INSTRUMENTS"
  | "DEFI_CRYPTO_INSTRUMENTS"
  | "INSTRUMENT_LISTS"
  | "OPTIONS"
  | "WARRANT"
  | "ETF"
  | "FUTURES"

type SettlementColumnType =
  | "BROKERAGE"
  | "PERCENTAGE"
  | "PERCENTAGECHANGE"
  | "LOTCHANGE"
  | "TOTALLOT"

type SettlementType =
  | "UP"
  | "DOWN"
  | "TOTAL"

type Shape =
  | "CIRCLE"
  | "SQUARE"

type SignActionType =
  | "SIGN_CONTRACTS"
  | "SIGN_CONTRACTS_AND_ACTIVATE"

type SimBlockageStatus =
  | "INITIAL"
  | "WAITING_RESULT"
  | "COMPLETED"

type SimBlockageVerificationFlow =
  | "SELF_SERVICE"
  | "CUSTOMER_SERVICE"

type Situation =
  | "SUCCESS"
  | "NEUTRAL"
  | "WARNING"
  | "DANGER"

type StatusDescriptionColor =
  | "YELLOW"
  | "GREEN"
  | "RED"
  | "GRAY"

type StatusType =
  | "ACTIVE"
  | "PASSIVE"

type StoryMediaType =
  | "RIVE"
  | "VIDEO"
  | "IMAGE"

type StoryTextSize =
  | "DEFAULT"
  | "EMPHASIZED"
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type StoryType =
  | "CRM"
  | "WRAP_UP"

type StoryUrlType =
  | "LOCALE"
  | "REMOTE"

type SubMarketType =
  | "ANA_PAZAR"
  | "YILDIZ_PAZAR"
  | "ALT_PAZAR"
  | "HALKA_ARZI_BEKLENEN"
  | "YAKIN_IZLEME"
  | "PIYASA_ONCESI_ISLEM"
  | "BIST_RUCHAN_HAKLARI"
  | "YAPILANDIRILMIS_URUNLER"
  | "OTHER"

type SubscriptionCancelStep =
  | "SHOW_SURVEY"
  | "SHOW_OFFER"
  | "CANCEL"

type SuccessMessageType =
  | "TOAST"
  | "BOTTOMSHEET"

type SupportTicketType =
  | "POSITION_TRANSFER_FROM_MIDAS"
  | "POSITION_TRANSFER_INSIDE_MIDAS"
  | "POSITION_TRANSFER_ODD_LOT"
  | "POSITION_TRANSFER_FRACTIONAL"

type SurveyActionType =
  | "SELECTION"
  | "OTHER"

type SuspensionType =
  | "OTHER"
  | "CONFORMANCE_TEST_EXPIRATION"

type TaxPageType =
  | "INVESTMENT"
  | "DIVIDEND"
  | "INTEREST"
  | "DIVIDEND_STOCK"
  | "DIVIDEND_STOCK_DETAIL"

type TaxStatementApprovalStatus =
  | "APPROVED"
  | "NOT_APPROVED"

type TimeInForce =
  | "DAY"
  | "GTC"
  | "NIGHT"
  | "DAY_AND_NIGHT"

type TimeLineItemState =
  | "PASSIVE"
  | "UNCHECKED"
  | "CHECKED"
  | "CANCELLED"
  | "ACTIVE"

type TimeRange =
  | "DAY"
  | "INTRADAY"
  | "WEEK"
  | "MONTH"
  | "THREE_MONTH"
  | "SIX_MONTH"
  | "YEAR"
  | "THREE_YEAR"
  | "YEAR_TO_DATE"
  | "FIVE_YEAR"
  | "ALL_TIME"

type TimeSpan =
  | "MINUTE"
  | "HOUR"
  | "DAY"
  | "WEEK"
  | "MONTH"
  | "QUARTER"
  | "YEAR"

type TitleSize =
  | "MEDIUM"
  | "LARGE"

type ToastLinkSize =
  | "SMALL"
  | "MEDIUM"

type ToastSituation =
  | "INFO"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type TradeStateSectionCardSize =
  | "SMALL"
  | "MEDIUM"

type TradingSessionStatus =
  | "OPEN"
  | "CLOSE"
  | "PRE_HOURS"
  | "AFTER_HOURS"
  | "EVENING"
  | "OVERNIGHT"

type TradingStateType =
  | "STOCK_BASED_CIRCUIT_BREAKER"
  | "INDEX_BASED_CIRCUIT_BREAKER"
  | "TRADING_HALT"

type TradingTrendType =
  | "MIDAS"
  | "CUMULATIVE_BROKERAGE_DISTRIBUTION"
  | "INSIDERS"
  | "HEDGE_FUNDS"

type TransactionStatus =
  | "PENDING"
  | "COMPLETED"

type TransferDirection =
  | "INVESTMENT_TO_VIOP"
  | "VIOP_TO_INVESTMENT"

type TransferType =
  | "HAVALE"
  | "EFT"
  | "SWIFT"
  | "FAST"

type TransitionType =
  | "BOTTOM_TO_TOP"
  | "RIGHT_TO_LEFT"

type TRDButtonSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type TRDButtonStyle =
  | "FILLED"
  | "TINTED"
  | "GHOST"
  | "OUTLINED"
  | "DANGER"
  | "BRAND"

type TRDListDetailTitleSubDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type TRDListDetailTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type TRDListDetailTrailingDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type TRDListDetailTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type TRDListDetailTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type TRDListDetailTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type TRDListDetailTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type TRDListInfoHorizontalTitleSubDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type TRDListInfoHorizontalTrailingTagSituation =
  | "MIDAS_BLUE"
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type TRDListInfoHorizontalTrailingTagSize =
  | "XXSmall"
  | "XSmall"
  | "Small"

type TRDListInfoHorizontalTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "DISABLED"

type TRDListInfoHorizontalTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type TRDListInstrumentTitleSubDescriptionType =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type TRDListInstrumentTitleSupporterSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type TRDListInstrumentTrailingDescriptionSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type TRDListInstrumentTrailingTextSituation =
  | "NEUTRAL"
  | "DANGER"
  | "SUCCESS"
  | "WARNING"
  | "DISABLED"

type TRDListInstrumentTrailingTextSize =
  | "SMALL"
  | "MEDIUM"

type TRDMessageCardSize =
  | "SMALL"
  | "MEDIUM"
  | "LARGE"

type TRDMessageCardType =
  | "NEUTRAL"
  | "DANGER"
  | "WARNING"
  | "SUCCESS"
  | "INFO"

type TrdSheetMessageType =
  | "NEUTRAL"
  | "INFO"
  | "WARNING"
  | "DANGER"
  | "SUCCESS"

type TrdToastLinkSize =
  | "SMALL"
  | "MEDIUM"

type TrdToastSituation =
  | "INFO"
  | "SUCCESS"
  | "DANGER"
  | "WARNING"
  | "NEUTRAL"

type TRDTrailingDescriptionV2Situation =
  | "NEUTRAL"
  | "WARNING"
  | "SUCCESS"
  | "DANGER"

type TriggerMethod =
  | "TRIGGER_METHOD_ONCE"
  | "TRIGGER_METHOD_RECURRING"

type UserCampaignJourneyStep =
  | "INITIAL"
  | "ATTEMPTED"
  | "DESERVED"
  | "REWARDED"

type ValidationSource =
  | "MAIN"
  | "CRYPTO"

type ValidityPeriodCalendarActionType =
  | "SELECTION"
  | "CALENDAR"

type VerificationRequiredBlockageVerificationStatus =
  | "SELF_SERVICE"
  | "ACCOUNT_OWNERSHIP_CONFIRMATION"
  | "COMPLETED"

type VerificationRequiredOperationStatus =
  | "REQUIRED"
  | "IN_PROGRESS"
  | "NOT_REQUIRED"
  | "VERIFIED"

type VerificationRequiredOperationType =
  | "ADDRESS_CONFIRMATION"
  | "SELF_SERVICE"
  | "THIRD_PARTY_USAGE"
  | "CONTRACT_SIGN"
  | "COMPLIANCE_RESTRICT"
  | "COMPLIANCE_RESTRICT_AND_COMPLETE"

type VerificationType =
  | "CREATE_MEMBER"
  | "RESET_PASSWORD"
  | "LOGIN"
  | "POSITION_TRANSFER"
  | "PHONE_NUMBER_CHANGE"

type ViopProfitLossTimeRange =
  | "WEEK"
  | "MONTH"
  | "THREE_MONTH"
  | "YEAR_TO_DATE"
  | "YEAR"
  | "ALL_TIME"

type VIOPStatus =
  | "FAILED"
  | "SUBMITTED"
  | "ACTIVE"

type WarningAction =
  | "CLOSE"
  | "LIMIT_ORDER"

type WarrantColumnSituation =
  | "SUCCESS"
  | "DANGER"

type WarrantOrderType =
  | "BUY"
  | "SELL"

type WarrantStyle =
  | "AMERICAN"
  | "EUROPEAN"

type WarrantType =
  | "CALL"
  | "PUT"

type WarrantValueSituation =
  | "NEUTRAL"
  | "SUCCESS"
  | "DANGER"

type WithdrawalReceiverAccountType =
  | "BANK_ACCOUNT"
  | "INTERNAL_TRANSFER"
```

## GraphQL transport

```ts
interface GraphqlRequest<TVariables extends Record<string, unknown>> {
  operationName: string
  query: string
  variables: TVariables
}

interface GraphqlError {
  message?: string
  path?: Array<string | number>
  extensions?: {
    code?: string | number
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface GraphqlResponse<TData> {
  data?: TData
  errors?: GraphqlError[]
}
```

The response object for each operation is the selection tree in its exact GraphQL document. Named and inline fragment type conditions are indexed in [graphql-types.md](graphql-types.md#output-type-conditions).

## HTTP upload responses

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

The other upload routes return an empty successful response body (`void`).
