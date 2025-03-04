import {
  FillItem,
  handlerContext,
  Lot,
  Position,
  Token
} from "generated";
import { Mutable } from "viem";
import { getLiquidationPenalty } from "../Liquidations/common";
import { eventStore, PositionSnapshot } from "../Store";
import { createInstrumentId } from "../utils/common";
import { createFillItemId, createIdForLot, createIdForPosition } from "../utils/ids";
import { mulDiv } from "../utils/math-helpers";
import { ContangoEvents, EventType, FillItemType, MigratedEvent, SwapEvent } from "../utils/types";
import { calculateCashflowsAndFee, calculateDust, calculateFillPrice, calculateNetCashflows, eventsToPartialFillItem, ReferencePriceSource } from "./helpers";
import { AccountingType, allocateFundingCostToLots, allocateFundingProfitToLots, GenericEvent, handleCloseSize, initialiseLot, savePosition } from "./lotsAccounting";
import { ADDRESSES } from "../utils/constants";
import { TRADER_CONSTANT } from "../ERC20";

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
  const partialFillItem = await eventsToPartialFillItem({ lots: lotsSnapshot, position: positionSnapshot, debtToken, collateralToken, events })

  if (partialFillItem.fillItemType === FillItemType.Liquidated && partialFillItem.referencePrice_long !== 0n) {
    partialFillItem.liquidationPenalty = getLiquidationPenalty({ collateralToken, collateralDelta: partialFillItem.collateralDelta, debtDelta: partialFillItem.debtDelta, referencePrice: partialFillItem.referencePrice_long })
  }

  const cashflows = calculateNetCashflows(events, [positionSnapshot.owner, TRADER_CONSTANT])

  // dust left in the vault
  const dustRecord = calculateDust(events, partialFillItem)

  const { cashflowQuote, cashflowBase, fee_long, fee_short, cashflowToken_id, cashflow } = calculateCashflowsAndFee({ cashflows, partialFillItem, debtToken, collateralToken, dustRecord })

  const fillCost_short = partialFillItem.collateralDelta - cashflowBase
  const fillCost_long = -(partialFillItem.debtDelta + cashflowQuote)

  const fillPrice_long = calculateFillPrice({ fillCost: fillCost_long, unit: collateralToken.unit, delta: partialFillItem.collateralDelta })
  const fillPrice_short = calculateFillPrice({ fillCost: fillCost_short, unit: debtToken.unit, delta: partialFillItem.debtDelta })

  const fillItem: Mutable<FillItem> = {
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
    dust: partialFillItem.residualCashflow?.value ?? 0n,
    collateralDelta: partialFillItem.collateralDelta,
    debtCostToSettle: partialFillItem.debtCostToSettle,
    debtDelta: partialFillItem.debtDelta,
    cashflow,
    cashflowToken_id,
    fillItemType: partialFillItem.fillItemType,
    lendingProfitToSettle: partialFillItem.lendingProfitToSettle,
    liquidationPenalty: partialFillItem.liquidationPenalty,
    referencePrice_long: partialFillItem.referencePrice_long,
    referencePrice_short: partialFillItem.referencePrice_short,
    referencePriceSource: partialFillItem.referencePriceSource,
    fillCost_long,
    fillCost_short,
    fillPrice_long,
    fillPrice_short,
  } as const satisfies FillItem

  let longLots: Mutable<Lot>[] = [...lotsSnapshot.filter(lot => lot.accountingType === AccountingType.Long)] // create a copy
  let shortLots: Mutable<Lot>[] = [...lotsSnapshot.filter(lot => lot.accountingType === AccountingType.Short)] // create a copy

  longLots = await allocateFundingProfitToLots({ lots: longLots, fundingProfitToSettle: fillItem.lendingProfitToSettle }) // size grows, which is a good thing
  longLots = await allocateFundingCostToLots({ lots: longLots, fundingCostToSettle: fillItem.debtCostToSettle }) // cost grows
  
  shortLots = await allocateFundingProfitToLots({ lots: shortLots, fundingProfitToSettle: -fillItem.debtCostToSettle }) // size grows, but it's actually a negative thing because your size is your debt!
  shortLots = await allocateFundingCostToLots({ lots: shortLots, fundingCostToSettle: -fillItem.lendingProfitToSettle }) // cost grows, but it's actually a good thing because your cost is your collateral!

  if (fillItem.debtDelta > 0n) {
    // create new short lot if adding debt
    shortLots.push(
      initialiseLot({
        event: genericEvent,
        position: positionSnapshot,
        accountingType: AccountingType.Short,
        size: -fillItem.debtDelta,
        cost: fillCost_short
      })
    )
  } else if (fillItem.debtDelta < 0n) {
    const closedCostRef = { value: 0n }
    shortLots = handleCloseSize({ closedCostRef, lots: shortLots, position: positionSnapshot, fillItem, sizeDelta: fillItem.debtDelta, accountingType: AccountingType.Short, ...genericEvent })
    fillItem.realisedPnl_short = fillCost_short - closedCostRef.value
  }

  if (fillItem.collateralDelta > 0n) {
    // create new long lot if adding collateral
    longLots.push(
      initialiseLot({
        event: genericEvent,
        position: positionSnapshot,
        accountingType: AccountingType.Long,
        size: fillItem.collateralDelta,
        cost: fillCost_long
      })
    )
  } else if (fillItem.collateralDelta < 0n) {
    const closedCostRef = { value: 0n }
    longLots = handleCloseSize({ closedCostRef, lots: longLots, position: positionSnapshot, fillItem, sizeDelta: fillItem.collateralDelta, accountingType: AccountingType.Long, ...genericEvent })
    fillItem.realisedPnl_long = fillCost_long - closedCostRef.value
  }

  // update the position
  const newPosition: Position = {
    ...positionSnapshot,
    cashflowQuote: positionSnapshot.cashflowQuote + fillItem.cashflowQuote,
    cashflowBase: positionSnapshot.cashflowBase + fillItem.cashflowBase,
    fees_long: positionSnapshot.fees_long + fillItem.fee_long,
    fees_short: positionSnapshot.fees_short + fillItem.fee_short,
    realisedPnl_long: fillItem.realisedPnl_long + positionSnapshot.realisedPnl_long,
    realisedPnl_short: fillItem.realisedPnl_short + positionSnapshot.realisedPnl_short,
    collateral: positionSnapshot.collateral + fillItem.collateralDelta,
    debt: positionSnapshot.debt + fillItem.debtDelta,
    accruedLendingProfit: positionSnapshot.accruedLendingProfit + fillItem.lendingProfitToSettle,
    accruedDebtCost: positionSnapshot.accruedDebtCost + fillItem.debtCostToSettle,
    longCost: positionSnapshot.longCost + fillItem.fillCost_long,
    shortCost: positionSnapshot.shortCost + fillItem.fillCost_short,
  }

  if (fillItem.fillItemType === FillItemType.Liquidated) {
    if (newPosition.collateral <= 0n) fillItem.fillItemType = FillItemType.ClosedByLiquidation
  } else if (positionSnapshot.collateral === 0n) fillItem.fillItemType = FillItemType.Opened
  else if (newPosition.collateral <= 0n) fillItem.fillItemType = FillItemType.Closed
  else fillItem.fillItemType = FillItemType.Modified

  // return the new position, fillItem, and lots
  return { position: newPosition, fillItem, lots: { longLots, shortLots } }
}

const saveFillItem = async (fillItem: FillItem, context: handlerContext) => {
  if (fillItem.referencePriceSource === ReferencePriceSource.None && fillItem.cashflow !== 0n) {
    throw new Error('Fill item has no reference price source')
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

      const dustRecord = calculateNetCashflows(events, [ADDRESSES.vaultProxy])

      const partialFillItemClose = await eventsToPartialFillItem({ lots, position, debtToken, collateralToken, events: getEventsForPositionId(oldContangoPositionId) })
      const { fee_long, fee_short } = calculateCashflowsAndFee({ partialFillItem: partialFillItemClose, debtToken, collateralToken, cashflows: {}, dustRecord })
      
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
        fee_long,
        fee_short,
        realisedPnl_long: 0n,
        realisedPnl_short: 0n,
        cashflowQuote: 0n,
        cashflowBase: 0n,
        cashflowSwap_id: undefined,
        feeToken_id: undefined,
        position_id: position.id,
        dust: 0n,
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
        dust: 0n,
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
        const fees_short = mulDiv(position.fees_short, swapEvent.amountOut, swapEvent.amountIn)

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
          fees_long: position.fees_long + fee_long,
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
          fees_long: position.fees_long + fee_long,
          fees_short: position.fees_short + fee_short,
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
