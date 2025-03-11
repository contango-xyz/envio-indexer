import { FillItem, handlerContext, Lot, Position, Token } from "generated";
import { createFillItemId } from "../utils/ids";
import { eventsToPartialFillItem } from "./helpers";
import { OrganisedEvents } from "./helpers/eventStore";
import { saveFillItem, savePosition, updateTvl } from "./helpers/saveAndLoad";
import { updateLots } from "./lotsAccounting";

export const processEventsForPosition = async (
  {
    organisedEvents,
    position: positionSnapshot,
    lots: lotsSnapshot,
    debtToken,
    collateralToken,
  }: {
    organisedEvents: OrganisedEvents
    position: Position
    lots: Lot[]
    debtToken: Token
    collateralToken: Token
  }
) => {
  const genericEvent = organisedEvents.allEvents[0]
  const { blockNumber, blockTimestamp: timestamp, chainId, transactionHash } = genericEvent

  // create the basic (partial) fillItem
  const { cashflowSwap, ...partialFillItem } = await eventsToPartialFillItem({ position: positionSnapshot, debtToken, collateralToken, organisedEvents })
  const { lendingProfitToSettle, debtCostToSettle, debtDelta, collateralDelta, fillCost_short, fillCost_long } = partialFillItem

  const { longLots, shortLots, realisedPnl_long, realisedPnl_short, before, after } = await updateLots({
    lots: lotsSnapshot,
    collateralDelta,
    debtDelta,
    lendingProfitToSettle,
    debtCostToSettle,
    position: positionSnapshot,
    fillCost_short,
    fillCost_long,
    event: genericEvent
  })

  const fillItem: FillItem = {
    ...partialFillItem,
    id: createFillItemId({ ...genericEvent, positionId: positionSnapshot.contangoPositionId }),
    timestamp,
    chainId,
    blockNumber,
    transactionHash,
    contangoPositionId: positionSnapshot.contangoPositionId,
    grossCollateralBefore: before.grossCollateral,
    grossCollateralAfter: after.grossCollateral,
    netCollateralBefore: before.netCollateral,
    netCollateralAfter: after.netCollateral,
    grossDebtBefore: before.grossDebt,
    grossDebtAfter: after.grossDebt,
    netDebtBefore: before.netDebt,
    netDebtAfter: after.netDebt,
    collateralDelta: after.netCollateral - before.netCollateral,
    debtDelta: after.netDebt - before.netDebt,
    position_id: positionSnapshot.id,
    realisedPnl_long,
    realisedPnl_short,
    cashflowSwap_id: cashflowSwap?.id,
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
    grossCollateral: after.grossCollateral,
    netCollateral: after.netCollateral,
    grossDebt: after.grossDebt,
    netDebt: after.netDebt,
    longCost: longLots.reduce((acc, curr) => acc + curr.openCost, 0n),
    shortCost: shortLots.reduce((acc, curr) => acc + curr.openCost, 0n),
  }

  const result = { position: newPosition, fillItem, lots: [...longLots, ...shortLots] }
  const saveResult = (context: handlerContext) => {
    saveFillItem(fillItem, context)
    savePosition({ ...result, context })
    updateTvl({ position: newPosition, quoteToken: collateralToken, newCashflowQuote: newPosition.cashflowQuote, oldCashflowQuote: positionSnapshot.cashflowQuote, context })
  }

  // return the new position, fillItem, and lots
  return { result, saveResult }
}

