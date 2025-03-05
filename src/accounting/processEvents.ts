import { FillItem, handlerContext, Lot, Position, Token } from "generated";
import { Mutable } from "viem";
import { eventStore, PositionSnapshot } from "../Store";
import { createInstrumentId } from "../utils/common";
import { createFillItemId, createIdForLot, createIdForPosition } from "../utils/ids";
import { mulDiv } from "../utils/math-helpers";
import { ContangoEvents, EventType, FillItemType, MigratedEvent, SwapEvent } from "../utils/types";
import { calculateFillPrice, eventsToPartialFillItem, ReferencePriceSource } from "./helpers";
import { AccountingType, allocateFundingCostToLots, allocateFundingProfitToLots, GenericEvent, handleCloseSize, initialiseLot, savePosition } from "./lotsAccounting";

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
  const { block: { number: blockNumber, timestamp }, chainId, transaction: { hash: transactionHash } } = genericEvent

  // create the basic (partial) fillItem
  const { cashflowSwap, ...partialFillItem } = await eventsToPartialFillItem({ lots: lotsSnapshot, position: positionSnapshot, debtToken, collateralToken, events })
  const { lendingProfitToSettle, debtCostToSettle, debtDelta, collateralDelta, fillCost_short, fillCost_long } = partialFillItem

  const fillItemId = createFillItemId({ ...genericEvent, positionId: positionSnapshot.contangoPositionId })

  let longLots: Mutable<Lot>[] = [...lotsSnapshot.filter(lot => lot.accountingType === AccountingType.Long)] // create a copy
  let shortLots: Mutable<Lot>[] = [...lotsSnapshot.filter(lot => lot.accountingType === AccountingType.Short)] // create a copy

  longLots = await allocateFundingProfitToLots({ lots: longLots, fundingProfitToSettle: lendingProfitToSettle }) // size grows, which is a good thing
  longLots = await allocateFundingCostToLots({ lots: longLots, fundingCostToSettle: debtCostToSettle }) // cost grows

  shortLots = await allocateFundingProfitToLots({ lots: shortLots, fundingProfitToSettle: -debtCostToSettle }) // size grows, but it's actually a negative thing because your size is your debt!
  shortLots = await allocateFundingCostToLots({ lots: shortLots, fundingCostToSettle: -lendingProfitToSettle }) // cost grows, but it's actually a good thing because your cost is your collateral!

  let realisedPnl_long = 0n
  let realisedPnl_short = 0n

  if (debtDelta > 0n) {
    // create new short lot if adding debt
    shortLots.push(
      initialiseLot({
        event: genericEvent,
        position: positionSnapshot,
        accountingType: AccountingType.Short,
        size: -debtDelta,
        cost: fillCost_short
      })
    )
  } else if (debtDelta < 0n) {
    const closedCostRef = { value: 0n }
    shortLots = handleCloseSize({ partialFillItem, closedCostRef, lots: shortLots, position: positionSnapshot, sizeDelta: -debtDelta, ...genericEvent })
    realisedPnl_short = fillCost_short - closedCostRef.value
  }

  if (collateralDelta > 0n) {
    // create new long lot if adding collateral
    longLots.push(
      initialiseLot({
        event: genericEvent,
        position: positionSnapshot,
        accountingType: AccountingType.Long,
        size: collateralDelta,
        cost: fillCost_long
      })
    )
  } else if (collateralDelta < 0n) {
    const closedCostRef = { value: 0n }
    longLots = handleCloseSize({ closedCostRef, lots: longLots, position: positionSnapshot, partialFillItem, sizeDelta: collateralDelta, ...genericEvent })
    realisedPnl_long = fillCost_long - closedCostRef.value
  }

  const fillItem: FillItem = {
    id: fillItemId,
    timestamp,
    chainId,
    blockNumber,
    transactionHash,
    contangoPositionId: positionSnapshot.contangoPositionId,
    position_id: positionSnapshot.id,
    realisedPnl_long,
    realisedPnl_short,
    cashflowSwap_id: cashflowSwap?.id,
    ...partialFillItem,
  }

  // update the position
  const newPosition: Position = {
    ...positionSnapshot,
    cashflowQuote: positionSnapshot.cashflowQuote + partialFillItem.cashflowQuote,
    cashflowBase: positionSnapshot.cashflowBase + partialFillItem.cashflowBase,
    fees_long: positionSnapshot.fees_long + partialFillItem.fee_long,
    fees_short: positionSnapshot.fees_short + partialFillItem.fee_short,
    realisedPnl_long: realisedPnl_long + positionSnapshot.realisedPnl_long,
    realisedPnl_short: realisedPnl_short + positionSnapshot.realisedPnl_short,
    collateral: positionSnapshot.collateral + collateralDelta,
    debt: positionSnapshot.debt + debtDelta,
    accruedLendingProfit: positionSnapshot.accruedLendingProfit + lendingProfitToSettle,
    accruedDebtCost: positionSnapshot.accruedDebtCost + debtCostToSettle,
    longCost: longLots.reduce((acc, curr) => acc + curr.openCost, 0n),
    shortCost: shortLots.reduce((acc, curr) => acc + curr.openCost, 0n),
  }

  // return the new position, fillItem, and lots
  return { position: newPosition, fillItem, lots: { longLots, shortLots } }
}

const saveFillItem = async (fillItem: FillItem, context: handlerContext) => {
  if (fillItem.referencePriceSource === ReferencePriceSource.None && fillItem.cashflow !== 0n) {
    console.log('fillItem in error', fillItem)
    throw new Error(`Fill item has no reference price source: ${fillItem.transactionHash} chainId: ${fillItem.chainId}`)
  }
  context.FillItem.set(fillItem)
}

export const eventsReducer = async ({ context, position, lots, collateralToken, debtToken, event }: PositionSnapshot & { context: handlerContext }) => {
  const { chainId, block: { timestamp, number: blockNumber }, transaction: { hash: transactionHash } } = event

  try {
    const events = eventStore.getContangoEvents(event)
    const migrationEvent = events.find(e => e.eventType === EventType.MIGRATED)
    if (migrationEvent) {
      const { newContangoPositionId, oldContangoPositionId } = migrationEvent as MigratedEvent
      const idOfNewPosition = createIdForPosition({ chainId, positionId: newContangoPositionId })
      const swapEvent: SwapEvent | undefined = events.find(e => e.eventType === EventType.SWAP_EXECUTED) as SwapEvent | undefined

      context.Position.set({
        ...position,
        collateral: 0n,
        accruedLendingProfit: 0n,
        debt: 0n,
        accruedDebtCost: 0n,
        fees_long: 0n,
        fees_short: 0n,
        cashflowBase: 0n,
        cashflowQuote: 0n,
        realisedPnl_long: 0n,
        realisedPnl_short: 0n,
        lotCount: 0,
        longCost: 0n,
        shortCost: 0n,
        migratedTo_id: idOfNewPosition,
      })

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

      const fillCost_long = position.longCost * -1n
      const fillCost_short = position.shortCost * -1n

      const partialFillItemClose = await eventsToPartialFillItem({ lots, position, debtToken, collateralToken, events: getEventsForPositionId(oldContangoPositionId) })
      
      const fillItemClose: Mutable<FillItem> = {
        ...partialFillItemClose,
        cashflow: 0n,
        cashflowToken_id: debtToken.id,
        id: createFillItemId({ ...event, positionId: oldContangoPositionId }),
        timestamp,
        chainId,
        blockNumber,
        transactionHash,
        contangoPositionId: oldContangoPositionId,
        fee_long: partialFillItemClose.fee_long,
        fee_short: partialFillItemClose.fee_short,
        realisedPnl_long: 0n,
        realisedPnl_short: 0n,
        cashflowQuote: 0n,
        cashflowBase: 0n,
        cashflowSwap_id: undefined,
        feeToken_id: undefined,
        position_id: position.id,
        fillItemType: FillItemType.MigrationClose,
        fillCost_long,
        fillCost_short,
        fillPrice_long: calculateFillPrice({ fillCost: fillCost_long, unit: collateralToken.unit, delta: position.collateral }),
        fillPrice_short: calculateFillPrice({ fillCost: fillCost_short, unit: debtToken.unit, delta: position.debt }),
      } as const satisfies FillItem

      saveFillItem(fillItemClose, context)

      const openingFillItem: FillItem = {
        ...(await eventsToPartialFillItem({ lots, position, debtToken, collateralToken, events: getEventsForPositionId(newContangoPositionId) })),
        id: createFillItemId({ ...event, positionId: newContangoPositionId }),
        cashflowToken_id: debtToken.id,
        cashflow: 0n,
        timestamp,
        chainId,
        blockNumber,
        transactionHash,
        referencePrice_long: fillItemClose.referencePrice_long,
        referencePrice_short: fillItemClose.referencePrice_short,
        referencePriceSource: fillItemClose.referencePriceSource,
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
        fillItemType: FillItemType.MigrationOpen,
        fillCost_long: position.longCost,
        fillCost_short: position.shortCost,
        fillPrice_long: calculateFillPrice({ fillCost: position.longCost, unit: collateralToken.unit, delta: position.collateral }),
        fillPrice_short: calculateFillPrice({ fillCost: position.shortCost, unit: debtToken.unit, delta: position.debt }),
      } as const satisfies FillItem

      saveFillItem(openingFillItem, context)

      for (const lot of lots) {
        context.Lot.deleteUnsafe(lot.id)
      }

      if (swapEvent) {
        const cashflowBase = mulDiv(position.cashflowBase + fillItemClose.cashflowBase, swapEvent.amountOut, swapEvent.amountIn)
        const realisedPnl_short = mulDiv(position.realisedPnl_short, swapEvent.amountOut, swapEvent.amountIn)
        const fees_short = mulDiv(position.fees_short + partialFillItemClose.fee_short, swapEvent.amountOut, swapEvent.amountIn)

        const newPosition = {
          ...position,
          instrument_id: createInstrumentId({ chainId, instrumentId: newContangoPositionId }),
          collateral: openingFillItem.collateralDelta,
          debt: openingFillItem.debtDelta,
          createdAtBlock: event.block.number,
          createdAtTimestamp: event.block.timestamp,
          createdAtTransactionHash: event.transaction.hash,
          id: idOfNewPosition,
          contangoPositionId: newContangoPositionId,
          accruedLendingProfit: 0n,
          accruedDebtCost: 0n,
          fees_long: position.fees_long + partialFillItemClose.fee_long,
          fees_short,
          cashflowBase,
          cashflowQuote: position.cashflowQuote,
          realisedPnl_short,
        }

        const newLots = [
          initialiseLot({
            event,
            position: newPosition,
            accountingType: AccountingType.Long,
            size: openingFillItem.collateralDelta,
            cost: openingFillItem.fillCost_long,
          }),
          initialiseLot({
            event,
            position: newPosition,
            accountingType: AccountingType.Short,
            size: openingFillItem.debtDelta,
            cost: openingFillItem.fillCost_short,
          }),
        ]

        await savePosition({ position: newPosition, lots: newLots, context })
      } else {
        const newPosition = {
          ...position,
          createdAtBlock: event.block.number,
          createdAtTimestamp: event.block.timestamp,
          createdAtTransactionHash: event.transaction.hash,
          id: idOfNewPosition,
          contangoPositionId: newContangoPositionId,
          collateral: position.collateral + fillItemClose.lendingProfitToSettle,
          debt: position.debt + fillItemClose.debtCostToSettle,
          accruedLendingProfit: position.accruedLendingProfit + fillItemClose.lendingProfitToSettle,
          accruedDebtCost: position.accruedDebtCost + fillItemClose.debtCostToSettle,
          fees_long: position.fees_long + partialFillItemClose.fee_long,
          fees_short: position.fees_short + partialFillItemClose.fee_short,
          cashflowBase: position.cashflowBase,
          cashflowQuote: position.cashflowQuote,    
        }

        const newLots = lots.map((lot, index) => ({
          ...lot,
          id: createIdForLot({ chainId, positionId: newContangoPositionId, index }),
          contangoPositionId: newContangoPositionId,
          createdAtBlock: event.block.number,
          createdAtTimestamp: event.block.timestamp,
          createdAtTransactionHash: event.transaction.hash,
        }))
  
        await savePosition({ position: newPosition, lots: newLots, context })
      }

      return
    }

    const result = await processEvents({ genericEvent: event, events, position, lots, debtToken, collateralToken })

    await saveFillItem(result.fillItem, context)
    await savePosition({ position: result.position, lots: [...result.lots.longLots, ...result.lots.shortLots], context })
  } catch (e) {
    console.error('error processing events', e)
    throw e
  }
}
