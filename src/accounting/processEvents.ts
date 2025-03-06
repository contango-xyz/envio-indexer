import { FillItem, handlerContext, Lot, Position, Token } from "generated";
import { Mutable } from "viem";
import { eventStore, PositionSnapshot } from "../Store";
import { getPairForPositionId, getPosition } from "../utils/common";
import { createFillItemId } from "../utils/ids";
import { ContangoEvents, EventType, FillItemType, MigrationType, PositionMigratedEvent, TransferEvent } from "../utils/types";
import { eventsToPartialFillItem, organiseEvents, saveAll } from "./helpers";
import { AccountingType, allocateFundingCostToLots, allocateFundingProfitToLots, allocateInterestToLots, handleCloseSize, initialiseLot, updateLots } from "./lotsAccounting";
import { calculateNetCashflows, withCashflows } from "./helpers/cashflows";
import { calculateFillPrice, getPricesFromLots, ReferencePriceSource } from "./helpers/prices";
import { withFees } from "./helpers/fees";
import { calculateDebtAndCollateral } from "./helpers/debtAndCollateral";
import { handleMigrations } from "./helpers/migrations";

export const processEvents = async (
  {
    events,
    position: positionSnapshot,
    lots: lotsSnapshot,
    debtToken,
    collateralToken,
  }: {
    events: ContangoEvents[]
    position: Position
    lots: Lot[]
    debtToken: Token
    collateralToken: Token
  }
) => {
  const { blockNumber, blockTimestamp: timestamp, chainId, transactionHash } = events[0]

  // create the basic (partial) fillItem
  const { cashflowSwap, ...partialFillItem } = await eventsToPartialFillItem({ position: positionSnapshot, debtToken, collateralToken, events })
  const { lendingProfitToSettle, debtCostToSettle, debtDelta, collateralDelta, fillCost_short, fillCost_long } = partialFillItem

  const { longLots, shortLots, realisedPnl_long, realisedPnl_short } = await updateLots({
    lots: lotsSnapshot,
    collateralDelta,
    debtDelta,
    lendingProfitToSettle,
    debtCostToSettle,
    position: positionSnapshot,
    fillCost_short,
    fillCost_long,
    event: events[0]
  })

  const fillItem: FillItem = {
    id: createFillItemId({ ...events[0], positionId: positionSnapshot.contangoPositionId }),
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
  return { position: newPosition, fillItem, lots: [...longLots, ...shortLots] }
}

export const eventsReducer = async ({ context, position, lots, collateralToken, debtToken, storeKey }: PositionSnapshot & { context: handlerContext }) => {

  try {
    const events = eventStore.getContangoEvents(storeKey)
    if (events.length === 0) throw new Error(`Attempted to call eventsReducer with no events in store`)

    // ideally we'd just look for the PositionMigrated event, but the initial implementation of migrations didn't emit that event so this is more robust
    const positionIds = events.reduce((acc, event) => event.eventType === EventType.POSITION_UPSERTED ? acc.add(event.contangoPositionId) : acc, new Set<string>())

    if (positionIds.size > 1) {
      const [oldContangoPositionId, newContangoPositionId] = Array.from(positionIds)
      await handleMigrations({ context, position, lots, debtToken, collateralToken, events, newContangoPositionId })
      return
    }

    const result = await processEvents({ events, position, lots, debtToken, collateralToken })

    saveAll({ ...result, context })
  } catch (e) {
    console.error('error processing events', e)
    throw e
  }
}
