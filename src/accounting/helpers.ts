import { Position, Token } from "generated";
import { getLiquidationPenalty } from "../Liquidations/common";
import { withCashflows } from "./helpers/cashflows";
import { calculateDebtAndCollateral } from "./helpers/debtAndCollateral";
import { OrganisedEvents } from "./helpers/eventStore";
import { withFees } from "./helpers/fees";
import { ReferencePriceSource, calculateFillPrice, getPrices } from "./helpers/prices";


export const eventsToPartialFillItem = async ({ position, debtToken, collateralToken, organisedEvents }: { position: Position; debtToken: Token; collateralToken: Token; organisedEvents: OrganisedEvents }) => {
  const { transferEvents, feeEvents, positionUpsertedEvents, liquidationEvents } = organisedEvents
  
  const { prices, converters } = await getPrices({ position, debtToken, collateralToken, organisedEvents})
  const debtAndCollateral = calculateDebtAndCollateral({ ...organisedEvents, converters, position })

  const { collateralDelta, debtDelta } = debtAndCollateral
  const fees = withFees({ converters, feeEvents, positionUpsertedEvents, collateralToken, debtToken })
  const cashflows = withCashflows({ converters, owner: position.owner, chainId: position.chainId, debtToken, collateralToken, transferEvents, prices: prices, fee_long: fees.fee_long, fee_short: fees.fee_short, liquidationEvents })
  const { cashflowQuote } = cashflows
  
  const liquidationPenalty = liquidationEvents.length > 0 ? getLiquidationPenalty({ collateralToken, collateralDelta, debtDelta, cashflowQuote, referencePrice: prices.referencePrice_long }) : 0n

  const fillCost_short = collateralDelta - cashflows.cashflowBase
  const fillCost_long = -(debtDelta + cashflows.cashflowQuote)

  const fillPrice_long = calculateFillPrice({ fillCost: fillCost_long, unit: collateralToken.unit, delta: collateralDelta })
  const fillPrice_short = calculateFillPrice({ fillCost: fillCost_short, unit: debtToken.unit, delta: debtDelta })

  if (prices.referencePriceSource === ReferencePriceSource.None) {
    if (fillCost_short !== 0n && fillCost_long !== 0n && cashflows.cashflow === 0n) {
      prices.referencePrice_long = fillPrice_long
      prices.referencePrice_short = fillPrice_short
      prices.referencePriceSource = ReferencePriceSource.FillPrice
    }
  }

  return { ...debtAndCollateral, ...fees, ...cashflows, ...prices, fillCost_short, fillCost_long, fillPrice_long, fillPrice_short, liquidationPenalty }
}

export type PartialFillItem = Awaited<ReturnType<typeof eventsToPartialFillItem>>

