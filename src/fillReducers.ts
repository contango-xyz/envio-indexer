import {
  ContangoPositionUpsertedEvent,
  ContangoProxy_PositionUpserted_event,
  FillItem,
  handlerContext
} from "generated";
import { getPairForPositionId, getPosition } from "./utils/common";
import { createFillItemId } from "./utils/ids";
import { mulDiv } from "./utils/math-helpers";
import { FillItemType, GenericEvent } from "./utils/types";

export const getOrCreateFillItem = async ({ positionId, context, ...event }: Omit<GenericEvent, 'logIndex'> & { positionId: string; context: handlerContext }) => {
  const id = createFillItemId({ ...event, positionId })
  const fillItem = await context.FillItem.get(id)
  if (!fillItem) {
    const fillItem: FillItem = {
      id,
      chainId: event.chainId,
      blockNumber: event.blockNumber,
      positionId,
      collateralDelta: 0n,
      debtDelta: 0n,
      fee: 0n,
      cashflowQuote: 0n,
      cashflowBase: 0n,
      feeToken_id: undefined, // initialise with the debt token
      cashflowSwap_id: undefined,
      timestamp: event.blockTimestamp,
      transactionHash: event.transactionHash,
      fillItemType: FillItemType.Trade,
      liquidationPenalty: 0n,
      realisedPnl_long: 0n,
      realisedPnl_short: 0n,
      tradePrice_long: 0n,
      tradePrice_short: 0n,
      lendingProfitToSettle: 0n,
      debtCostToSettle: 0n,
      fee_long: 0n,
      fee_short: 0n,
    }
    context.FillItem.set(fillItem)

    return { ...fillItem }
  }
  return { ...fillItem }
}


export enum CashflowCurrency {
  None,
  Base,
  Quote,
}

export const handleCollateralAndDebtEvents_BeforeNewEventsExisted = async ({ upsertedEvent, chainId, blockNumber, fillItem, context }: { upsertedEvent: ContangoProxy_PositionUpserted_event; chainId: number; blockNumber: number; fillItem: FillItem; context: handlerContext }) => {
  const { quantityDelta, price, cashflowCcy, cashflow, positionId } = upsertedEvent.params

  const position = await getPosition({ chainId, positionId, context })
  const newFillItem = { ...fillItem }
  const { collateralToken, debtToken } = await getPairForPositionId({ chainId, positionId, context })

  newFillItem.tradePrice_long = price || newFillItem.tradePrice_long
  newFillItem.tradePrice_short = mulDiv(collateralToken.unit, debtToken.unit, price) || newFillItem.tradePrice_short
  newFillItem.collateralDelta += quantityDelta
  
  let accruedLendingProfit = 0n

  if ((position.collateral + quantityDelta) <= 0n) {
    // we know this must be a closing fill event
    accruedLendingProfit = -position.collateral - quantityDelta
  }

  // figure out debt delta
  let debtDelta = 0n
  let accruedInterest = 0n

  if (price > 0n) {
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      const amountBorrowed = quantityDelta - cashflow
      debtDelta = mulDiv(amountBorrowed, price, collateralToken.unit)
    } else {
      const amountOut = mulDiv(quantityDelta, price, collateralToken.unit)
      debtDelta = amountOut - cashflow
    }
  }

  if (position.debt + debtDelta < 0n) {
    // we know this must be a closing fill event
    accruedInterest = -position.debt - debtDelta
  }

  // probably processing a strategy transaction
  if (quantityDelta === 0n) {
    // edge case where we're not processing a strategy transaction
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      debtDelta -= mulDiv(cashflow, price, collateralToken.unit)
    }
    debtDelta = -cashflow
  }

  newFillItem.debtDelta += debtDelta
  newFillItem.lendingProfitToSettle = accruedLendingProfit
  newFillItem.debtCostToSettle = accruedInterest
  
  return newFillItem
};



export const handleCollateralAndDebtEvents_BeforeNewEventsExisted_new = async ({ upsertedEvent, chainId, fillItem, context }: { upsertedEvent: ContangoPositionUpsertedEvent; chainId: number; fillItem: FillItem; context: handlerContext }) => {
  const { quantityDelta, price, cashflowCcy, cashflow, positionId } = upsertedEvent

  const position = await getPosition({ chainId, positionId, context })
  const newFillItem = { ...fillItem }
  const { collateralToken, debtToken } = await getPairForPositionId({ chainId, positionId, context })

  newFillItem.tradePrice_long = price || newFillItem.tradePrice_long
  newFillItem.tradePrice_short = mulDiv(collateralToken.unit, debtToken.unit, price) || newFillItem.tradePrice_short
  newFillItem.collateralDelta += quantityDelta
  
  let accruedLendingProfit = 0n

  if ((position.collateral + quantityDelta) <= 0n) {
    // we know this must be a closing fill event
    accruedLendingProfit = -position.collateral - quantityDelta
  }

  // figure out debt delta
  let debtDelta = 0n
  let accruedInterest = 0n

  if (price > 0n) {
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      const amountBorrowed = quantityDelta - cashflow
      debtDelta = mulDiv(amountBorrowed, price, collateralToken.unit)
    } else {
      const amountOut = mulDiv(quantityDelta, price, collateralToken.unit)
      debtDelta = amountOut - cashflow
    }
  }

  if (position.debt + debtDelta < 0n) {
    // we know this must be a closing fill event
    accruedInterest = -position.debt - debtDelta
  }

  // probably processing a strategy transaction
  if (quantityDelta === 0n) {
    // edge case where we're not processing a strategy transaction
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      debtDelta -= mulDiv(cashflow, price, collateralToken.unit)
    }
    debtDelta = -cashflow
  }

  newFillItem.debtDelta += debtDelta
  newFillItem.lendingProfitToSettle = accruedLendingProfit
  newFillItem.debtCostToSettle = accruedInterest
  
  return newFillItem
};