import {
  FillItem,
  handlerContext,
  Lot,
  Position,
  Token
} from "generated";
import { Mutable } from "viem";
import { eventStore, PositionSnapshot } from "../Store";
import { createFillItemId, createIdForLot, createIdForPosition } from "../utils/ids";
import { ContangoEvents, EventType, FillItemType, MigratedEvent } from "../utils/types";
import { calculateCashflowsAndFee, eventsToPartialFillItem, withMarkPrice } from "./helpers";
import { AccountingType, allocateFundingCostToLots, allocateFundingProfitToLots, GenericEvent, handleCostDelta, handleCloseSize, initialiseLot, savePosition } from "./lotsAccounting";
import { max, mulDiv } from "../utils/math-helpers";
import { getMarkPrice } from "../utils/common";

export const processEvents = async (
  {
    genericEvent,
    events,
    position: positionSnapshot,
    lots: lotsSnapshot,
    debtToken,
    collateralToken,
  }: {
    genericEvent: GenericEvent
    events: ContangoEvents[]
    position: Position
    lots: Lot[]
    debtToken: Token
    collateralToken: Token
  }
) => {
  const { block: { number: blockNumber }, transaction: { hash: transactionHash } } = genericEvent

  // create the basic (partial) fillItem
  const partialFillItem = await withMarkPrice(positionSnapshot, eventsToPartialFillItem(positionSnapshot, debtToken, collateralToken, events), blockNumber, debtToken, collateralToken)

  const { cashflowQuote, cashflowBase, fee_long, fee_short } = calculateCashflowsAndFee(partialFillItem, debtToken, collateralToken, partialFillItem.dust)

  const fillItem: Mutable<FillItem> = {
    ...partialFillItem,
    id: createFillItemId({ ...genericEvent, positionId: positionSnapshot.contangoPositionId }),
    timestamp: genericEvent.block.timestamp,
    chainId: genericEvent.chainId,
    blockNumber,
    transactionHash,
    contangoPositionId: positionSnapshot.contangoPositionId,
    fee_long,
    fee_short,
    realisedPnl_long: 0n,
    realisedPnl_short: 0n,
    cashflowQuote,
    cashflowBase,
    cashflowSwap_id: partialFillItem.cashflowSwap?.id,
    fee: partialFillItem.fee,
    feeToken_id: partialFillItem.feeToken_id,
    position_id: positionSnapshot.id,
    dust: partialFillItem.dust?.value ?? 0n,
  } as const satisfies FillItem

  let longLots: Mutable<Lot>[] = [...lotsSnapshot.filter(lot => lot.accountingType === AccountingType.Long)] // create a copy
  let shortLots: Mutable<Lot>[] = [...lotsSnapshot.filter(lot => lot.accountingType === AccountingType.Short)] // create a copy

  longLots = await allocateFundingProfitToLots({ lots: longLots, fundingProfitToSettle: fillItem.lendingProfitToSettle }) // size grows, which is a good thing
  longLots = await allocateFundingCostToLots({ lots: longLots, fundingCostToSettle: -fillItem.debtCostToSettle }) // cost grows
  
  shortLots = await allocateFundingProfitToLots({ lots: shortLots, fundingProfitToSettle: fillItem.debtCostToSettle }) // size grows, but it's actually a negative thing because your size is your debt!
  shortLots = await allocateFundingCostToLots({ lots: shortLots, fundingCostToSettle: -fillItem.lendingProfitToSettle }) // cost grows, but it's actually a good thing because your cost is your collateral!

  const shortCost = fillItem.collateralDelta - fillItem.cashflowBase
  if (fillItem.debtDelta > 0n) {
    // create new short lot if adding debt
    shortLots.push(
      initialiseLot({
        event: genericEvent,
        position: positionSnapshot,
        accountingType: AccountingType.Short,
        size: -fillItem.debtDelta,
        cost: shortCost
      })
    )
  } else if (fillItem.debtDelta < 0n) {
    fillItem.realisedPnl_short += shortCost
    shortLots = handleCloseSize({ lots: shortLots, position: positionSnapshot, fillItem, sizeDelta: fillItem.debtDelta, accountingType: AccountingType.Short, ...genericEvent })
  }

  const longCost = -(fillItem.cashflowQuote + fillItem.debtDelta)
  if (fillItem.collateralDelta > 0n) {
    // create new long lot if adding collateral
    longLots.push(
      initialiseLot({
        event: genericEvent,
        position: positionSnapshot,
        accountingType: AccountingType.Long,
        size: fillItem.collateralDelta,
        cost: longCost
      })
    )
  } else if (fillItem.collateralDelta < 0n) {
    fillItem.realisedPnl_long += longCost
    longLots = handleCloseSize({ lots: longLots, position: positionSnapshot, fillItem, sizeDelta: fillItem.collateralDelta, accountingType: AccountingType.Long, ...genericEvent })
  }

  // update the position
  const newPosition: Position = {
    ...positionSnapshot,
    cashflowQuote: positionSnapshot.cashflowQuote + fillItem.cashflowQuote,
    cashflowBase: positionSnapshot.cashflowBase + fillItem.cashflowBase,
    fees_long: positionSnapshot.fees_long + fillItem.fee_long,
    fees_short: positionSnapshot.fees_short + fillItem.fee_short,
    realisedPnl_long: fillItem.realisedPnl_long - positionSnapshot.realisedPnl_long,
    realisedPnl_short: fillItem.realisedPnl_short + positionSnapshot.realisedPnl_short,
    collateral: positionSnapshot.collateral + fillItem.collateralDelta,
    debt: positionSnapshot.debt + fillItem.debtDelta,
    accruedLendingProfit: positionSnapshot.accruedLendingProfit + fillItem.lendingProfitToSettle,
    accruedInterest: positionSnapshot.accruedInterest + fillItem.debtCostToSettle,
  }

  // return the new position, fillItem, and lots
  return { position: newPosition, fillItem, lots: { longLots, shortLots } }
}

export const eventsReducer = async ({ context, position, lots, collateralToken, debtToken, event }: PositionSnapshot & { context: handlerContext }) => {
  const { chainId, block: { timestamp, number: blockNumber }, transaction: { hash: transactionHash } } = event

  try {
    const events = eventStore.getContangoEvents(event)
    const migrationEvent = events.find(e => e.eventType === EventType.MIGRATED)
    if (migrationEvent) {
      const { newContangoPositionId, oldContangoPositionId } = migrationEvent as MigratedEvent
      context.Position.deleteUnsafe(position.id)

      const getEventsForPositionId = (positionId: string) => {
        return events.filter(e => {
          if (e.eventType === EventType.COLLATERAL && e.contangoPositionId === positionId) return true
          if (e.eventType === EventType.DEBT && e.contangoPositionId === positionId) return true
          if (e.eventType === EventType.FEE_COLLECTED && e.contangoPositionId === positionId) return true
          if (e.eventType === EventType.LIQUIDATION && e.contangoPositionId === positionId) return true
          if (e.eventType === EventType.POSITION_UPSERTED && e.contangoPositionId === positionId) return true
          return false
        })
      }
      
      const fillItem: Mutable<FillItem> = {
        ...eventsToPartialFillItem(position, debtToken, collateralToken, getEventsForPositionId(oldContangoPositionId)),
        id: createFillItemId({ ...event, positionId: oldContangoPositionId }),
        timestamp,
        chainId,
        blockNumber,
        transactionHash,
        contangoPositionId: oldContangoPositionId,
        fee_long: 0n,
        fee_short: 0n,
        realisedPnl_long: 0n,
        realisedPnl_short: 0n,
        cashflowQuote: 0n,
        cashflowBase: 0n,
        cashflowSwap_id: undefined,
        fee: 0n,
        feeToken_id: undefined,
        position_id: position.id,
        dust: 0n,
        fillItemType: FillItemType.MigrationClose,
      } as const satisfies FillItem

      context.FillItem.set(fillItem)

      const openingFillItem: FillItem = {
        ...eventsToPartialFillItem(position, debtToken, collateralToken, getEventsForPositionId(newContangoPositionId)),
        id: createFillItemId({ ...event, positionId: newContangoPositionId }),
        timestamp,
        chainId,
        blockNumber,
        transactionHash,
        contangoPositionId: newContangoPositionId,
        fee_long: 0n,
        fee_short: 0n,
        realisedPnl_long: 0n,
        realisedPnl_short: 0n,
        cashflowQuote: 0n,
        cashflowBase: 0n,
        cashflowSwap_id: undefined,
        fee: 0n,
        feeToken_id: undefined,
        position_id: position.id,
        dust: 0n,
        fillItemType: FillItemType.MigrationOpen,
      } as const satisfies FillItem

      context.FillItem.set(openingFillItem)

      const newPosition = {
        ...position,
        id: createIdForPosition({ chainId, positionId: newContangoPositionId }),
        contangoPositionId: newContangoPositionId,
        isOpen: true,
      }

      const newLots = lots.map((lot, index) => ({
        ...lot,
        id: createIdForLot({ chainId, positionId: newContangoPositionId, index }),
        contangoPositionId: newContangoPositionId,
      }))

      for (const lot of lots) {
        context.Lot.deleteUnsafe(lot.id)
      }

      await savePosition({ position: newPosition, lots: newLots, context })

      return
    }

    const result = await processEvents({ genericEvent: event, events, position, lots, debtToken, collateralToken })
  
    context.FillItem.set(result.fillItem)
    await savePosition({ position: result.position, lots: [...result.lots.longLots, ...result.lots.shortLots], context })
  } catch (e) {
    console.error('error processing events', e)
    return null
  }
}
