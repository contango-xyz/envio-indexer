import { ContangoSwapEvent, Lot, Position, Token } from "generated";
import { getMarkPrice } from "../../utils/common";
import { decodeTokenId } from "../../utils/getTokenDetails";
import { absolute, mulDiv } from "../../utils/math-helpers";
import { ContangoEvents, EventType, MigrationType, PositionUpsertedEvent, SwapEvent } from "../../utils/types";
import { OrganisedEvents } from "../helpers";
import { calculateDebtAndCollateral } from "./debtAndCollateral";
import { AccountingType } from "../lotsAccounting";

export enum ReferencePriceSource {
  SwapPrice = 'SwapPrice', // if there's a base<=>quote swap, we will use that value as the reference price
  MarkPrice = 'MarkPrice', // if there's no swap, we use the mark price (oracle price) as the reference price. trades that modify collateral|debt ONLY should have this
  FillPrice = 'FillPrice', // trades that should have mark price, but getting the mark price failed, should have this (if there is a valid fill price)
  AvgEntryPrice = 'AvgEntryPrice', // use the average entry price of the position as the reference price (migration without swap for example)
  None = 'None', // We default to this, and then error if attempting to save a fill item with no reference price
}

export const getBaseToQuoteFn = ({ price_long, collateralToken }: { price_long: bigint; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, price_long, collateralToken.unit)
export const getQuoteToBaseFn = ({ price_long, collateralToken }: { price_long: bigint; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, collateralToken.unit, price_long)

export const calculateFillPrice = ({ fillCost, delta, unit }: { fillCost: bigint; delta: bigint; unit: bigint; }) => {
  return absolute(mulDiv(fillCost, unit, delta))
}

export type ReferencePrices = {
  referencePrice_long: bigint;
  referencePrice_short: bigint;
  referencePriceSource: ReferencePriceSource
  cashflowSwap?: ContangoSwapEvent
}

export type PriceConverters = {
  baseToQuote: (amount: bigint) => bigint
  quoteToBase: (amount: bigint) => bigint
}

export const processSwapEvents = (debtToken: Token, collateralToken: Token, events: SwapEvent[]): ReferencePrices => {
  const referencePrices: ReferencePrices = {
    referencePrice_long: 0n,
    referencePrice_short: 0n,
    referencePriceSource: ReferencePriceSource.None,
    cashflowSwap: undefined,
  }

  for (const event of events) {
    const [tokenIn, tokenOut] = [event.tokenIn_id, event.tokenOut_id].map(decodeTokenId)
    if (tokenIn.address === debtToken.address && tokenOut.address === collateralToken.address) {
      referencePrices.referencePrice_long = mulDiv(event.amountIn, collateralToken.unit, event.amountOut)
      referencePrices.referencePrice_short = mulDiv(event.amountOut, debtToken.unit, event.amountIn)
      referencePrices.referencePriceSource = ReferencePriceSource.SwapPrice
    } else if (tokenIn.address === collateralToken.address && tokenOut.address === debtToken.address) {
      referencePrices.referencePrice_long = mulDiv(event.amountOut, collateralToken.unit, event.amountIn)
      referencePrices.referencePrice_short = mulDiv(event.amountIn, debtToken.unit, event.amountOut)
      referencePrices.referencePriceSource = ReferencePriceSource.SwapPrice
    } else {
      referencePrices.cashflowSwap = event
    }
  }

  return referencePrices
}

const processSwapEventsFromPositionUpsertedEvent = (debtToken: Token, collateralToken: Token, events: PositionUpsertedEvent[]): Omit<ReferencePrices, 'cashflowSwap'> => {
  const referencePrices = {
    referencePrice_long: 0n,
    referencePrice_short: 0n,
    referencePriceSource: ReferencePriceSource.None,
  }

  for (const event of events) {
    if (event.price) {
      referencePrices.referencePrice_long = event.price
      referencePrices.referencePrice_short = mulDiv(collateralToken.unit, debtToken.unit, event.price)
      referencePrices.referencePriceSource = ReferencePriceSource.SwapPrice
      break // we only need one, and there will only be one at most that has a price
    }
  }

  return referencePrices
}


const getReferencePrices = async (position: Position, debtToken: Token, collateralToken: Token, events: OrganisedEvents): Promise<ReferencePrices> => {

  // first assume we can get the reference prices from the swap events
  const swapEvents = events.swapEvents
  const result1 = processSwapEvents(debtToken, collateralToken, swapEvents)
  if (result1.referencePriceSource === ReferencePriceSource.SwapPrice) return result1

  // if we can't get the reference prices from the swap events, we'll get them from the position upserted events
  const positionUpsertedEvents = events.positionUpsertedEvents
  const result2 = processSwapEventsFromPositionUpsertedEvent(debtToken, collateralToken, positionUpsertedEvents)
  if (result2.referencePriceSource === ReferencePriceSource.SwapPrice) return { ...result2, cashflowSwap: result1.cashflowSwap } // we may have gotten the cashflow swap event form the swap events

  const allEvents = Object.values(events).filter((event) => event !== null).flat() as ContangoEvents[]
  const markPrice = await getMarkPrice({ chainId: position.chainId, positionId: position.contangoPositionId, blockNumber: allEvents[0].blockNumber, debtToken })
  if (markPrice) {
    return {
      referencePrice_long: markPrice,
      referencePrice_short: mulDiv(collateralToken.unit, debtToken.unit, markPrice),
      referencePriceSource: ReferencePriceSource.MarkPrice,
      cashflowSwap: result1.cashflowSwap, // same comment as above
    }
  }

  // if none of the above worked, we'll return zero values and a ReferencePriceSource.None
  // This will only work if the fill has no cashflows and hence having a reference price is not strictly necessary (for example, a liquidation)
  return {
    referencePrice_long: 0n,
    referencePrice_short: 0n,
    referencePriceSource: ReferencePriceSource.None,
    cashflowSwap: result1.cashflowSwap,
  }
}

export const getPrices = async ({ position, debtToken, collateralToken, organisedEvents }: { position: Position; debtToken: Token; collateralToken: Token; organisedEvents: OrganisedEvents; }): Promise<{ prices: ReferencePrices; converters: PriceConverters }> => {
  const prices = await getReferencePrices(position, debtToken, collateralToken, organisedEvents)
  const converters = {
    baseToQuote: getBaseToQuoteFn({ price_long: prices.referencePrice_long, collateralToken }),
    quoteToBase: getQuoteToBaseFn({ price_long: prices.referencePrice_long, collateralToken }),
  }
  return { prices, converters }
}

const calculateReferencePrice = (lots: Lot[], debtToken: Token, collateralToken: Token) => {
  const unit = lots[0].accountingType === AccountingType.Long ? collateralToken.unit : debtToken.unit
  const totalCost = lots.reduce((acc, curr) => acc + curr.grossOpenCost, 0n)
  const totalSize = lots.reduce((acc, curr) => acc + curr.size, 0n)
  return calculateFillPrice({ fillCost: totalCost, delta: totalSize, unit })
}


export const getPricesFromLots = ({ longLots, debtToken, collateralToken }: { longLots: Lot[]; debtToken: Token; collateralToken: Token; }): { prices: ReferencePrices; converters: PriceConverters } => {
  const referencePrice_long = calculateReferencePrice(longLots, debtToken, collateralToken)
  const quoteToBase = getQuoteToBaseFn({ price_long: referencePrice_long, collateralToken })
  const baseToQuote = getBaseToQuoteFn({ price_long: referencePrice_long, collateralToken })
  const referencePrice_short = quoteToBase(debtToken.unit)
  const converters = {
    baseToQuote,
    quoteToBase,
  }
  return { prices: { referencePrice_long, referencePrice_short, referencePriceSource: ReferencePriceSource.AvgEntryPrice }, converters }
}
