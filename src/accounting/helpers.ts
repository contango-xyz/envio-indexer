import { Lot, Position, Token } from "generated";
import { absolute, mulDiv } from "../utils/math-helpers";
import { CollateralEvent, ContangoEvents, DebtEvent, EventType, FeeCollectedEvent, LiquidationEvent, PositionUpsertedEvent, SwapEvent, TransferEvent } from "../utils/types";
import { withCashflowsAndFee } from "./helpers/cashflows";
import { calculateDebtAndCollateral } from "./helpers/debtAndCollateral";
import { getReferencePrices } from "./helpers/prices";

export enum ReferencePriceSource {
  SwapPrice = 'SwapPrice', // if there's a base<=>quote swap, we will use that value as the reference price
  MarkPrice = 'MarkPrice', // if there's no swap, we use the mark price (oracle price) as the reference price. trades that modify collateral|debt ONLY should have this
  FillPrice = 'FillPrice', // trades that should have mark price, but getting the mark price failed, should have this (if there is a valid fill price)
  None = 'None', // We default to this, and then error if attempting to save a fill item with no reference price
}

const organizeEvents = (events: ContangoEvents[]) => {
  return events.reduce((acc, event) => {
    if (event.eventType === EventType.FEE_COLLECTED) acc.feeEvents.push(event)
    if (event.eventType === EventType.POSITION_UPSERTED) acc.positionUpsertedEvents.push(event)
    if (event.eventType === EventType.SWAP_EXECUTED) acc.swapEvents.push(event)
    if (event.eventType === EventType.DEBT) acc.debtEvents.push(event)
    if (event.eventType === EventType.COLLATERAL) acc.collateralEvents.push(event)
    if (event.eventType === EventType.LIQUIDATION) acc.liquidationEvents.push(event)
    if (event.eventType === EventType.TRANSFER) acc.transferEvents.push(event)
    return acc
  }, { transferEvents: [] as TransferEvent[], feeEvents: [] as FeeCollectedEvent[], positionUpsertedEvents: [] as PositionUpsertedEvent[], swapEvents: [] as SwapEvent[], debtEvents: [] as DebtEvent[], collateralEvents: [] as CollateralEvent[], liquidationEvents: [] as LiquidationEvent[] })
}

export const eventsToPartialFillItem = async ({ position, debtToken, collateralToken, events, lots }: { lots: Lot[]; position: Position; debtToken: Token; collateralToken: Token; events: ContangoEvents[]; }) => {
  const { transferEvents, feeEvents, positionUpsertedEvents, swapEvents, debtEvents, collateralEvents, liquidationEvents } = organizeEvents(events)

  const withPrices = await getReferencePrices(position, debtToken, collateralToken, events)
  const withDebtAndCollateral = calculateDebtAndCollateral({ position, debtEvents, collateralEvents, positionUpsertedEvents, prices: withPrices, collateralToken, liquidationEvents })
  const partialFillItem = withCashflowsAndFee({ position, partialFillItem: withDebtAndCollateral, debtToken, collateralToken, transferEvents, feeEvent: feeEvents[0] })

  const fillCost_short = partialFillItem.collateralDelta - partialFillItem.cashflowBase
  const fillCost_long = -(partialFillItem.debtDelta + partialFillItem.cashflowQuote)

  const fillPrice_long = calculateFillPrice({ fillCost: fillCost_long, unit: collateralToken.unit, delta: partialFillItem.collateralDelta })
  const fillPrice_short = calculateFillPrice({ fillCost: fillCost_short, unit: debtToken.unit, delta: partialFillItem.debtDelta })

  if (partialFillItem.referencePriceSource === ReferencePriceSource.None) {
    if (fillCost_short !== 0n && fillCost_long !== 0n && partialFillItem.cashflow === 0n) {
      partialFillItem.referencePrice_long = fillPrice_long
      partialFillItem.referencePrice_short = fillPrice_short
      partialFillItem.referencePriceSource = ReferencePriceSource.FillPrice
    }
  }

  return { ...partialFillItem, fillCost_short, fillCost_long, fillPrice_long, fillPrice_short }
}

export type PartialFillItem = Awaited<ReturnType<typeof eventsToPartialFillItem>>

export const calculateFillPrice = ({ fillCost, delta, unit }: { fillCost: bigint; delta: bigint; unit: bigint; }) => {
  return absolute(mulDiv(fillCost, unit, delta))
}
