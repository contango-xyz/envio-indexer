import { FillItem, Lot, Position, Token, handlerContext } from "generated/src/Types.gen";
import { createInstrumentId } from "../../utils/common";
import { createFillItemId, createIdForLot, createIdForPosition } from "../../utils/ids";
import { mulDiv } from "../../utils/math-helpers";
import { EventType, FillItemType, MigrationType, Mutable } from "../../utils/types";
import { eventsToPartialFillItem } from "../helpers";
import { AccountingType, allocateInterestToLots, initialiseLot } from "../lotsAccounting";
import { withCashflows } from "./cashflows";
import { calculateDebtAndCollateral } from "./debtAndCollateral";
import { OrganisedEvents, organiseEvents } from "./eventStore";
import { withFees } from "./fees";
import { calculateFillPrice, getPricesFromLots } from "./prices";
import { saveFillItem, savePosition } from "./saveAndLoad";

const handleMigrateBase = async ({ position, debtToken, collateralToken, organisedEvents, newContangoPositionId }: { newContangoPositionId: string; position: Position; debtToken: Token; collateralToken: Token; organisedEvents: OrganisedEvents }) => {
  const idOfNewPosition = createIdForPosition({ chainId: position.chainId, contangoPositionId: newContangoPositionId })
  const oldContangoPositionId = position.contangoPositionId

  const oldPosition: Position = {
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
    longCost: 0n,
    shortCost: 0n,
    migratedTo_id: idOfNewPosition,
  }

  const { allEvents, swapEvents } = organisedEvents
  const swapEvent = swapEvents[0]

  const getEventsForPositionId = (positionId: string) => {
    const eventsForPosition = allEvents.filter(e => {
      if (e.eventType === EventType.COLLATERAL && e.contangoPositionId === positionId) return true
      if (e.eventType === EventType.DEBT && e.contangoPositionId === positionId) return true
      if (e.eventType === EventType.FEE_COLLECTED && e.contangoPositionId === positionId) return true
      if (e.eventType === EventType.LIQUIDATION && e.contangoPositionId === positionId) return true
      if (e.eventType === EventType.POSITION_UPSERTED && e.contangoPositionId === positionId) return true
      return false
    })
    return organiseEvents(eventsForPosition)
  }

  const fillCost_long = position.longCost * -1n
  const fillCost_short = position.shortCost * -1n

  const partialFillItemClose = await eventsToPartialFillItem({ position, debtToken, collateralToken, organisedEvents: getEventsForPositionId(oldContangoPositionId) })
  
  const fillItemClose: Mutable<FillItem> = {
    ...partialFillItemClose,
    cashflow: 0n,
    cashflowToken_id: debtToken.id,
    id: createFillItemId({ ...swapEvent, positionId: oldContangoPositionId }),
    timestamp: swapEvent.blockTimestamp,
    chainId: swapEvent.chainId,
    blockNumber: swapEvent.blockNumber,
    transactionHash: swapEvent.transactionHash,
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

  const openingFillItem: FillItem = {
    ...(await eventsToPartialFillItem({ position, debtToken, collateralToken, organisedEvents: getEventsForPositionId(newContangoPositionId) })),
    id: createFillItemId({ ...swapEvent, positionId: newContangoPositionId }),
    cashflowToken_id: debtToken.id,
    cashflow: 0n,
    timestamp: swapEvent.blockTimestamp,
    chainId: swapEvent.chainId,
    blockNumber: swapEvent.blockNumber,
    transactionHash: swapEvent.transactionHash,
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

  const cashflowBase = mulDiv(position.cashflowBase + fillItemClose.cashflowBase, swapEvent.amountOut, swapEvent.amountIn)
  const realisedPnl_short = mulDiv(position.realisedPnl_short, swapEvent.amountOut, swapEvent.amountIn)
  const fees_short = mulDiv(position.fees_short + partialFillItemClose.fee_short, swapEvent.amountOut, swapEvent.amountIn)

  const newPosition = {
    ...position,
    instrument_id: createInstrumentId({ chainId: swapEvent.chainId, instrumentId: newContangoPositionId }),
    collateral: openingFillItem.collateralDelta,
    debt: openingFillItem.debtDelta,
    createdAtBlock: swapEvent.blockNumber,
    createdAtTimestamp: swapEvent.blockTimestamp,
    createdAtTransactionHash: swapEvent.transactionHash,
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
      ...swapEvent,
      position: newPosition,
      accountingType: AccountingType.Long,
      size: openingFillItem.collateralDelta,
      cost: openingFillItem.fillCost_long,
    }),
    initialiseLot({
      ...swapEvent,
      position: newPosition,
      accountingType: AccountingType.Short,
      size: -openingFillItem.debtDelta,
      cost: openingFillItem.fillCost_short,
    }),
  ]

  const saveResult = (context: handlerContext) => {
    saveFillItem(fillItemClose, context)
    savePosition({ position: oldPosition, lots: [], context })

    saveFillItem(openingFillItem, context)
    savePosition({ position: newPosition, lots: newLots, context })
  }

  // return the values + a save function
  return { oldPosition, newPosition, lots: newLots, saveResult }
}

const handleMigrateLendingMarket = async ({ position, lots, debtToken, collateralToken, organisedEvents, newContangoPositionId }: { newContangoPositionId: string; position: Position; lots: Lot[]; debtToken: Token; collateralToken: Token; organisedEvents: OrganisedEvents }) => {
  const { feeEvents, transferEvents, allEvents } = organisedEvents
  const genericEvent = allEvents[0]
  const { blockNumber, blockTimestamp: timestamp, chainId, transactionHash } = genericEvent

  const indexOfEndOfClose = allEvents.findIndex(e => e.eventType === EventType.TRANSFER_NFT && e.contangoPositionId === newContangoPositionId)
  const idOfNewPosition = createIdForPosition({ chainId, contangoPositionId: newContangoPositionId })

  const oldPosition: Position = {
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
    longCost: 0n,
    shortCost: 0n,
    migratedTo_id: idOfNewPosition,
  }

  const oldPositionEvents = organiseEvents(allEvents.slice(0, indexOfEndOfClose))
  const newPositionEvents = organiseEvents(allEvents.slice(indexOfEndOfClose))

  const { prices, converters } = getPricesFromLots({ longLots: lots.filter(l => l.accountingType === AccountingType.Long), debtToken, collateralToken })
  const fees = withFees({ feeEvents, positionUpsertedEvents: [], converters, collateralToken, debtToken })
  const cashflows = withCashflows({ owner: position.owner, converters, chainId: position.chainId, debtToken, collateralToken, transferEvents, prices, fee_long: 0n, fee_short: 0n, liquidationEvents: [] })
  const debtAndCollateral = calculateDebtAndCollateral({ ...oldPositionEvents, converters, position })
  const { lendingProfitToSettle, debtCostToSettle } = debtAndCollateral
  const debtAndCollateralNew = calculateDebtAndCollateral({ ...newPositionEvents, converters, position })

  const { longLots, shortLots } = await allocateInterestToLots({ lots, lendingProfitToSettle, debtCostToSettle })
  const newLots = [...longLots, ...shortLots].map((lot, idx) => ({ ...lot, position_id: idOfNewPosition, contangoPositionId: newContangoPositionId, id: createIdForLot({ chainId, positionId: newContangoPositionId, index: idx }) }))

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
    id: createFillItemId({ ...genericEvent, positionId: position.contangoPositionId}),
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

  const saveResult = (context: handlerContext) => {
    saveFillItem(migrateLendingMarketFillItem, context)
    savePosition({ position: oldPosition, lots: [], context })
    savePosition({ position: newPosition, lots: newLots, context })
  }

  return { oldPosition, newPosition, lots: newLots, saveResult }

}

export const handleMigrations = async ({ position, lots, debtToken, collateralToken, organisedEvents, newContangoPositionId }: { newContangoPositionId: string; position: Position; lots: Lot[]; debtToken: Token; collateralToken: Token; organisedEvents: OrganisedEvents }) => {
  const { swapEvents } = organisedEvents

  const migrationType = (() => {
    if (swapEvents.length === 0) return MigrationType.MigrateLendingMarket
    if (swapEvents.length === 1 && swapEvents[0].tokenIn_id === collateralToken.id) return MigrationType.MigrateBaseCurrency
    if (swapEvents.length === 1 && swapEvents[0].tokenIn_id === debtToken.id) return MigrationType.MigrateQuoteCurrency
    throw new Error(`Unknown migration type for position ${position.id}. There should be at most 1 swap event. Actual swap events count: ${swapEvents.length}`)
  })()

  switch (migrationType) {
    case MigrationType.MigrateBaseCurrency:
      return handleMigrateBase({ position, debtToken, collateralToken, organisedEvents, newContangoPositionId })
    case MigrationType.MigrateLendingMarket:
      return handleMigrateLendingMarket({ position, lots, debtToken, collateralToken, organisedEvents, newContangoPositionId })
    case MigrationType.MigrateQuoteCurrency:
      throw new Error(`Migrate quote currency not implemented`)
    default:
      throw new Error(`Unknown migration type: ${migrationType}`)
  }
}

