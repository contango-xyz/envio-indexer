import { FillItem, Lot, Position, Token, handlerContext } from "generated";
import { getLiquidationPenalty } from "../Liquidations/common";
import { createIdForLot } from "../utils/ids";
import { CollateralEvent, ContangoEvents, DebtEvent, EventType, FeeCollectedEvent, FillItemType, LiquidationEvent, MigrationType, PositionUpsertedEvent, SwapEvent, TransferEvent } from "../utils/types";
import { withCashflows } from "./helpers/cashflows";
import { calculateDebtAndCollateral } from "./helpers/debtAndCollateral";
import { withFees } from "./helpers/fees";
import { ReferencePriceSource, calculateFillPrice, getPrices } from "./helpers/prices";

export const organiseEvents = (events: ContangoEvents[]) => {
  return events.reduce((acc, event) => {
    if (event.eventType === EventType.FEE_COLLECTED) acc.feeEvents.push(event)
    if (event.eventType === EventType.POSITION_UPSERTED) acc.positionUpsertedEvents.push(event)
    if (event.eventType === EventType.SWAP_EXECUTED) acc.swapEvents.push(event)
    if (event.eventType === EventType.DEBT) acc.debtEvents.push(event)
    if (event.eventType === EventType.COLLATERAL) acc.collateralEvents.push(event)
    if (event.eventType === EventType.LIQUIDATION) acc.liquidationEvents.push(event)
    if (event.eventType === EventType.TRANSFER) acc.transferEvents.push(event)
    if (event.eventType === EventType.MIGRATED) acc.migrationType = event.migrationType
    return acc
  }, { migrationType: null as MigrationType | null, transferEvents: [] as TransferEvent[], feeEvents: [] as FeeCollectedEvent[], positionUpsertedEvents: [] as PositionUpsertedEvent[], swapEvents: [] as SwapEvent[], debtEvents: [] as DebtEvent[], collateralEvents: [] as CollateralEvent[], liquidationEvents: [] as LiquidationEvent[] })
}

export type OrganisedEvents = Awaited<ReturnType<typeof organiseEvents>>

export const eventsToPartialFillItem = async ({ position, debtToken, collateralToken, events }: { position: Position; debtToken: Token; collateralToken: Token; events: ContangoEvents[]; }) => {
  const organisedEvents = organiseEvents(events)
  const { transferEvents, feeEvents, positionUpsertedEvents } = organisedEvents
  
  const { prices, converters } = await getPrices({ position, debtToken, collateralToken, organisedEvents})
  const debtAndCollateral = calculateDebtAndCollateral({ ...organisedEvents, converters, position })

  const { collateralDelta, debtDelta } = debtAndCollateral
  const fees = withFees({ converters, feeEvents, positionUpsertedEvents, collateralToken, debtToken })
  const cashflows = withCashflows({ converters, owner: position.owner, chainId: position.chainId, debtToken, collateralToken, transferEvents, prices: prices, fee_long: fees.fee_long, fee_short: fees.fee_short })
  
  const liquidationPenalty = debtAndCollateral.fillItemType === FillItemType.Liquidated ? getLiquidationPenalty({ collateralToken, collateralDelta, debtDelta, referencePrice: prices.referencePrice_long }) : 0n

  const fillCost_short = collateralDelta - cashflows.cashflowBase
  const fillCost_long = -(debtDelta + cashflows.cashflowQuote)

  const fillPrice_long = calculateFillPrice({ fillCost: fillCost_long, unit: collateralToken.unit, delta: collateralDelta })
  const fillPrice_short = calculateFillPrice({ fillCost: fillCost_short, unit: debtToken.unit, delta: debtDelta })

  if (prices.referencePriceSource === ReferencePriceSource.None) {
    if (fillCost_short !== 0n && fillCost_long !== 0n && cashflows.cashflow === 0n) {
      prices.referencePrice_long = fillPrice_long
      prices.referencePrice_short = fillPrice_short
      prices.referencePriceSource = ReferencePriceSource.FillPrice
    }
  }

  return { ...debtAndCollateral, ...fees, ...cashflows, ...prices, fillCost_short, fillCost_long, fillPrice_long, fillPrice_short, liquidationPenalty }
}

export type PartialFillItem = Awaited<ReturnType<typeof eventsToPartialFillItem>>

// ----- save stuff -----

export const saveLots = async ({ lots, context }: { lots: Lot[]; context: handlerContext }) => {
  // Save all lots in parallel
  const openLots = lots.filter((lot) => lot.openCost && lot.size).map((lot, idx) => ({ ...lot, id: createIdForLot({ chainId: lot.chainId, positionId: lot.contangoPositionId, index: idx }) }))
  const openIds = new Set<Lot['id']>(openLots.map(lot => lot.id))

  for (const lot of lots) {
    if (!openIds.has(lot.id) && lot.id !== 'unknown') {
      context.Lot.deleteUnsafe(lot.id)
    }
  }

  await Promise.all(openLots.map((lot) => context.Lot.set(lot)))

  return openLots
}

export const saveFillItem = (fillItem: FillItem, context: handlerContext) => {
  if (fillItem.referencePriceSource === ReferencePriceSource.None && fillItem.cashflow !== 0n) {
    throw new Error(`Fill item has no reference price source: ${fillItem.transactionHash} chainId: ${fillItem.chainId}`)
  }
  context.FillItem.set(fillItem)
}

export const savePosition = async ({ position, lots, context }: { position: Position; lots: Lot[]; context: handlerContext }) => {
  const savedLots = await saveLots({ lots, context })
  context.Position.set({ ...position, lotCount: savedLots.length })
}

export const saveAll = async ({ position, lots, context, fillItem }: { fillItem: FillItem; position: Position; lots: Lot[]; context: handlerContext }) => {
  const savedLots = await saveLots({ lots, context })
  context.Position.set({ ...position, lotCount: savedLots.length })
  saveFillItem(fillItem, context)
}
