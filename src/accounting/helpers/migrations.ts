import { FillItem, Lot, Position, Token, handlerContext } from "generated/src/Types.gen";
import { createInstrumentId, getPairForPositionId } from "../../utils/common";
import { createFillItemId, createIdForLot, createIdForPosition } from "../../utils/ids";
import { mulDiv } from "../../utils/math-helpers";
import { ContangoEvents, EventType, FillItemType, MigrationType, Mutable, PositionMigratedEvent, SwapEvent, TransferEvent } from "../../utils/types";
import { eventsToPartialFillItem, organiseEvents, saveFillItem, savePosition } from "../helpers";
import { AccountingType, allocateInterestToLots, initialiseLot } from "../lotsAccounting";
import { withCashflows } from "./cashflows";
import { calculateDebtAndCollateral } from "./debtAndCollateral";
import { withFees } from "./fees";
import { calculateFillPrice, getBaseToQuoteFn, getPricesFromLots, getQuoteToBaseFn, processSwapEvents } from "./prices";

const handleMigrateBase = async ({ position, lots, debtToken, collateralToken, events, newContangoPositionId, context, chainId, }: { chainId: number; context: handlerContext; newContangoPositionId: string; position: Position; lots: Lot[]; debtToken: Token; collateralToken: Token; events: ContangoEvents[] }) => {
  const idOfNewPosition = createIdForPosition({ chainId, positionId: newContangoPositionId })
  const swapEvent = events.find((e): e is SwapEvent => e.eventType === EventType.SWAP_EXECUTED)
  if (!swapEvent) throw new Error(`Swap event not found for migration type ${MigrationType.NoSwap}`)
  const oldContangoPositionId = position.contangoPositionId

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

  const partialFillItemClose = await eventsToPartialFillItem({ position, debtToken, collateralToken, events: getEventsForPositionId(oldContangoPositionId) })
  
  const fillItemClose: Mutable<FillItem> = {
    ...partialFillItemClose,
    cashflow: 0n,
    cashflowToken_id: debtToken.id,
    id: createFillItemId({ ...events[0], positionId: oldContangoPositionId }),
    timestamp: events[0].blockTimestamp,
    chainId,
    blockNumber: events[0].blockNumber,
    transactionHash: events[0].transactionHash,
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
    fillItemType: FillItemType.MigrateBaseCurrencyClose,
    fillCost_long,
    fillCost_short,
    fillPrice_long: calculateFillPrice({ fillCost: fillCost_long, unit: collateralToken.unit, delta: position.collateral }),
    fillPrice_short: calculateFillPrice({ fillCost: fillCost_short, unit: debtToken.unit, delta: position.debt }),
  } as const satisfies FillItem

  saveFillItem(fillItemClose, context)

  const openingFillItem: FillItem = {
    ...(await eventsToPartialFillItem({ position, debtToken, collateralToken, events: getEventsForPositionId(newContangoPositionId) })),
    id: createFillItemId({ ...events[0], positionId: newContangoPositionId }),
    cashflowToken_id: debtToken.id,
    cashflow: 0n,
    timestamp: events[0].blockTimestamp,
    chainId,
    blockNumber: events[0].blockNumber,
    transactionHash: events[0].transactionHash,
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
    fillItemType: FillItemType.MigrateBaseCurrencyOpen,
    fillCost_long: position.longCost,
    fillCost_short: position.shortCost,
    fillPrice_long: calculateFillPrice({ fillCost: position.longCost, unit: collateralToken.unit, delta: position.collateral }),
    fillPrice_short: calculateFillPrice({ fillCost: position.shortCost, unit: debtToken.unit, delta: position.debt }),
  } as const satisfies FillItem

  saveFillItem(openingFillItem, context)

  for (const lot of lots) {
    context.Lot.deleteUnsafe(lot.id)
  }

  const cashflowBase = mulDiv(position.cashflowBase + fillItemClose.cashflowBase, swapEvent.amountOut, swapEvent.amountIn)
    const realisedPnl_short = mulDiv(position.realisedPnl_short, swapEvent.amountOut, swapEvent.amountIn)
    const fees_short = mulDiv(position.fees_short + partialFillItemClose.fee_short, swapEvent.amountOut, swapEvent.amountIn)

    const newPosition = {
      ...position,
      instrument_id: createInstrumentId({ chainId, instrumentId: newContangoPositionId }),
      collateral: openingFillItem.collateralDelta,
      debt: openingFillItem.debtDelta,
      createdAtBlock: events[0].blockNumber,
      createdAtTimestamp: events[0].blockTimestamp,
      createdAtTransactionHash: events[0].transactionHash,
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
        ...events[0],
        position: newPosition,
        accountingType: AccountingType.Long,
        size: openingFillItem.collateralDelta,
        cost: openingFillItem.fillCost_long,
      }),
      initialiseLot({
        ...events[0],
        position: newPosition,
        accountingType: AccountingType.Short,
        size: openingFillItem.debtDelta,
        cost: openingFillItem.fillCost_short,
      }),
    ]

    await savePosition({ position: newPosition, lots: newLots, context })
}

export const handleMigrations = async ({ position, lots, debtToken, collateralToken, events, newContangoPositionId, context }: { context: handlerContext; newContangoPositionId: string; position: Position; lots: Lot[]; debtToken: Token; collateralToken: Token; events: ContangoEvents[] }) => {
  const { blockNumber, blockTimestamp: timestamp, chainId, transactionHash } = events[0]
  const { feeEvents, swapEvents } = organiseEvents(events)

  if (swapEvents.length > 0) return handleMigrateBase({ position, lots, debtToken, collateralToken, events, newContangoPositionId, context, chainId })

  const indexOfEndOfClose = events.findIndex(e => e.eventType === EventType.TRANSFER_NFT && e.contangoPositionId === newContangoPositionId)
  const idOfNewPosition = createIdForPosition({ chainId, positionId: newContangoPositionId })

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

  const transferEvents = events.filter((e): e is TransferEvent => e.eventType === EventType.TRANSFER)
  const migrationType = events.find((e): e is PositionMigratedEvent => e.eventType === EventType.MIGRATED)?.migrationType || MigrationType.NoSwap
  const oldPositionEvents = organiseEvents(events.slice(0, indexOfEndOfClose))
  const newPositionEvents = organiseEvents(events.slice(indexOfEndOfClose))

  if (migrationType === MigrationType.NoSwap) {
    const { prices, converters } = getPricesFromLots({ longLots: lots.filter(l => l.accountingType === AccountingType.Long), debtToken, collateralToken })
    const fees = withFees({ feeEvents, positionUpsertedEvents: [], converters, collateralToken, debtToken })
    const cashflows = withCashflows({ owner: position.owner, converters, chainId: position.chainId, debtToken, collateralToken, transferEvents, prices, fee_long: 0n, fee_short: 0n })
    const debtAndCollateral = calculateDebtAndCollateral({ ...oldPositionEvents, converters, position })
    const { lendingProfitToSettle, debtCostToSettle } = debtAndCollateral
    const debtAndCollateralNew = calculateDebtAndCollateral({ ...newPositionEvents, converters, position })

    const { longLots, shortLots } = await allocateInterestToLots({ lots, lendingProfitToSettle, debtCostToSettle })
    const newLots = [...longLots, ...shortLots].map((lot, idx) => ({ ...lot, position_id: idOfNewPosition, contangoPositionId: newContangoPositionId, id: createIdForLot({ chainId, positionId: newContangoPositionId, index: idx }) }))
    for (const lot of lots) {
      // delete references to old lots
      context.Lot.deleteUnsafe(lot.id)
    }

    const newPosition = {
      ...position,
      id: idOfNewPosition,
      contangoPositionId: newContangoPositionId,
      collateral: debtAndCollateralNew.collateralDelta,
      debt: debtAndCollateralNew.debtDelta,
      accruedLendingProfit: position.accruedLendingProfit + lendingProfitToSettle,
      accruedDebtCost: position.accruedDebtCost + debtCostToSettle,
      fees_long: position.fees_long + fees.fee_long,
      fees_short: position.fees_short + fees.fee_short,
      cashflowBase: position.cashflowBase + cashflows.cashflowBase,
      cashflowQuote: position.cashflowQuote + cashflows.cashflowQuote,
      realisedPnl_long: position.realisedPnl_long,
      realisedPnl_short: position.realisedPnl_short,
      longCost: position.longCost - debtCostToSettle,
      shortCost: position.shortCost + lendingProfitToSettle
    }
  
    const migrateLendingMarketFillItem: FillItem = {
      id: createFillItemId({ ...events[0], positionId: position.contangoPositionId}),
      blockNumber,
      timestamp,
      chainId,
      transactionHash,
      position_id: position.id,
      ...debtAndCollateral,
      collateralDelta: 0n,
      debtDelta: cashflows.cashflowQuote * -1n,
      ...fees,
      ...cashflows,
      ...prices,
      cashflow: 0n,
      cashflowBase: 0n,
      cashflowQuote: cashflows.cashflowQuote,
      cashflowSwap_id: undefined,
      cashflowToken_id: undefined,
      contangoPositionId: position.contangoPositionId,
      fillItemType: FillItemType.MigrateLendingMarket,
      fillPrice_long: 0n,
      fillPrice_short: 0n,
      fillCost_short: 0n,
      fillCost_long: 0n,
      liquidationPenalty: 0n,
      realisedPnl_long: 0n,
      realisedPnl_short: 0n,
    }

    saveFillItem(migrateLendingMarketFillItem, context)

    await savePosition({
      position: newPosition,
      lots: newLots,
      context
    })
  } else if (migrationType === MigrationType.SwapBase) {
    if (swapEvents.length === 0) throw new Error(`Swap event not found for migration type ${migrationType}`)

    const { collateralToken: newCollateralToken } = await getPairForPositionId({ chainId, positionId: newContangoPositionId, context })
    
    const { prices: pricesFromLots, converters } = getPricesFromLots({ longLots: lots.filter(l => l.accountingType === AccountingType.Long), debtToken, collateralToken: newCollateralToken })

    const fees = withFees({ feeEvents, positionUpsertedEvents: [], converters, collateralToken, debtToken })

    const prices = processSwapEvents(collateralToken, newCollateralToken, swapEvents)
    const quoteToBase = getQuoteToBaseFn({ price_long: prices.referencePrice_long, collateralToken: newCollateralToken }) // from old collateral token to new collateralToken
    const baseToQuote = getBaseToQuoteFn({ price_long: prices.referencePrice_long, collateralToken: newCollateralToken }) // from new collateral token to old collateralToken

    const newConverters = {
      quoteToBase: (amount: bigint) => {
        // go from quote to old base -> old base to new base
        return quoteToBase(converters.quoteToBase(amount))
      },
      baseToQuote: (amount: bigint) => {
        // go from new base to old base -> quote
        return baseToQuote(converters.baseToQuote(amount))
      }
    }
    
    const debtAndCollateral = calculateDebtAndCollateral({ ...oldPositionEvents, converters, position })
    const cashflows = withCashflows({ converters, owner: position.owner, chainId: position.chainId, debtToken, collateralToken, transferEvents, prices, ...fees })
    
    const debtAndCollateralNew = calculateDebtAndCollateral({ ...newPositionEvents, converters: newConverters, position })

    const cashflowBase = quoteToBase(position.cashflowBase)
    const realisedPnl_short = quoteToBase(position.realisedPnl_short)
    const fees_short = quoteToBase(position.fees_short + fees.fee_short)

  
    const migrationCloseFillItem: FillItem = {
      id: createFillItemId({ ...events[0], positionId: position.contangoPositionId}),
      blockNumber,
      timestamp,
      chainId,
      transactionHash,
      position_id: position.id,
      ...debtAndCollateral,
      ...fees,
      ...cashflows,
      ...prices,
      cashflow: 0n,
      cashflowBase: cashflows.cashflowBase, // + position.cashflowBase,
      cashflowQuote: cashflows.cashflowQuote, // + position.cashflowQuote,
      cashflowSwap_id: undefined,
      cashflowToken_id: undefined,
      contangoPositionId: position.contangoPositionId,
      fillItemType: FillItemType.MigrateBaseCurrencyClose,
      fillPrice_long: 0n,
      fillPrice_short: 0n,
      fillCost_short: 0n,
      fillCost_long: 0n,
      liquidationPenalty: 0n,
      realisedPnl_long: 0n,
      realisedPnl_short: 0n,
    }
  
    const migrationOpenFillItem: FillItem = {
      id: createFillItemId({ ...events[0], positionId: newContangoPositionId }),
      contangoPositionId: newContangoPositionId,
      timestamp,
      transactionHash,
      chainId,
      ...prices,
      ...debtAndCollateralNew,
      fillItemType: FillItemType.MigrateBaseCurrencyOpen,
      fillCost_short: 0n,
      fillCost_long: 0n,
      fillPrice_long: 0n,
      fillPrice_short: 0n,
      realisedPnl_long: 0n,
      realisedPnl_short: 0n,
      cashflowBase: 0n,
      cashflowQuote: 0n,
      cashflowSwap_id: undefined,
      fee_long: 0n,
      fee_short: 0n,
      fee: 0n,
      feeToken_id: undefined,
      liquidationPenalty: 0n,
      position_id: position.id,
      lendingProfitToSettle: 0n,
      debtCostToSettle: 0n,
      blockNumber,
      cashflow: 0n,
      cashflowToken_id: undefined,
    }

    saveFillItem(migrationCloseFillItem, context)
    saveFillItem(migrationOpenFillItem, context)

    const newPosition = {
      ...position,
      contangoPositionId: newContangoPositionId,
      instrument_id: createInstrumentId({ chainId, instrumentId: newContangoPositionId }),
      collateral: position.collateral + migrationOpenFillItem.collateralDelta,
      debt: position.debt + migrationOpenFillItem.debtDelta,
      createdAtBlock: events[0].blockNumber,
      createdAtTimestamp: events[0].blockTimestamp,
      createdAtTransactionHash: events[0].transactionHash,
      id: idOfNewPosition,
      accruedLendingProfit: 0n,
      accruedDebtCost: 0n,
      fees_long: position.fees_long + migrationCloseFillItem.fee_long,
      fees_short,
      cashflowBase,
      cashflowQuote: position.cashflowQuote,
      realisedPnl_short,
    }

    console.log({ newPosition, migrationCloseFillItem, migrationOpenFillItem })

    const newLots = [
      initialiseLot({
        ...swapEvents[0],
        position: newPosition,
        accountingType: AccountingType.Long,
        size: migrationOpenFillItem.collateralDelta,
        cost: migrationOpenFillItem.fillCost_long,
      }),
      initialiseLot({
        ...swapEvents[0],
        position: newPosition,
        accountingType: AccountingType.Short,
        size: migrationOpenFillItem.debtDelta,
        cost: migrationOpenFillItem.fillCost_short,
      }),
    ]

    await savePosition({
      position: newPosition,
      lots: newLots,
      context
    })
  }
}

