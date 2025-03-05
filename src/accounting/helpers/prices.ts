import { ContangoSwapEvent, Position, Token } from "generated";
import { getMarkPrice } from "../../utils/common";
import { decodeTokenId } from "../../utils/getTokenDetails";
import { mulDiv } from "../../utils/math-helpers";
import { ContangoEvents, EventType, PositionUpsertedEvent, SwapEvent } from "../../utils/types";
import { ReferencePriceSource } from "../helpers";

export type FillItemWithPrices = {
  referencePrice_long: bigint;
  referencePrice_short: bigint;
  referencePriceSource: ReferencePriceSource
  cashflowSwap?: ContangoSwapEvent
}

const processSwapEvents = (debtToken: Token, collateralToken: Token, events: SwapEvent[]): FillItemWithPrices => {
  const referencePrices: FillItemWithPrices = {
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

const processSwapEventsFromPositionUpsertedEvent = (debtToken: Token, collateralToken: Token, events: PositionUpsertedEvent[]): Omit<FillItemWithPrices, 'cashflowSwap'> => {
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

export const getReferencePrices = async (position: Position, debtToken: Token, collateralToken: Token, events: ContangoEvents[]): Promise<FillItemWithPrices> => {
  // first assume we can get the reference prices from the swap events
  const swapEvents = events.filter((event): event is SwapEvent => event.eventType === EventType.SWAP_EXECUTED)
  const result1 = processSwapEvents(debtToken, collateralToken, swapEvents)
  if (result1.referencePriceSource === ReferencePriceSource.SwapPrice) return result1

  // if we can't get the reference prices from the swap events, we'll get them from the position upserted events
  const positionUpsertedEvents = events.filter((event): event is PositionUpsertedEvent => event.eventType === EventType.POSITION_UPSERTED)
  const result2 = processSwapEventsFromPositionUpsertedEvent(debtToken, collateralToken, positionUpsertedEvents)
  if (result2.referencePriceSource === ReferencePriceSource.SwapPrice) return { ...result2, cashflowSwap: result1.cashflowSwap } // we may have gotten the cashflow swap event form the swap events

  const markPrice = await getMarkPrice({ chainId: position.chainId, positionId: position.contangoPositionId, blockNumber: events[0].blockNumber, debtToken })
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