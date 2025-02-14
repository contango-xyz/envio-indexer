import {
  ContangoSwapEvent,
  ERC20_Transfer_event,
  FillItem,
  handlerContext,
  Lot,
  Position,
  Token
} from "generated";
import { Hex, Mutable } from "viem";
import { getMarkPrice } from "../Liquidations/common";
import { eventStore } from "../Store";
import { getPairForPositionId, getPositionSnapshot, setPosition } from "../utils/common";
import { getIMoneyMarketEventsStartBlock } from "../utils/constants";
import { decodeTokenId } from "../utils/getTokenDetails";
import { createIdForPosition } from "../utils/ids";
import { max, mulDiv } from "../utils/math-helpers";
import { ContangoEvents, EventType, MigratedEvent, TransferEvent } from "../utils/types";
import { createEmptyPartialFillItem, partialFillItemWithCashflowEventsToFillItem, updateFillItemWithCashflowEvents } from "./helpers";
import { deriveFillItemValuesFormPositionUpsertedEvent } from "./legacy";
import { AccountingType, allocateFundingCostToLots, allocateFundingProfitToLots, GenericEvent, handleCostDelta, handleSizeDelta } from "./lotsAccounting";

export type PartialFillItem = {
  collateralToken: Token;
  debtToken: Token;

  cashflowSwap?: ContangoSwapEvent;

  tradePrice_long: bigint; // trade price in debt/collateral terms
  tradePrice_short: bigint; // trade price in collateral/debt terms

  collateralDelta: bigint;
  debtDelta: bigint;

  debtCostToSettle: bigint; // debt accrued since last fill event
  lendingProfitToSettle: bigint; // lending profit accrued since last fill event

  fee: bigint;
  feeToken_id?: string;

  liquidationPenalty: bigint;
}



export const eventsToFillItem = (position: Position, debtToken: Token, collateralToken: Token, event: Exclude<ContangoEvents, ERC20_Transfer_event>, existingFillItem: PartialFillItem): PartialFillItem => {

  switch (event.eventType) {
    case EventType.DEBT: {
      if (!existingFillItem.debtCostToSettle) {
        const debtCostToSettle = max(event.balanceBefore - (position.debt + position.accruedInterest), 0n)
        return { ...existingFillItem, debtCostToSettle, debtDelta: existingFillItem.debtDelta + event.debtDelta }
      } else return { ...existingFillItem, debtDelta: existingFillItem.debtDelta + event.debtDelta }
    }
    case EventType.COLLATERAL: {
      if (!existingFillItem.lendingProfitToSettle) {
        const lendingProfitToSettle = max(event.balanceBefore - (position.accruedLendingProfit + position.collateral), 0n)
        return { ...existingFillItem, lendingProfitToSettle, collateralDelta: existingFillItem.collateralDelta + event.collateralDelta }
      } else return { ...existingFillItem, collateralDelta: existingFillItem.collateralDelta + event.collateralDelta }
    }
    case EventType.SWAP_EXECUTED: {
      const [tokenIn, tokenOut] = [event.tokenIn_id, event.tokenOut_id].map(decodeTokenId)

      if (tokenIn.address === debtToken.address && tokenOut.address === collateralToken.address) {
        return {
          ...existingFillItem,
          tradePrice_long: mulDiv(event.amountIn, collateralToken.unit, event.amountOut),
          tradePrice_short: mulDiv(event.amountOut, debtToken.unit, event.amountIn),
        }
      }

      if (tokenIn.address === collateralToken.address && tokenOut.address === debtToken.address) {
        return {
          ...existingFillItem,
          tradePrice_long: mulDiv(event.amountOut, collateralToken.unit, event.amountIn),
          tradePrice_short: mulDiv(event.amountIn, debtToken.unit, event.amountOut),
        }
      }

      return { ...existingFillItem, cashflowSwap: event }
    }
    case EventType.FEE_COLLECTED: {
      return {
        ...existingFillItem,
        fee: event.amount,
        feeToken_id: event.token_id,
      }
    }
    case EventType.LIQUIDATION: {
      return {
        ...existingFillItem,
        collateralDelta: event.collateralDelta,
        debtDelta: event.debtDelta,
        lendingProfitToSettle: event.lendingProfitToSettle,
        debtCostToSettle: event.debtCostToSettle,
        liquidationPenalty: event.liquidationPenalty,
      }
    }
    case EventType.POSITION_UPSERTED: {
      if (event.blockNumber <= getIMoneyMarketEventsStartBlock(event.chainId)) {
        return deriveFillItemValuesFormPositionUpsertedEvent({
          upsertedEvent: event,
          fillItem: existingFillItem,
          position,
          collateralToken,
          debtToken
        })
      }
    }
    default: {
      return existingFillItem
    }
  }
}

export const processEvents = async (
  {
    genericEvent,
    events,
    position: positionSnapshot,
    lots: lotsSnapshot,
    debtToken,
    collateralToken,
  }: {
    genericEvent: GenericEvent & { positionId: string }
    events: ContangoEvents[]
    position: Position
    lots: { longLots: Lot[], shortLots: Lot[] }
    debtToken: Token
    collateralToken: Token
  }
) => {
  const { chainId, blockNumber } = genericEvent

  let partialFillItem = events.filter((e): e is Exclude<ContangoEvents, TransferEvent> => e.eventType !== EventType.TRANSFER).reduce((acc, event) => {
    return eventsToFillItem(positionSnapshot, debtToken, collateralToken, event, acc)
  }, createEmptyPartialFillItem({ collateralToken, debtToken }))

  if (partialFillItem.tradePrice_long === 0n || partialFillItem.tradePrice_short === 0n) {
    const markPrice = await getMarkPrice({ chainId, positionId: positionSnapshot.positionId as Hex, blockNumber, debtToken })
    partialFillItem.tradePrice_long = markPrice
    partialFillItem.tradePrice_short = mulDiv(debtToken.unit, collateralToken.unit, markPrice)
  }

  let fillItemWithCashflowEvents = events.filter((e): e is TransferEvent => e.eventType === EventType.TRANSFER).reduce((acc, event) => {
    return updateFillItemWithCashflowEvents({ fillItem: acc, owner: positionSnapshot.owner, event })
  }, {
    ...partialFillItem,
    cashflowQuote: 0n,
    cashflowBase: 0n,
    cashflow: 0n,
  })

  const fillItem = partialFillItemWithCashflowEventsToFillItem(fillItemWithCashflowEvents, positionSnapshot, genericEvent)

  let longLots: Mutable<Lot>[] = [...lotsSnapshot.longLots] // create a copy
  let shortLots: Mutable<Lot>[] = [...lotsSnapshot.shortLots] // create a copy

  if (fillItem.debtCostToSettle > 0n) {
    longLots = await allocateFundingCostToLots({ lots: longLots, fundingCostToSettle: fillItem.debtCostToSettle })
    shortLots = await allocateFundingProfitToLots({ lots: shortLots, fundingProfitToSettle: fillItem.debtCostToSettle })
  }

  if (fillItem.lendingProfitToSettle > 0n) {
    longLots = await allocateFundingProfitToLots({ lots: longLots, fundingProfitToSettle: fillItem.lendingProfitToSettle })
    shortLots = await allocateFundingCostToLots({ lots: shortLots, fundingCostToSettle: fillItem.lendingProfitToSettle })
  }

  const sizeDeltaLong = fillItem.collateralDelta
  const sizeDeltaShort = fillItem.debtDelta

  const costDeltaLong = fillItem.debtDelta + fillItem.cashflowQuote
  const costDeltaShort = fillItem.collateralDelta

  longLots = handleSizeDelta({ lots: longLots, position: positionSnapshot, fillItem, sizeDelta: sizeDeltaLong, accountingType: AccountingType.Long, ...genericEvent })
  shortLots = handleSizeDelta({ lots: shortLots, position: positionSnapshot, fillItem, sizeDelta: sizeDeltaShort, accountingType: AccountingType.Short, ...genericEvent })

  longLots = handleCostDelta({ lots: longLots, fillItem, costDelta: costDeltaLong, accountingType: AccountingType.Long, ...genericEvent })
  shortLots = handleCostDelta({ lots: shortLots, fillItem, costDelta: costDeltaShort, accountingType: AccountingType.Short, ...genericEvent })

  fillItem.realisedPnl_short *= -1n
  const realisedPnl_long = fillItem.realisedPnl_long - positionSnapshot.realisedPnl_long
  const realisedPnl_short = fillItem.realisedPnl_short + positionSnapshot.realisedPnl_short

  const cashflowQuote = positionSnapshot.cashflowQuote + fillItem.cashflowQuote
  const cashflowBase = positionSnapshot.cashflowBase + fillItem.cashflowBase

  const fees_long = positionSnapshot.fees_long + fillItem.fee_long
  const fees_short = positionSnapshot.fees_short + fillItem.fee_short

  longLots = longLots.filter(lot => lot.size > 0n).map((lot, idx, array) => ({ ...lot, nextLotId: array[idx + 1]?.id }))
  shortLots = shortLots.filter(lot => lot.size > 0n).map((lot, idx, array) => ({ ...lot, nextLotId: array[idx + 1]?.id }))

  const firstLotId_long = longLots[0]?.id || positionSnapshot.firstLotId_long
  const firstLotId_short = shortLots[0]?.id || positionSnapshot.firstLotId_short

  const newPosition = {
    ...positionSnapshot,
    cashflowQuote,
    cashflowBase,
    fees_long,
    fees_short,
    realisedPnl_long,
    realisedPnl_short,
    firstLotId_long,
    firstLotId_short,
    collateral: positionSnapshot.collateral + fillItem.collateralDelta,
    debt: positionSnapshot.debt + fillItem.debtDelta,
    accruedLendingProfit: positionSnapshot.accruedLendingProfit + fillItem.lendingProfitToSettle,
    accruedInterest: positionSnapshot.accruedInterest + fillItem.debtCostToSettle,
  }

  const newFillItem = {
    id: fillItem.id,
    timestamp: fillItem.timestamp,
    chainId: fillItem.chainId,
    blockNumber: fillItem.blockNumber,
    transactionHash: fillItem.transactionHash,
    positionId: fillItem.positionId,
    collateralDelta: fillItem.collateralDelta,
    debtDelta: fillItem.debtDelta,
    tradePrice_long: fillItem.tradePrice_long,
    tradePrice_short: fillItem.tradePrice_short,
    debtCostToSettle: fillItem.debtCostToSettle,
    lendingProfitToSettle: fillItem.lendingProfitToSettle,
    fee_long: fillItem.fee_long,
    fee_short: fillItem.fee_short,
    realisedPnl_long: fillItem.realisedPnl_long,
    realisedPnl_short: fillItem.realisedPnl_short,
    cashflowQuote: fillItem.cashflowQuote,
    cashflowBase: fillItem.cashflowBase,
    cashflow: fillItem.cashflow,
    cashflowToken_id: fillItem.cashflowToken_id ?? collateralToken.id,
    cashflowSwap_id: fillItem.cashflowSwap_id,
    fee: fillItem.fee,
    feeToken_id: fillItem.feeToken_id,
    fillItemType: fillItem.fillItemType,
    liquidationPenalty: fillItem.liquidationPenalty,
  } as const satisfies FillItem

  return { position: newPosition, fillItem: newFillItem, lots: { longLots, shortLots } }
}

export const eventsReducer = async (maybeLastEventInTx: GenericEvent & { positionId: string }, context: handlerContext) => {

  const { chainId, blockNumber, transactionHash, positionId } = maybeLastEventInTx
  const { position: positionSnapshot, lots: lotsSnapshot } = await getPositionSnapshot({ chainId, positionId, blockNumber, transactionHash, context })

  const { debtToken, collateralToken } = await getPairForPositionId({ positionId, chainId, context })

  const events = eventStore.getEvents({ chainId, blockNumber, transactionHash })

  const migrationEvent = events.find(e => e.eventType === EventType.MIGRATED)
  if (migrationEvent) {
    const { newPositionId, oldPositionId } = migrationEvent as MigratedEvent
    context.Position.deleteUnsafe(createIdForPosition({ chainId, positionId: oldPositionId }))
    context.Position.set({
      ...positionSnapshot,
      id: createIdForPosition({ chainId, positionId: newPositionId }),
      positionId: newPositionId,
    })
    return
  }

  let partialFillItem = events.filter((e): e is Exclude<ContangoEvents, TransferEvent> => e.eventType !== EventType.TRANSFER).reduce((acc, event) => {
    return eventsToFillItem(positionSnapshot, debtToken, collateralToken, event, acc)
  }, createEmptyPartialFillItem({ collateralToken, debtToken }))

  if (partialFillItem.tradePrice_long === 0n || partialFillItem.tradePrice_short === 0n) {
    const markPrice = await getMarkPrice({ chainId, positionId: positionSnapshot.positionId as Hex, blockNumber, debtToken })
    partialFillItem.tradePrice_long = markPrice
    partialFillItem.tradePrice_short = mulDiv(debtToken.unit, collateralToken.unit, markPrice)
  }

  let fillItemWithCashflowEvents = events.filter((e): e is TransferEvent => e.eventType === EventType.TRANSFER).reduce((acc, event) => {
    return updateFillItemWithCashflowEvents({ fillItem: acc, owner: positionSnapshot.owner, event })
  }, {
    ...partialFillItem,
    cashflowQuote: 0n,
    cashflowBase: 0n,
    cashflow: 0n,
  })

  const fillItem = partialFillItemWithCashflowEventsToFillItem(fillItemWithCashflowEvents, positionSnapshot, maybeLastEventInTx)

  let longLots: Mutable<Lot>[] = [...lotsSnapshot.longLots] // create a copy
  let shortLots: Mutable<Lot>[] = [...lotsSnapshot.shortLots] // create a copy

  if (fillItem.debtCostToSettle > 0n) {
    longLots = await allocateFundingCostToLots({ lots: longLots, fundingCostToSettle: fillItem.debtCostToSettle })
    shortLots = await allocateFundingProfitToLots({ lots: shortLots, fundingProfitToSettle: fillItem.debtCostToSettle })
  }

  if (fillItem.lendingProfitToSettle > 0n) {
    longLots = await allocateFundingProfitToLots({ lots: longLots, fundingProfitToSettle: fillItem.lendingProfitToSettle })
    shortLots = await allocateFundingCostToLots({ lots: shortLots, fundingCostToSettle: fillItem.lendingProfitToSettle })
  }

  const sizeDeltaLong = fillItem.collateralDelta
  const sizeDeltaShort = fillItem.debtDelta

  const costDeltaLong = fillItem.debtDelta + fillItem.cashflowQuote
  const costDeltaShort = fillItem.collateralDelta

  longLots = handleSizeDelta({ lots: longLots, position: positionSnapshot, fillItem, sizeDelta: sizeDeltaLong, accountingType: AccountingType.Long, ...maybeLastEventInTx })
  shortLots = handleSizeDelta({ lots: shortLots, position: positionSnapshot, fillItem, sizeDelta: sizeDeltaShort, accountingType: AccountingType.Short, ...maybeLastEventInTx })

  longLots = handleCostDelta({ lots: longLots, fillItem, costDelta: costDeltaLong, accountingType: AccountingType.Long, ...maybeLastEventInTx })
  shortLots = handleCostDelta({ lots: shortLots, fillItem, costDelta: costDeltaShort, accountingType: AccountingType.Short, ...maybeLastEventInTx })

  fillItem.realisedPnl_short *= -1n
  const realisedPnl_long = fillItem.realisedPnl_long - positionSnapshot.realisedPnl_long
  const realisedPnl_short = fillItem.realisedPnl_short + positionSnapshot.realisedPnl_short

  const cashflowQuote = positionSnapshot.cashflowQuote + fillItem.cashflowQuote
  const cashflowBase = positionSnapshot.cashflowBase + fillItem.cashflowBase

  const fees_long = positionSnapshot.fees_long + fillItem.fee_long
  const fees_short = positionSnapshot.fees_short + fillItem.fee_short

  longLots = longLots.filter(lot => lot.size > 0n).map((lot, idx, array) => ({ ...lot, nextLotId: array[idx + 1]?.id }))
  shortLots = shortLots.filter(lot => lot.size > 0n).map((lot, idx, array) => ({ ...lot, nextLotId: array[idx + 1]?.id }))

  const firstLotId_long = longLots[0]?.id || positionSnapshot.firstLotId_long
  const firstLotId_short = shortLots[0]?.id || positionSnapshot.firstLotId_short

  const newPosition = {
    ...positionSnapshot,
    cashflowQuote,
    cashflowBase,
    fees_long,
    fees_short,
    realisedPnl_long,
    realisedPnl_short,
    firstLotId_long,
    firstLotId_short,
    collateral: positionSnapshot.collateral + fillItem.collateralDelta,
    debt: positionSnapshot.debt + fillItem.debtDelta,
    accruedLendingProfit: positionSnapshot.accruedLendingProfit + fillItem.lendingProfitToSettle,
    accruedInterest: positionSnapshot.accruedInterest + fillItem.debtCostToSettle,
  }

  const newFillItem = {
    id: fillItem.id,
    timestamp: fillItem.timestamp,
    chainId: fillItem.chainId,
    blockNumber: fillItem.blockNumber,
    transactionHash: fillItem.transactionHash,
    positionId: fillItem.positionId,
    collateralDelta: fillItem.collateralDelta,
    debtDelta: fillItem.debtDelta,
    tradePrice_long: fillItem.tradePrice_long,
    tradePrice_short: fillItem.tradePrice_short,
    debtCostToSettle: fillItem.debtCostToSettle,
    lendingProfitToSettle: fillItem.lendingProfitToSettle,
    fee_long: fillItem.fee_long,
    fee_short: fillItem.fee_short,
    realisedPnl_long: fillItem.realisedPnl_long,
    realisedPnl_short: fillItem.realisedPnl_short,
    cashflowQuote: fillItem.cashflowQuote,
    cashflowBase: fillItem.cashflowBase,
    cashflow: fillItem.cashflow,
    cashflowToken_id: fillItem.cashflowToken_id ?? collateralToken.id,
    cashflowSwap_id: fillItem.cashflowSwap_id,
    fee: fillItem.fee,
    feeToken_id: fillItem.feeToken_id,
    fillItemType: fillItem.fillItemType,
    liquidationPenalty: fillItem.liquidationPenalty,
  } as const satisfies FillItem

  context.FillItem.set(newFillItem)
  setPosition(newPosition, { longLots, shortLots }, { blockNumber: maybeLastEventInTx.blockNumber, transactionHash: maybeLastEventInTx.transactionHash, context })
  
  // Run cleanup with the next block number to ensure proper event removal
  eventStore.cleanup(chainId, blockNumber + 1)
}
