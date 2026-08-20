import { defineOperation } from "./graphql.ts"

type ProviderOrderSide = "BUY" | "SELL"
type ProviderOrderType = "LIMIT"
type ProviderPositionIntent = "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE"

export interface AssetFutureData {
  assetFuture?: {
    uid: string
    underlyingInstrumentUid?: string | null
    multiplier?: number | null
    redemptionDate?: string | null
    tradingState?: string | null
    tradePriceAndQuote?: {
      ask?: number | null
      bid?: number | null
      askSize?: number | null
      bidSize?: number | null
      futurePrice?: number | null
    } | null
    priceFormat?: { scale?: number | null } | null
    marketDataProviderInMaintenance?: boolean | null
    collateralDataProviderInMaintenance?: boolean | null
  } | null
}

export interface AssetFutureVariables {
  instrumentId: string
  memberId: string
}

export interface OrderPreparationData {
  orderPreparationV2?: {
    type?: string | null
    buyingPowerDecoupled?: number | null
    availableOrderTypes?: string[] | null
    priceRange?: {
      maxPrice?: number | null
      minPrice?: number | null
      fatFingerMaxPrice?: number | null
      fatFingerMinPrice?: number | null
    } | null
    validityPeriodDto?: {
      tradingRangeDto?: {
        validityPeriodCalendarItems?: Array<{
          isActive?: boolean | null
          timeInForce?: string | null
          fatFingerMaxPrice?: number | null
          fatFingerMinPrice?: number | null
        }> | null
      } | null
    } | null
    warning?: { title?: string | null; body?: string | null } | null
    agreementType?: string | null
    initialCollateral?: number | null
    popup?: { title?: string | null; body?: string | null } | null
  } | null
}

export interface OrderPreparationVariables {
  orderId: string | null
  instrumentId: string
  accountId: string
  orderSide: ProviderOrderSide
  orderType: ProviderOrderType
  positionIntent: ProviderPositionIntent
}

export interface PlaceOrderData {
  placeOrderV2?: {
    order?: {
      uid?: string | null
      status?: string | null
      statusDescription?: string | null
    } | null
    orderSuccess?: {
      messageCard?: {
        messageCard?: {
          title?: string | null
          description?: string | null
        } | null
      } | null
    } | null
  } | null
}

export interface PlaceOrderVariables {
  instrumentId: string
  accountId: string
  quantity: number
  notional: null
  price: null
  stopPrice: null
  limitPrice: number
  profitPrice: null
  profitRate: null
  lossPrice: null
  lossRate: null
  isProfitByRatio: null
  isLossByRatio: null
  timeInForce: "DAY"
  orderSide: ProviderOrderSide
  orderType: ProviderOrderType
  agreementType: null
  shouldPlaceInExtendedHours: false
  endingDate: null
  investmentType: "FUTURES"
  positionIntent: ProviderPositionIntent
}

export interface CancelOrderData {
  cancelOrder?: {
    order?: {
      uid?: string | null
      status?: string | null
      statusDescription?: string | null
    } | null
  } | null
}

export interface CancelOrderVariables {
  accountId: string
  orderId: string
  instrumentId: string | null
}

export const tradingOperations = {
  assetFuture: defineOperation<AssetFutureData, AssetFutureVariables>(
    "assetFuture",
    "query",
    "query assetFuture($instrumentId: String!, $memberId: String!) { assetFuture(uid: $instrumentId) { uid underlyingInstrumentUid multiplier redemptionDate tradingState tradePriceAndQuote { ask bid askSize bidSize futurePrice: price } priceFormat { scale } usedCollateralInfo { title url } activePriceAlert(memberUid: $memberId) { active } marketDataProviderInMaintenance collateralDataProviderInMaintenance } }",
  ),
  prepareOrder: defineOperation<OrderPreparationData, OrderPreparationVariables>(
    "prepareOrder",
    "query",
    "query prepareOrder($orderId: String, $instrumentId: String!, $accountId: String!, $orderSide: OrderSide!, $orderType: OrderType, $positionIntent: PositionIntent) { orderPreparationV2(accountUid: $accountId, input: { orderUid: $orderId stockUid: $instrumentId side: $orderSide type: $orderType allowDecoupling: true positionIntent: $positionIntent } ) { type buyingPowerDecoupled transactionFeeDecoupled defaultTransactionFee transactionCommissionRate defaultTransactionCommissionRate availableSharesDecoupled pennyStockPricingActive quantityLimitForPennyStockFee perQuantityFeeForPennyStock defaultPerQuantityFeeForPennyStock cashMargin isFractionable orderBases acceptedOrderBases thresholds { minimumPrice maximumPrice threshold } thresholdPricingActive feeThresholds { lowerBound upperBound fee } priceSteps { minimumPrice maximumPrice priceStep } eligibleToPlaceExtendedHoursOrder restrictionStartDateTime restrictionEndDateTime bsmvCommissionRate transactionFeeMessage tradeFeeInfo { title body } cashMarginInfoNew { title body } tradeFeeAndCashMarginInfo { body title } certificateInfo { __typename ...midasCertificatePositionModifier } priceRange(input: { orderUid: $orderId stockUid: $instrumentId side: $orderSide type: $orderType } ) { maxPrice minPrice fatFingerMaxPrice fatFingerMinPrice } orderGuidanceType orderGuidanceInfo { title detailInfoText detailTitle detailBody detailUrl orderGuidanceAction orderGuidanceActionTitle } orderCardInfoType orderCardInfo { orderInfoType detailInfoText detailTitle detailBody detailUrl } warning(input: { orderUid: $orderId stockUid: $instrumentId side: $orderSide type: $orderType } ) { title body warningAction warningsMoreInfo { title body } warningType } agreementType agreementInfo { infoTitle longTitle agreementHighlight agreementBody buttonText } fundPreparationDto { coefficient maxQuantity minQuantity minBuyAmountBasedMargin executionDate executionDateInfoTitle executionDateInfoUrl minAmount } reviewInfo { __typename ...midasReviewInfo } defaultOrderBase validityPeriodDto { tradingRangeDto { __typename ...midasValidityPeriodCalendarDto } outOfRangeDto { __typename ...midasValidityPeriodCalendarDto } } marginDetailsV2 { title buyingPower infoAction { title url clickEvent { __typename ...midasTRDAnalyticsEvent } } orderInfoItemList { creditScore item { __typename ...midasListInfoHorizontal } } buyingPowerInfoItemList { __typename ...midasTRDListInfoHorizontalSmall } ngroupLimitItem { ngroupEnabled item { __typename ...midasTRDListInfoHorizontalSmall } } } buyingPowerInfo { title message analyticsValue } dtmcThresholdQty dtmcReviewInfo { __typename ...midasReviewInfo } initialInputQuantity isFreeCommissionForBIST eligibleForTrMarginPromotion eligibleForTrMarginPromotionIfInsufficientBuyingPower eligibleForTrMarginNGroupPromotion contract { agreementFullText agreementUrlText agreementContractPageTitle contractPageData actionButtonTitle } isOrderCancellationRestricted bistOrderCollectionPhaseRemaining bistOrderClosingPhaseRemaining availableOrderTypes overnightTrade optionType positionIntent collateralInfo { title body collateralTextIdentifier buttonText detailUrl orderInfoType } initialCollateral ipoBuyRestricted ipoWarning { title body footerNote initPricePercentage } popup { title body analytics { __typename ...midasTRDAnalyticsEvent } } isExtendedFracStatusDifferentForLimitOrderV2 nonExtendedDayOrderValidity { __typename ...midasValidityPeriodCalendarItemDto } nonExtendedGTCOrderValidity { __typename ...midasValidityPeriodCalendarItemDto } hasCollateralDepositRecord creditUsed tradableWithMargin marginEnabled buyingPowerWithoutCredit assetSessionEligibility remainingContractBasedFreeTradeCount ipoBookBuildingType validations { fatFingerMaxMultiplier fatFingerMinMultiplier } } }  fragment midasCertificatePositionModifier on CommodityCertificateInfo { baseItemCustomName baseItemType amount unitType unitSymbol buttons { title quantity } }  fragment midasReviewInfo on ReviewInfo { title description buttonTitle detailTitle detailUrl detailBody infoType }  fragment midasValidityPeriodCalendarDto on ValidityPeriodCalendarDto { validityPeriodCalendarItems { isActive title subtitle shortSubtitle isSelected isHighlighted updated selectedOrderDate actionType timeInForce fatFingerMaxPrice fatFingerMinPrice } calendarItems }  fragment midasTRDAnalyticsEvent on TRDAnalyticsEvent { name params { key value } }  fragment midasListInfoHorizontal on ListInfoHorizontal { title titleSupporter { iconUrl titleSupporterAction { __typename ... on ListInfoHorizontalSupporterDeepLinkAction { deepLinkUrl } ... on ListInfoHorizontalSupporterWebViewAction { title url } } } titleDescription { description subDescription { text situation } } trailing { __typename ... on ListInfoHorizontalTrailingText { text situation size } ... on ListInfoHorizontalTrailingTag { tagText tagSituation tagSize tagIconUrl } ... on ListInfoHorizontalTrailingIcon { iconUrl } } trailingDescription }  fragment midasTRDListInfoHorizontalSmall on TRDListInfoHorizontalSmall { title titleSupporterUrl titleSupporter { iconUrl titleSupporterAction { __typename ... on TRDListInfoHorizontalSupporterDeepLinkAction { deepLinkUrl } ... on TRDListInfoHorizontalSupporterWebViewAction { title url } ... on TRDListInfoHorizontalSupporterNoAction { title description } } } trdListInfoHorizontalSmallTrailing: trailing { __typename ... on TRDListInfoHorizontalTrailingText { text situation size } ... on TRDListInfoHorizontalTrailingIcon { iconUrl } ... on TRDListInfoHorizontalTrailingTag { tagText tagIconUrl tagSize tagSituation } } }  fragment midasValidityPeriodCalendarItemDto on ValidityPeriodCalendarItemDto { isActive title subtitle shortSubtitle isSelected isHighlighted updated selectedOrderDate actionType timeInForce fatFingerMaxPrice fatFingerMinPrice }",
  ),
  cancelOrder: defineOperation<CancelOrderData, CancelOrderVariables>(
    "cancelOrder",
    "mutation",
    "mutation cancelOrder($accountId: String!, $orderId: String!, $instrumentId: String) { cancelOrder(accountUid: $accountId, orderId: $orderId, stockUid: $instrumentId) { order { __typename ...midasOrder } } }  fragment midasInstrument on Instrument { __typename uid name symbol logoUrl country type ... on StockV2 { marketName marketSymbol subMarket { type name } buyable sellable fractionable grossSettlement isAdr } ... on Coupon { marketName marketSymbol subMarket { type name } buyable sellable } ... on Etf { marketName marketSymbol subMarket { type name } buyable sellable fractionable grossSettlement } ... on CommodityCertificate { marketName marketSymbol buyable sellable } ... on InitialPublicOffering { marketName marketSymbol } ... on MutualFund { marketName marketSymbol buyable sellable } ... on Parity { buyable sellable } ... on Option { shortName underlyingInstrumentUid underlyingInstrumentSymbol expirationDate strikePrice optionMultiplier: multiplier buyable sellable lateClose { closeDateTime } optionType isExpired expirationInfo { date url sellUrl } } ... on Warrant { shortName isUnderlyingVisible underlyingInstrumentUid underlyingInstrumentName underlyingInstrumentType underlyingInstrumentSymbol expirationDate strikePrice buyable sellable isExpired expirationInfo { date url sellUrl } } ... on Future { underlyingInstrumentUid futureMultiplier: multiplier buyable sellable usedCollateralInfo { title url } } }  fragment midasTimelineItem on TimeLineItem { state title subTitle info { title url isStarred body } }  fragment midasOrder on OrderResponse { uid stockUid accountUid createdAt updatedAt type status statusDescription side timeInForce limitPrice stopPrice profitPrice profitRate lossPrice lossRate filledAveragePrice totalPrice transactionFee notional quantity filledQuantity filledAt cancelSubmittedAt canceledAt showCancel showUpdate cancelButtonText isReward isFractionalFalse extendedHours country instrument { __typename ...midasInstrument } rejectedAt rejectReasonShortDescription rejectReasonLongDescription orderUpdateStateV2 { status previousLimitPrice previousStopPrice previousQuantity rejectReasonLongDescription rejectReasonShortDescription } dividendPaymentInfo { uid descriptionType descriptionValue } statusInformation timelines { __typename ...midasTimelineItem } timeInForceDescription isFreeCommissionForBIST }",
  ),
  placeOrder: defineOperation<PlaceOrderData, PlaceOrderVariables>(
    "placeOrder",
    "mutation",
    "mutation placeOrder($instrumentId: String!, $accountId: String!, $quantity: Float, $notional: Float, $price: Float, $stopPrice: Float, $limitPrice: Float, $profitPrice: Float, $profitRate: Float, $lossPrice: Float, $lossRate: Float, $isProfitByRatio: Boolean, $isLossByRatio: Boolean, $timeInForce: TimeInForce, $orderSide: OrderSide!, $orderType: OrderType!, $agreementType: String, $shouldPlaceInExtendedHours: Boolean, $endingDate: Date, $investmentType: InvestmentType, $positionIntent: PositionIntent) { placeOrderV2(accountUid: $accountId, input: { quantity: $quantity notional: $notional nominalPrice: $price stopPrice: $stopPrice limitPrice: $limitPrice profitPrice: $profitPrice profitRate: $profitRate lossPrice: $lossPrice lossRate: $lossRate isProfitByRatio: $isProfitByRatio isLossByRatio: $isLossByRatio timeInForce: $timeInForce stockUid: $instrumentId side: $orderSide type: $orderType agreementType: $agreementType extendedHours: $shouldPlaceInExtendedHours endingDate: $endingDate investmentType: $investmentType positionIntent: $positionIntent } ) { order { __typename ...midasOrder } orderSuccess { __typename ...midasOrderSuccess } } }  fragment midasInstrument on Instrument { __typename uid name symbol logoUrl country type ... on StockV2 { marketName marketSymbol subMarket { type name } buyable sellable fractionable grossSettlement isAdr } ... on Coupon { marketName marketSymbol subMarket { type name } buyable sellable } ... on Etf { marketName marketSymbol subMarket { type name } buyable sellable fractionable grossSettlement } ... on CommodityCertificate { marketName marketSymbol buyable sellable } ... on InitialPublicOffering { marketName marketSymbol } ... on MutualFund { marketName marketSymbol buyable sellable } ... on Parity { buyable sellable } ... on Option { shortName underlyingInstrumentUid underlyingInstrumentSymbol expirationDate strikePrice optionMultiplier: multiplier buyable sellable lateClose { closeDateTime } optionType isExpired expirationInfo { date url sellUrl } } ... on Warrant { shortName isUnderlyingVisible underlyingInstrumentUid underlyingInstrumentName underlyingInstrumentType underlyingInstrumentSymbol expirationDate strikePrice buyable sellable isExpired expirationInfo { date url sellUrl } } ... on Future { underlyingInstrumentUid futureMultiplier: multiplier buyable sellable usedCollateralInfo { title url } } }  fragment midasTimelineItem on TimeLineItem { state title subTitle info { title url isStarred body } }  fragment midasOrder on OrderResponse { uid stockUid accountUid createdAt updatedAt type status statusDescription side timeInForce limitPrice stopPrice profitPrice profitRate lossPrice lossRate filledAveragePrice totalPrice transactionFee notional quantity filledQuantity filledAt cancelSubmittedAt canceledAt showCancel showUpdate cancelButtonText isReward isFractionalFalse extendedHours country instrument { __typename ...midasInstrument } rejectedAt rejectReasonShortDescription rejectReasonLongDescription orderUpdateStateV2 { status previousLimitPrice previousStopPrice previousQuantity rejectReasonLongDescription rejectReasonShortDescription } dividendPaymentInfo { uid descriptionType descriptionValue } statusInformation timelines { __typename ...midasTimelineItem } timeInForceDescription isFreeCommissionForBIST }  fragment midasTRDMessageCardV2 on TRDMessageCardV2 { situation hasIcon title description link linkDeeplink size isClosable }  fragment midasOrderSuccess on OrderSuccessResponse { orderBodyItemList { title subtitle value subValue infoTitle infoDescription } summaryInfo { message title imageUrl detailAction detailTitle detailDescription detailDeepLink imageUrl showOneTime cardId analyticsEventName } orderActionList deepLinkAfterCompleted messageCard { type messageCard { __typename ...midasTRDMessageCardV2 } } }",
  ),
} as const
